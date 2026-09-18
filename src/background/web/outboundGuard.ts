// web_fetch 出站判定(纯函数,供确认门按参数调用)。
// 2026-09 评审 S1 的两层收口:
//  1. 私网/内网目标 → 无条件确认(读取内网是设计内能力,但属「用户该知情
//     放行」的出口;含 IPv4-mapped IPv6 —— URL 规范化会把 [::ffff:127.0.0.1]
//     写成十六进制形态,裸查首段会漏,解码回 IPv4 再判);
//  2. 会话来源域白名单(fetchAllowlist 从会话历史推导:用户消息显式 URL /
//     搜索结果 / 本会话已成功抓取的域)命中的域直抓,未命中的域一律确认
//     —— 路径承载、子域承载、阈值内的短负载从此都逃不过确认卡。
// 由此,任意「外带」目标要么在白名单里、要么过用户的卡。页面内容里的
// URL 永远不进白名单(不可信,评审 S4),那是 fetchAllowlist 的纪律,本
// 模块只认传入的集合。「确认是知情放行,不是拒绝」:白名单外首次抓取
// 弹卡一次,批准后本会话内该域畅通。

import type { WebFetchArgs } from "./webFetch";

/** URL → 白名单键(hostKey 归一);非法/非 http(s) → null */
export function allowlistDomainOf(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return hostKey(u.hostname);
  } catch {
    return null;
  }
}

/** 域名归一:小写、去尾点、去一层 www. 前缀(www.example.com ≡ example.com),
 *  IPv6 字面量的方括号一并剥掉(URL.hostname 对 IPv6 保留括号)。
 *  其余子域不通配:api.evil.tld 不因 evil.tld 在白名单而放行 */
export function hostKey(hostname: string): string {
  const h = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  return h.startsWith("www.") ? h.slice(4) : h;
}

/** web_fetch 的确认门判定(确认门经 needsConfirmation 调用):
 *  私网/内网目标 → 确认;白名单域 → 直抓;其余(白名单未命中)→ 确认。
 *  URL 解析失败/非 http(s)/缺参 → false,让工具自身的报错去说话 */
export function webFetchNeedsConfirm(
  args: unknown,
  allowlist?: ReadonlySet<string>,
): boolean {
  const url = (args as WebFetchArgs | null)?.url;
  if (typeof url !== "string") return false;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (isPrivateNetworkTarget(parsed.hostname)) return true;
  const domain = allowlistDomainOf(url);
  if (domain && allowlist?.has(domain)) return false;
  return true;
}

/**
 * 重定向复核(确认门只判入口 URL,而 fetch 默认跟随重定向):落点 host 与
 * 请求 host 不同(经 hostKey 归一,www/大小写不算变化)时——
 *  - 落点是私网/内网 → 抛模型可读错误,正文一个字节都不读(评审追加:
 *    「白名单域 302 → 内网」的绕行链路,此处是唯一的机械拦截点);
 *  - 公开落点 → 放行,但返回请求 URL 而非落点 URL:结果不回填跨站落点,
 *    白名单只学习入口域,host 变化的知情放行只能来自用户显式给出。
 * 同 host 的跳转(http→https、站内路径)原样返回落点。
 */
export function reviewRedirectTarget(
  requestUrl: string,
  responseUrl: string,
): string {
  if (!responseUrl || responseUrl === requestUrl) {
    return responseUrl || requestUrl;
  }
  let from: URL;
  let to: URL;
  try {
    from = new URL(requestUrl);
    to = new URL(responseUrl);
  } catch {
    return responseUrl; // 落点不可解析的极端形态,维持原行为
  }
  if (hostKey(to.hostname) === hostKey(from.hostname)) return responseUrl;
  if (isPrivateNetworkTarget(to.hostname)) {
    throw new Error(
      `链接重定向到了私网地址(${to.origin}),已停止读取。` +
        "要读取该地址请明确给出它,不要经由可能被操纵的重定向",
    );
  }
  return requestUrl;
}

/** 私网/内网目标判定(主机名启发式):IP 字面量按 RFC1918/环回/链路本地/
 *  CGNAT,主机名按 localhost/.local/.internal 惯例。DNS 名解析到私网地址
 *  的绕行不在判定内 —— 这是「知情放行」的底线,不是沙箱 */
export function isPrivateNetworkTarget(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal")
  ) {
    return true;
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (h.includes(":")) {
    // IPv4-mapped IPv6 解码后按 IPv4 判(递归一次,解码结果不含冒号)
    const mapped = decodeIPv4Mapped(h);
    if (mapped) return isPrivateNetworkTarget(mapped);
    const addr = h.replace(/^\[|\]$/g, "");
    if (addr === "::" || addr === "::1") return true;
    const seg = parseInt(addr.split(":")[0] || "0", 16);
    if ((seg & 0xffc0) === 0xfe80) return true; // fe80::/10 链路本地
    if ((seg & 0xfe00) === 0xfc00) return true; // fc00::/7 唯一本地(ULA)
    return false;
  }
  return false;
}

/** ::ffff: 前缀的 IPv4-mapped 形态 → 点分 IPv4 字符串;非映射形态 → null。
 *  兼容点分(::ffff:127.0.0.1)与十六进制(::ffff:7f00:1)两种写法 ——
 *  WHATWG URL 序列化 IPv6 主机名时用后者,前者是人的书写习惯 */
function decodeIPv4Mapped(h: string): string | null {
  const addr = h.replace(/^\[|\]$/g, "");
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(addr);
  if (!hex) return null;
  const g1 = parseInt(hex[1], 16);
  const g2 = parseInt(hex[2], 16);
  return `${g1 >> 8}.${g1 & 0xff}.${g2 >> 8}.${g2 & 0xff}`;
}
