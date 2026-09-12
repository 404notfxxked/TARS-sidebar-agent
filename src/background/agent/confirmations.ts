// 写操作确认门(SW 侧):浏览器 agent 的页面写动作(click_element /
// fill_input)在执行前向面板发 AGENT_CONFIRM_REQUEST,等用户答复
// (CONFIRM_RESPONSE)。防的是页面内容注入指令后诱导模型「替用户动手」
// ——确认卡带完整上下文(工具、目标页、写入内容),由人做最后决定。
//
// 从严语义:
// - 超时未答复 = 拒绝(宁慢勿错,不给人不在场时放行写动作的口子)
// - run 被取消 = 立即拒绝并返回(等待不阻塞取消)
// - 过期/未知 requestId 的答复一律忽略(面板刷新后的迟到答复打不穿)

import { MSG } from "../../shared/messages";
import type { AgentPort } from "./agent";
import { getToolExecutionContext } from "../tools/toolContext";

/** 等待答复上限:面板关了/用户走开了,run 不该挂在半空 */
const CONFIRM_TIMEOUT_MS = 120_000;

/** 模型可见的拒绝文案:明确告知不要原样重试,把意图讲给用户 */
export const CONFIRM_DENIED_MSG =
  "The user declined this action (or did not respond in time). Do not retry it verbatim; briefly tell the user what you intended to do and continue without it unless they ask otherwise.";

const pending = new Map<string, (approved: boolean) => void>();

/** 需要人工确认的页面写动作:点按与填写(含 pressEnterAfter 的提交路径)。
 *  读页三件套/搜索/元素查找是纯观察,不过门 */
export const CONFIRM_TOOLS: ReadonlySet<string> = new Set([
  "click_element",
  "fill_input",
]);

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
async function resolveTargetTab(): Promise<{
  tabTitle?: string;
  tabUrl?: string;
}> {
  const ctx = getToolExecutionContext();
  const tabId = ctx?.lastOperatedTabId ?? ctx?.tabId;
  if (tabId === undefined) return {};
  const tab = await chrome.tabs.get(tabId);
  return { tabTitle: tab.title, tabUrl: tab.url };
}

/**
 * 发确认请求并等待答复。true = 用户允许;false = 拒绝/超时/已取消。
 * 必须在 tool 执行上下文已设置的状态下调用(目标 tab 从上下文读)。
 */
export async function requestConfirmation(
  port: AgentPort,
  req: ConfirmRequestInfo,
  signal?: AbortSignal,
): Promise<boolean> {
  const requestId = crypto.randomUUID();
  const target = await resolveTargetTab().catch(() => ({}));
  port.postMessage({
    type: MSG.AGENT_CONFIRM_REQUEST,
    requestId,
    name: req.name,
    ...(req.displayName ? { displayName: req.displayName } : {}),
    args: req.args,
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
