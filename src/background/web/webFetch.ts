// web_fetch 工具执行体(service worker 侧):抓取 + 编排。
// 与 web_search 同一套分工:网络抓取在 SW(host_permissions 覆盖,含内网
// http 页面;不做私网地址拦截,读取内网系统是设计内能力),HTML 解析与
// 缓存在 offscreen(fetch_read / fetch_build 协议,见 offscreen/fetchDoc.ts)。
//
// 流程:先试 fetch_read(缓存命中 = 一次往返直达);offscreen 报 NOT_CACHED
// 才走「抓取 → 入库 → 再读」。工具在 agent 循环里串行执行,build 与 read
// 之间没有并发淘汰,NOT_CACHED 只出现在真正未缓存时。
// 取消:用户中止 run 时,在途抓取立即中断(offscreen 侧的解析为本地纯计算,
// 不受影响,结果会被丢弃)。

import { callOffscreenParser, ensureOffscreenDocument } from "../../shared/docBridge";
import { abortWithTimeout, getToolExecutionContext } from "../tools/toolContext";
import { createLogger } from "../../shared/logger";

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
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_HTML_BYTES) {
      throw new Error(`Page too large (~${Math.round(buf.byteLength / 1024)} KB, limit 2 MB)`);
    }
    return { html: decodeBody(buf, contentType), finalUrl: res.url || url };
  } finally {
    cleanup();
  }
}

/**
 * 字符集解码:Content-Type 声明优先,否则嗅探前 2KB 的 <meta charset>。
 * fetch 的 res.text() 只会按 UTF-8 解,内网老站常见 GBK 会变乱码,这里补上。
 */
function decodeBody(buf: ArrayBuffer, contentType: string): string {
  let charset = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1];
  if (!charset) {
    const head = new TextDecoder("utf-8").decode(buf.slice(0, 2048));
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
