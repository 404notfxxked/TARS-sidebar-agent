// web_fetch_image 工具执行体(service worker 侧):网图下载入库。结构仿
// webFetch.ts —— 出站判定走同一条确认门谓词路径(confirmations.ts 的
// needsConfirmation 分支,私网/白名单未命中先过卡),重定向复核同款
// (reviewRedirectTarget:落点换 host 且为私网时在读正文前拦截)。
// 与 web_fetch 的分工:本工具的产物是图片字节而非文本 —— 校验链为
// 协议 → 站点授权 → content-type 必须 image/* → Content-Length 预检与
// 落地复检(上限 4MB)→ createImageBitmap 解码验真(SW 是 worker 环境,
// 该 API 可用;解码抛错 = 不是有效图片,拒绝)→ sessionDb.putImage 落库。
// 解码取 w/h 后立刻 close();选主路径(必须解码成功)而非「不解码记 0」
// 降级:入库前就验真,坏图不占库位,渲染端无需容忍 0 尺寸。
// 引用契约:成功回执 = 一行 JSON(stored/id/mime/w/h/source)+ 一行指引
// (tars-img: 语法),模型据此在回答里内嵌 ![alt](tars-img:<id>)(渲染在
// 面板侧,见 chat/bubbles.tsx 的引用处理)。
// 隐私红线:诊断日志只记 host(hostKey 归一)与字节数,不记完整 URL、
// 不记图片字节(判据:导出诊断时是否带走超出功能必需的原文)。

import { errText } from "../../shared/errors";
import { hasOriginAccess } from "../../shared/hostAccess";
import {
  abortWithTimeout,
  getToolExecutionContext,
} from "../tools/toolContext";
import { putImage } from "../sessions/sessionDb";
import { createLogger } from "../../shared/logger";
import { hostKey, reviewRedirectTarget } from "./outboundGuard";

const log = createLogger({ ctx: "bg" });

/** 单次抓取超时(与 web_fetch 同款) */
const FETCH_TIMEOUT_MS = 20_000;
/** 单张图片上限(字节):Content-Length 预检与落地复检共用,超过直接拒 */
const MAX_IMAGE_BYTES = 4_000_000;

export interface WebFetchImageArgs {
  url?: unknown;
}

/**
 * 参数校验(纯函数):url 必须是非空字符串、可解析、http/https。
 * 校验拆出网络与 IDB 之外,供单测钉契约(fetchImage.test.ts);
 * 返回 trim 后的 URL,非法即抛可行动错误
 */
