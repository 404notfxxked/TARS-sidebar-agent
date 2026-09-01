// 图片 base64 ⇄ 字节编解码。
// 为什么存在:扩展的 port 消息(runtime.connect 的 postMessage)按 JSON 语义
// 序列化,ArrayBuffer/TypedArray 过不去(到达即空)—— 图片在「面板 ↔ 后台」
// 两个端口边界都以 base64 字符串传输,此模块负责边界上的编解码。
// btoa/atob 在 SW 与页面上下文都可用;分块展开防大数组触发参数上限。

const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
