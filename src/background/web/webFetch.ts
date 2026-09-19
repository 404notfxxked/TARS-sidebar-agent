// web_fetch 工具执行体(service worker 侧):抓取 + 编排。
// 与 web_search 同一套分工:网络抓取在 SW(host_permissions 覆盖,含内网
// http 页面),HTML 解析与缓存在 offscreen(fetch_read / fetch_build 协议,
// 见 offscreen/fetchDoc.ts)。
// 出站判定(2026-09 评审 S1,见 web/outboundGuard.ts + fetchAllowlist.ts):
// 私网/内网目标、或会话来源域白名单(用户消息 URL / 搜索结果 / 已成功抓取)
// 未命中的链接,先经面板确认再抓 —— 读取内网仍是设计内能力,但属「用户该
// 知情放行」的出口;白名单命中直抓,任意新域首次抓取确认一次。
// 重定向复核:确认门只判入口 URL,而 fetch 默认跟随重定向 —— 落点换 host
// 时在 fetchHtml 内重跑私网判定(私网落点拦截、公开落点放行但不回填最终
// URL,白名单不学习重定向带来的新域)。
// ⚠️ 已知边界:SW fetch 的 redirect:"manual" 只给 opaqueredirect(读不到
// Location),逐跳复核在平台上不可行,跟随模式下可见的只有**最终**落点 ——
// 多跳重定向中间的私网跳会真实发出(响应被丢弃),这不是可机械拦截的防线,
// 只是「最终落点」的知情底线。开放重定向 → 内网 GET 的残余风险由确认门
// 的入口白名单与用户知情兜着。
//
// 流程:先试 fetch_read(缓存命中 = 一次往返直达);offscreen 报 NOT_CACHED
// 才走「抓取 → 入库 → 再读」。1.2.0 起只读工具批内并行(web_fetch 同批并发
// 可达),build 与 read 之间不再有「串行 ⇒ 无并发淘汰」的保证:LRU 容量
// 6 份,同批超过 6 个 fetch_build 才可能互踢出 NOT_CACHED,一旦出现按异常
// 状态报错(见下),属可接受的小概率边界。
// 取消:用户中止 run 时,在途抓取立即中断(offscreen 侧的解析为本地纯计算,
// 不受影响,结果会被丢弃)。

import { callOffscreenParser, ensureOffscreenDocument } from "../../shared/docBridge";
import { hasOriginAccess } from "../../shared/hostAccess";
import { abortWithTimeout, getToolExecutionContext } from "../tools/toolContext";
import { createLogger } from "../../shared/logger";
import { reviewRedirectTarget, hostKey } from "./outboundGuard";

const log = createLogger({ ctx: "bg" });

/** 单次抓取超时 */
const FETCH_TIMEOUT_MS = 20_000;
/** 单页 HTML 上限(字节):超过直接拒,防异常大页拖垮解析 */
const MAX_HTML_BYTES = 2_000_000;

/** offscreen fetchRead 对「缓存里没有这个 URL」的稳定错误前缀(协议约定) */
const NOT_CACHED_PREFIX = "NOT_CACHED:";

export interface WebFetchArgs {
  url?: unknown;
  offset?: unknown;
  chars?: unknown;
  refresh?: unknown;
}

export interface WebFetchResult {
  title?: string;
  url?: string;
  offset?: number;
  end?: number;
  total_chars?: number;
  next_offset?: number | null;
  done?: boolean;
  truncated_total?: boolean;
  headings?: { level: number; title: string }[];
  text?: string;
}

export async function runWebFetch(args: WebFetchArgs): Promise<WebFetchResult> {
  const url = typeof args?.url === "string" ? args.url.trim() : "";
  if (!url) {
    throw new Error("web_fetch: url 不能为空,请给出要读取的网页链接");
  }
  // offscreen 的存活由本工具自理:搜索 API 化之后没有别人顺手唤起它了
  // (此前一直依赖 web_search 抓 HTML 前的 ensure 调用)
  await ensureOffscreenDocument();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`web_fetch: 无法解析的 URL:${url}`);
  }
  // 只挡协议,不拦私网/内网地址:读取内网系统页面是本工具的设计内能力
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `web_fetch: 只支持 http/https 链接,收到 ${parsed.protocol}(浏览器内部页无法由 TARS 代读)`,
    );
  }
  // 抓取由 SW fetch 直连,依赖目标站点的 host 授权(否则 CORS 拦截);
  // 未授权时快速失败并给出授权指引,不烧 20s 抓取超时
  if (!(await hasOriginAccess(url))) {
    throw new Error(
      `web_fetch 需要访问 ${parsed.origin} 的授权。请让用户在 TARS 设置 → 安全 中开启「页面与网络访问」,授权后重试`,
    );
  }
  const readArgs = { url, offset: args?.offset, chars: args?.chars };

  // 缓存命中 → 一次往返直达;NOT_CACHED(未缓存/显式刷新)→ 走抓取路径
  if (args?.refresh !== true) {
    try {
      return (await callOffscreenParser("fetch_read", readArgs, 15_000)) as WebFetchResult;
    } catch (e) {
      if (!(e instanceof Error) || !e.message.startsWith(NOT_CACHED_PREFIX)) throw e;
      log.debug("webfetch", `缓存未命中,开始抓取`, { url });
    }
  }

  const { html, finalUrl } = await fetchHtml(url);
  await callOffscreenParser("fetch_build", { url, html, base: finalUrl }, 20_000);
  try {
    return (await callOffscreenParser("fetch_read", readArgs, 15_000)) as WebFetchResult;
  } catch (e) {
    // 刚 build 完就读不到缓存属于异常状态(正常不会发生),给模型可读的提示
    if (e instanceof Error && e.message.startsWith(NOT_CACHED_PREFIX)) {
      throw new Error(`Page cache error, retry once: ${url}`);
    }
    throw e;
  }
}