export function parseImageUrl(args: unknown): string {
  const url = (args as WebFetchImageArgs | null)?.url;
  if (typeof url !== "string" || !url.trim()) {
    throw new Error("web_fetch_image: url 不能为空,请给出要抓取的图片链接");
  }
  const trimmed = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`web_fetch_image: 无法解析的 URL:${trimmed.slice(0, 120)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `web_fetch_image: 只支持 http/https 链接,收到 ${parsed.protocol}(浏览器内部页与内嵌数据无法由 TARS 抓取)`,
    );
  }
  return trimmed;
}

/**
 * content-type 校验(纯函数):必须是 image/*,取不到 content-type 也拒
 * (不猜扩展名不嗅探字节 —— 错标的 HTML 进不了图片库);返回去参小写 mime
 */
export function assertImageContentType(contentType: string | null): string {
  const mime = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!mime.startsWith("image/")) {
    throw new Error(
      `web_fetch_image: 只支持图片资源(content-type ${mime || "缺失"}),网页文本请用 web_fetch 读取`,
    );
  }
  return mime;
}

/** 大小校验(纯函数):上限 4MB,非有限数值一并拒 */
export function assertImageBytes(n: number): void {
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`web_fetch_image: 图片大小无效(${n})`);
  }
  if (n > MAX_IMAGE_BYTES) {
    throw new Error(
      `Image too large (~${Math.round(n / 1024)} KB, limit 4 MB)`,
    );
  }
}

/** 成功回执(纯函数):一行 JSON 契约 + 一行 tars-img 引用指引,模型照此
 *  在回答里内嵌图片。JSON 在首行、指引在尾随行 —— 分行是给工具结果消费方
 *  (白名单推导只认整段可 JSON.parse 的结果,缺它不入集,代价只是多弹卡) */
export function storedImageNotice(img: {
  id: string;
  mime: string;
  w: number;
  h: number;
  url: string;
}): string {
  return (
    JSON.stringify({
      stored: true,
      id: img.id,
      mime: img.mime,
      w: img.w,
      h: img.h,
      source: img.url,
    }) +
    `\nReference it in your answer as ![alt](tars-img:${img.id}) and keep the source URL (${img.url}) visible near it`
  );
}

export async function runWebFetchImage(args: WebFetchImageArgs): Promise<string> {
  const url = parseImageUrl(args);
  const parsed = new URL(url);
  // 抓取由 SW fetch 直连,依赖目标站点的 host 授权;未授权时快速失败并给
  // 授权指引,不烧 20s 超时(措辞仿 webFetch.ts)
  if (!(await hasOriginAccess(url))) {
    throw new Error(
      `web_fetch_image 需要访问 ${parsed.origin} 的授权。请让用户在 TARS 设置 → 安全 中开启「页面与网络访问」,授权后重试`,
    );
  }
  const ctx = getToolExecutionContext();
  const sessionId = ctx?.sessionId;
  if (!sessionId) {
    throw new Error(
      "web_fetch_image: 找不到当前会话上下文,图片无处入库;请重试一次",
    );
  }
  const { signal, cleanup } = abortWithTimeout(FETCH_TIMEOUT_MS, ctx?.signal);
  try {
    let res: Response;
    try {
      res = await fetch(url, { signal });
    } catch (e) {
      if (ctx?.signal?.aborted) throw new Error("Image fetch cancelled by the user");
      const msg = errText(e);
      if (/timeout/i.test(msg)) {
        throw new Error(`Image fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s: ${url}`);
      }
      throw new Error(`Image fetch failed: ${msg} (${url})`);
    }
    if (!res.ok) {
      throw new Error(`Image returned HTTP ${res.status} (the link may be dead or require login)`);
    }
    const mime = assertImageContentType(res.headers.get("content-type"));
    /** 重定向复核与 web_fetch 同款:响应头已到手、正文一个字节未读 ——
     *  落点换 host 就重跑判定(私网落点抛错);日志只记 host,不带完整 URL */
    const finalUrl = reviewRedirectTarget(url, res.url || url);
    if (finalUrl !== (res.url || url)) {
      log.info("webfetchimg", "redirect host changed", {
        from: hostKey(parsed.hostname),
        to: hostKey(new URL(res.url).hostname),
      });
    }
    const buf = await (async () => {
      /** 下载阶段单独包装(中止/超时给可读文案);Content-Length 超限先拒,
       *  不吃满下载 —— 与 webFetch 同款两层防线 */
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared)) assertImageBytes(declared);
      try {
        return await res.arrayBuffer();
      } catch (e) {
        if (ctx?.signal?.aborted) throw new Error("Image fetch cancelled by the user");
        const msg = errText(e);
        if (/timeout/i.test(msg)) {
          throw new Error(`Image fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s: ${url}`);
        }
        throw new Error(`Image download failed: ${msg} (${url})`);
      }
    })();
    assertImageBytes(buf.byteLength);
    const bytes = new Uint8Array(buf);
    // 解码验真:createImageBitmap 只接受真实位图(ImageBitmapSource 不收裸
    // 字节,包 Blob 送入),错标 HTML / SVG / 半截文件在此拒绝;宽高只为
    // 入库元数据,取完立刻释放
    const { w, h } = await (async () => {
      try {
        const bmp = await createImageBitmap(new Blob([bytes], { type: mime }));
        const size = { w: bmp.width, h: bmp.height };
        bmp.close();
        return size;
      } catch {
        throw new Error(
          `Not a valid image (${mime}) — the URL may point to an HTML error page or an unsupported format; try another source or describe it in text`,
        );
      }
    })();
    const id = crypto.randomUUID();
    await putImage(sessionId, id, bytes, { mime, w, h });
    /** 隐私红线:只记 host 与字节数(完整 URL 与图片字节不入诊断日志) */
    log.info("webfetchimg", "image stored", {
      host: hostKey(parsed.hostname),
      bytes: buf.byteLength,
      w,
      h,
    });
    return storedImageNotice({ id, mime, w, h, url });
  } finally {
    cleanup();
  }
}
