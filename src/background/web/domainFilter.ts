// web_search 域名过滤(结果后置):API 通道(webSearch.ts)与 tab 通道
// (tabSearch.ts)共用一份实现;名单归一(parseDomainList)在调用侧。

/** 主机名匹配:等于名单项或为其子域(example.com 匹配 www.example.com) */
export function passesDomainFilter(
  url: string,
  allowed: string[],
  blocked: string[],
): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false; // 非法 URL 视为不通过
  }
  if (
    allowed.length > 0 &&
    !allowed.some((d) => hostname === d || hostname.endsWith(`.${d}`))
  ) {
    return false;
  }
  return !blocked.some((d) => hostname === d || hostname.endsWith(`.${d}`));
}