async function fetchHtml(url: string): Promise<{ html: string; finalUrl: string }> {
  const cancelSignal = getToolExecutionContext()?.signal;
  const { signal, cleanup } = abortWithTimeout(FETCH_TIMEOUT_MS, cancelSignal);
  try {
    let res: Response;
    try {
      res = await fetch(url, { signal });
    } catch (e) {
      if (cancelSignal?.aborted) throw new Error("Page read cancelled by the user");
      const msg = e instanceof Error ? e.message : String(e);
      if (/timeout/i.test(msg)) {
        throw new Error(`Page fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s: ${url}`);
      }
      throw new Error(`Page fetch failed: ${msg} (${url})`);
    }
    if (!res.ok) {
      throw new Error(`Page returned HTTP ${res.status} (the link may be dead or require login)`);
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (!/text\/html|text\/plain|application\/xhtml\+xml/i.test(contentType)) {
      throw new Error(
        `不支持的网页类型(${contentType.split(";")[0] || "未知 Content-Type"}):` +
          "只能读取网页文本,PDF/图片/下载文件等请直接打开链接",
      );
    }
    // 重定向复核:响应头已到手、正文一个字节未读 —— 落点换 host 就重跑
    // 私网判定(私网落点抛错,公开落点放行但不回填最终 URL),并留一条
    // 只含 host 的日志(不带完整 URL,查询串可能是模型编码的外泄负载)
    const finalUrl = reviewRedirectTarget(url, res.url || url);
    if (finalUrl !== (res.url || url)) {
      log.info("webfetch", "redirect host changed", {
        from: hostKey(new URL(url).hostname),
        to: hostKey(new URL(res.url).hostname),
      });
    }
    const buf = await (async () => {
      // 下载阶段(响应头之后)的错误单独包装:中止/超时给可读文案,
      // 不让裸 Chrome 错误直穿;Content-Length 超限时先拒,不吃满下载
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_HTML_BYTES) {
        throw new Error(`Page too large (~${Math.round(declared / 1024)} KB, limit 2 MB)`);
      }
      try {
        return await res.arrayBuffer();
      } catch (e) {
        if (cancelSignal?.aborted) throw new Error("Page read cancelled by the user");
        const msg = e instanceof Error ? e.message : String(e);
        if (/timeout/i.test(msg)) {
          throw new Error(`Page fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s: ${url}`);
        }
        throw new Error(`Page download failed: ${msg} (${url})`);
      }
    })();
    if (buf.byteLength > MAX_HTML_BYTES) {
      throw new Error(`Page too large (~${Math.round(buf.byteLength / 1024)} KB, limit 2 MB)`);
    }
    return { html: decodeBody(buf, contentType), finalUrl };
  } finally {
    cleanup();
  }
}

/**
 * 字符集解码:Content-Type 声明优先,否则嗅探文档头部的 <meta charset>。
 * fetch 的 res.text() 只会按 UTF-8 解,内网老站常见 GBK 会变乱码,这里补上。
 * 嗅探窗口取 64KB:规范建议 meta charset 落在前 1KB,但长注释/前置内联脚本
 * 常把它推后,2KB 窗口对真实页面太紧(漏嗅探 = 整页乱码进模型)
 */
function decodeBody(buf: ArrayBuffer, contentType: string): string {
  let charset = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1];
  if (!charset) {
    const head = new TextDecoder("utf-8").decode(buf.slice(0, 65_536));
    charset = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1];
  }
  if (charset) {
    try {
      return new TextDecoder(charset.toLowerCase()).decode(buf);
    } catch {
      /* 未知编码标签,回退 UTF-8 */
    }
  }
  return new TextDecoder("utf-8").decode(buf);
}
