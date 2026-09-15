// 站点访问权限(optional_host_permissions)的统一查询与表述。
// 授权模型:安装时零站点授权 —— manifest 只声明 optional_host_permissions,
// 真正的 host 授权全部经 chrome.permissions 在用户手势下显式授予:
//   - 设置 → 安全 的「页面与网络访问」总开关(request <all_urls>),是
//     页面工具 / 搜索标签页通道 / web_fetch 的通行证;
//   - 模型服务「获取模型列表」、MCP「测试连接」按 origin 逐域授权。
// 面板侧负责「请求/撤销」(必须用户手势,见 sidepanel/permissions.ts),
// 本模块只提供无副作用的查询,SW 与面板共用。
//
// E2E:测试 flavor 的 manifest 还原静态 host_permissions(tests/lib-cdp-mock.mjs)
// —— chrome.permissions.contains 对静态授权同样返回 true,权限门不含任何
// 测试分叉,生产与测试只差授权「来源」,判定路径完全一致。

export const ALL_URLS = "<all_urls>" as const;

/** URL → 授权用 origin;非法或非 http(s)(chrome:// 等)返回 null */
export function grantableOriginOf(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** 某站点(URL 或 origin)是否已获授权:按域或 <all_urls> 任一命中即可 */
export async function hasOriginAccess(
  rawUrlOrOrigin: string,
): Promise<boolean> {
  const origin = grantableOriginOf(rawUrlOrOrigin) ?? rawUrlOrOrigin;
  return (await contains(`${origin}/*`)) || (await contains(ALL_URLS));
}

/** 页面级总授权(页面工具 / 搜索 tab 通道 / 引擎探测 / web_fetch 的通行证) */
export async function hasPageAccess(): Promise<boolean> {
  return contains(ALL_URLS);
}

/** 给模型的授权缺失指引:工具错误回填后由模型转告用户(中文沿用
 *  contentTools 的语义化错误约定) */
export function pageAccessHint(origin: string): string {
  return (
    `尚未获得 ${origin} 的站点访问授权,无法读取或操作。` +
    "请让用户在 TARS 设置 → 安全 中开启「页面与网络访问」(或在对应设置项重新授权),授权后重试"
  );
}

async function contains(pattern: string): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: [pattern] });
  } catch {
    return false;
  }
}
