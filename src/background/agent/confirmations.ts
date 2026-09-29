// 写操作确认门(SW 侧):页面写动作(click_element / fill_input)与跨会话
// 持久写(memory_save / memory_delete)在执行前向面板发 AGENT_CONFIRM_REQUEST,
// 等用户答复(CONFIRM_RESPONSE);web_fetch 走参数级底线判定(见
// needsConfirmation)。防的是页面内容注入指令后诱导模型「替用户动手」或
// 「把数据编码外带」——确认卡带完整上下文(工具、目标页/写入内容),由人
// 做最后决定。
//
// 从严语义:
// - 超时未答复 = 拒绝(宁慢勿错,不给人不在场时放行写动作的口子)
// - run 被取消 = 立即拒绝并返回(等待不阻塞取消)
// - 过期/未知 requestId 的答复一律忽略(面板刷新后的迟到答复打不穿)
//
// 排查指引:面板看到「确认卡悬空无人应答」= 等待期间 SW 被回收过
// —— pending Map 随 SW 消失,迟到答复在此静默忽略,属预期兜底而非卡死。

import { MSG } from "../../shared/messages";
import type { AgentPort } from "./agent";
import type { ToolExecutionContext } from "../tools/toolContext";
import { webFetchNeedsConfirm } from "../web/outboundGuard";

/** 等待答复上限:面板关了/用户走开了,run 不该挂在半空 */
const CONFIRM_TIMEOUT_MS = 120_000;

/** 模型可见的拒绝文案:明确告知不要原样重试,把意图讲给用户 */
export const CONFIRM_DENIED_MSG =
  "The user declined this action (or did not respond in time). Do not retry it verbatim; briefly tell the user what you intended to do and continue without it unless they ask otherwise.";

const pending = new Map<string, (approved: boolean) => void>();

/** 需要人工确认的动作:
 *  - click_element / fill_input:页面写操作(含 pressEnterAfter 的提交路径)。
 *    读页三件套/搜索/元素查找是纯观察,不过门
 *  - memory_save / memory_delete:跨会话持久写。记忆每轮以 user 角色注入
 *    所有会话,被注入的指令可借它形成跨会话持久化操纵;delete 还是按子串
 *    的破坏性删除 —— 两者都过门 */
export const CONFIRM_TOOLS: ReadonlySet<string> = new Set([
  "click_element",
  "fill_input",
  "memory_save",
  "memory_delete",
]);

/** 统一确认门判定:静态集合 + MCP 动态工具 + web_fetch 的参数级判定
 *  (私网目标,或会话来源域白名单未命中 —— 见 outboundGuard/fetchAllowlist;
 *  命中直抓)。confirmActions 总开关由调用点(agent 的 dispatch)把守 */
export function needsConfirmation(
  name: string,
  args: unknown,
  fetchAllowlist?: ReadonlySet<string>,
): boolean {
  if (CONFIRM_TOOLS.has(name)) return true;
  // MCP 工具语义由各服务器自定义,无法静态判定只读:删除/发送/改配置皆可能,
  // 也可能就是把数据外带的通道 —— 一律过门,宁慢勿错(架构不变式:写工具
  // 必须过确认门再上线;confirmActions 关闭即用户自担,同页面写动作口径)
  if (name.startsWith("mcp_")) return true;
  if (name === "web_fetch") return webFetchNeedsConfirm(args, fetchAllowlist);
  return false;
}

/** 面板答复入口(index.ts 的 port 路由调用);此处只做幂等 resolve */
export function resolveConfirmation(
  requestId: string,
  approved: boolean,
): void {
  const settle = pending.get(requestId);
  if (!settle) return;
  pending.delete(requestId);
  settle(approved);
}

export interface ConfirmRequestInfo {
  name: string;
  displayName?: string;
  args?: unknown;
}

/** 目标标签页信息:取本 run 最近操作(缺省提交时捕获)的 tab,尽力解析
 *  标题/URL 供确认卡展示;解析失败不阻塞确认流程 */
async function resolveTargetTab(ctx?: ToolExecutionContext | null): Promise<{
  tabTitle?: string;
  tabUrl?: string;
}> {
  const tabId = ctx?.lastOperatedTabId ?? ctx?.tabId;
  if (tabId === undefined) return {};
  const tab = await chrome.tabs.get(tabId);
  return { tabTitle: tab.title, tabUrl: tab.url };
}

/**
 * 发确认请求并等待答复。true = 用户允许;false = 拒绝/超时/已取消。
 * ctx 显式传入:等待窗口是跨 await 的,并发 run 可能已覆盖全局单槽,
 * 从全局读目标 tab 会读到别人的(目标页信息随确认卡一起展示给用户,不能错)
 */
export async function requestConfirmation(
  port: AgentPort,
  req: ConfirmRequestInfo,
  signal?: AbortSignal,
  ctx?: ToolExecutionContext | null,
): Promise<boolean> {
  const requestId = crypto.randomUUID();
  const target = await resolveTargetTab(ctx).catch(() => ({}));
  port.postMessage({
    type: MSG.AGENT_CONFIRM_REQUEST,
    requestId,
    name: req.name,
    ...(req.displayName ? { displayName: req.displayName } : {}),
    args: req.args,
    // 超时口径随载荷下发:确认卡展示「多久不答复算拒绝」,UI 不另存一份
    timeoutMs: CONFIRM_TIMEOUT_MS,
    ...target,
  });

  return new Promise<boolean>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = (approved: boolean) => {
      pending.delete(requestId);
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(approved);
    };
    const onAbort = () => settle(false);
    pending.set(requestId, settle);
    timer = setTimeout(() => settle(false), CONFIRM_TIMEOUT_MS);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
