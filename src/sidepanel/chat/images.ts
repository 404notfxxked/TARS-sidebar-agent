// 图片附件:压缩管线 + 历史图片 objectURL 缓存。从 ChatView 拆出的纯工具层,
// 不含 React。压缩必须在面板做 —— MV3 SW 没有 canvas 和 URL.createObjectURL;
// 缓存侧面板生命周期内不淘汰(侧栏关闭即销毁,量级小)。

import { base64ToBytes } from "../../shared/imageCodec";

export const MAX_ATTACHMENTS = 4;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_EDGE = 1600;

export interface PendingImage {
  id: string;
  mime: string;
  w: number;
  h: number;
  /** 压缩结果的 base64(port 消息是 JSON 语义,只能传字符串,见 imageCodec) */
  base64: string;
  /** 面板本地预览 URL(objectURL);发送后转入气泡缓存,不再单独撤销 */
  url: string;
}

/** 解码 → 长边缩放 → 按类型重编码(PNG/WebP→WebP 保透明,其余→JPEG)。
 *  结果仍超 2MB 时降质重试一次;解码不出(HEIC 等)直接抛给调用方提示 */
export async function compressImage(file: File): Promise<PendingImage> {
  const bmp = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas unavailable");
    ctx.drawImage(bmp, 0, 0, w, h);
    const mime =
      file.type === "image/png" || file.type === "image/webp"
        ? "image/webp"
        : "image/jpeg";
    let blob = await canvasToBlob(canvas, mime, 0.85);
    if (blob && blob.size > MAX_IMAGE_BYTES) {
      blob = await canvasToBlob(canvas, mime, 0.7);
    }
    if (!blob) throw new Error("image encode failed");
    const base64 = await blobToBase64(blob);
    return {
      id: crypto.randomUUID(),
      mime,
      w,
      h,
      base64,
      url: URL.createObjectURL(blob),
    };
  } finally {
    bmp.close();
  }
}

/** Blob → 纯 base64(去掉 data URL 前缀) */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const dataUrl = String(fr.result);
      resolve(dataUrl.slice(dataUrl.indexOf(",") + 1));
    };
    fr.onerror = () => reject(fr.error ?? new Error("read failed"));
    fr.readAsDataURL(blob);
  });
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  mime: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, mime, quality));
}

// ---- 历史图片 objectURL 缓存:id → url。字节缺失时经 GET_IMAGE 消息向后台
// 取,IMAGE_DATA 事件回填;取不到(随会话被清理)以 null 收场 ----

const imgUrlCache = new Map<string, string>();
const imgInflight = new Map<string, Promise<string | null>>();
const imgWaiters = new Map<string, (url: string | null) => void>();
let sendGetImage: ((id: string) => void) | null = null;

/** useAgentChannel 接线时接入发送通道(历史图片字节经 port 向后台要) */
export function setImageSender(send: (id: string) => void): void {
  sendGetImage = send;
}

/** 发送时把本地预览 URL 转入气泡缓存,渲染无需再向后台取字节 */
export function cacheImgUrl(id: string, url: string): void {
  imgUrlCache.set(id, url);
}

/** 同步窥缓存(气泡首帧用);miss 走 requestImgUrl */
export function peekImgUrl(id: string): string | null {
  return imgUrlCache.get(id) ?? null;
}

/** 缓存是否已持有该图片的本地 URL(= 该 URL 的生命周期已归消息列表,
 *  待发清单不该再回收它。见 useAttachments 的 clearAttachments) */
export function ownsImgUrl(id: string): boolean {
  return imgUrlCache.has(id);
}

/** 回收全部本地图片 URL(会话切换/新对话:这一屏气泡连同缓存一起让位)。
 *  字节在库里,再渲染同 id 会重新走 GET_IMAGE 取,图不丢;不回收则会随
 *  面板寿命一直累积 blob URL */
export function releaseAllImgUrls(): void {
  for (const url of imgUrlCache.values()) URL.revokeObjectURL(url);
  imgUrlCache.clear();
}

export function requestImgUrl(id: string): Promise<string | null> {
  const cached = imgUrlCache.get(id);
  if (cached) return Promise.resolve(cached);
  const inflight = imgInflight.get(id);
  if (inflight) return inflight;
  const p = new Promise<string | null>((resolve) => {
    imgWaiters.set(id, resolve);
  });
  imgInflight.set(id, p);
  sendGetImage?.(id);
  return p;
}

/** 后台 IMAGE_DATA 事件回填:字节换 objectURL 交给气泡 */
export function resolveImageData(evt: {
  id: string;
  mime?: string;
  base64?: string;
}): void {
  const waiter = imgWaiters.get(evt.id);
  imgWaiters.delete(evt.id);
  imgInflight.delete(evt.id);
  if (!evt.base64) {
    waiter?.(null); // 图片已随会话被清理/清空
    return;
  }
  const url = URL.createObjectURL(
    new Blob([base64ToBytes(evt.base64)], { type: evt.mime ?? "image/png" }),
  );
  imgUrlCache.set(evt.id, url);
  waiter?.(url);
}

/** port 断开(后台被杀)时,在途的图片字节请求永远等不到回包:统一按
 *  「图片缺失」收场,气泡出失效占位,而不是骨架屏永久转圈。断连重同步
 *  会替换消息列表,之后有新组件实例重新发起请求 */
export function failPendingImages(): void {
  const waiters = [...imgWaiters.entries()];
  imgWaiters.clear();
  imgInflight.clear();
  for (const [, waiter] of waiters) waiter(null);
}
