// 面板侧的站点授权操作:全部依赖用户手势,只能由按钮点击直接触发。
// - 「页面与网络访问」总开关(request/remove <all_urls>):页面工具、
//   联网搜索 tab 通道、web_fetch 的通行证
// - 按域请求单个 origin:模型服务「获取模型列表」、MCP「测试连接」时,
//   只为当前端点授权 —— 聊天不依赖总开关也能工作
// 查询逻辑在 shared/hostAccess(SW 共用);这里只做手势侧的请求/撤销。

import { ALL_URLS, grantableOriginOf, hasOriginAccess } from "../shared/hostAccess";

export { hasOriginAccess, hasPageAccess } from "../shared/hostAccess";

/** 请求页面级总授权;弹窗被拒/环境不支持时返回 false */
export async function requestPageAccess(): Promise<boolean> {
  try {
    return await chrome.permissions.request({ origins: [ALL_URLS] });
  } catch {
    return false;
  }
}

export async function revokePageAccess(): Promise<void> {
  try {
    await chrome.permissions.remove({ origins: [ALL_URLS] });
  } catch {
    /* 未授予/已撤销 */
  }
}

/** 为给定端点发起按域授权(已授权或缺合法 origin 时直接放行)。
 *  返回 false = 用户拒绝了授权弹窗,调用方按需提示,不阻断保存 */
export async function ensureOriginAuthorized(
  baseUrl: string,
): Promise<boolean> {
  const origin = grantableOriginOf(baseUrl);
  if (!origin) return true;
  if (await hasOriginAccess(origin)) return true;
  try {
    return await chrome.permissions.request({
      origins: [`${origin}/*`],
    });
  } catch {
    return false;
  }
}
