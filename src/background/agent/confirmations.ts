// 写操作确认门(SW 侧):写动作在执行前向面板发 AGENT_CONFIRM_REQUEST,
// 等用户答复(CONFIRM_RESPONSE);web_fetch 走参数级底线判定(见
// needsConfirmation)。防的是页面内容注入指令后诱导模型「替用户动手」或
// 「把数据编码外带」——确认卡带完整上下文(工具、目标页/写入内容),由人
// 做最后决定。
//
// 档位(confirmLevel,真源 shared/configStore.ts):strict = 一切写动作
// 过门(缺省);auto = 页面写免门,记忆写/MCP/出站判定仍过门;off = 全免
// (用户自担)。判定与分组由 TOOL_CATEGORY 单一真源派生;门闭包
// (ConfirmGate)在 run 装配处建一次,dispatch 与批次屏障共用同一实例
// ——两处判定必须同源,屏障分歧会打破确认卡单槽约束(见 toolBatch.ts)。
//
// 从严语义:
// - 超时未答复 = 拒绝(宁慢勿错,不给人不在场时放行写动作的口子)
// - run 被取消 = 立即拒绝并返回(等待不阻塞取消)
// - 过期/未知 requestId 的答复一律忽略(面板刷新后的迟到答复打不穿)
//
// 排查指引:面板看到「确认卡悬空无人应答」= 等待期间 SW 被回收过
// —— pending Map 随 SW 消失,迟到答复在此静默忽略,属预期兜底而非卡死。

import { MSG } from "../../shared/messages";
import type { ConfirmLevel } from "../../shared/configStore";
import type { AgentPort } from "./agent";
import type { ToolExecutionContext } from "../tools/toolContext";
import { webFetchNeedsConfirm } from "../web/outboundGuard";

/** 等待答复上限:面板关了/用户走开了,run 不该挂在半空 */
const CONFIRM_TIMEOUT_MS = 120_000;

/** 模型可见的拒绝文案:明确告知不要原样重试,把意图讲给用户 */
export const CONFIRM_DENIED_MSG =
  "The user declined this action (or did not respond in time). Do not retry it verbatim; briefly tell the user what you intended to do and continue without it unless they ask otherwise.";

const pending = new Map<string, (approved: boolean) => void>();

/**
 * 静态写工具的唯一真源(P1-17 定案):name → 风险类别。三个派生集合
 * (PAGE_WRITE_TOOLS / PERSISTENT_TOOLS / WRITE_TOOLS)全部由它算出,
 * 改分组只改这份数据,不动 needsConfirmation 函数体 —— C2 的 MCP
 * annotations 分流、C3 的敏感动作分类届时在对应分支接入。
 *  - page-write:页面写动作(点按/填写,含 pressEnterAfter 提交路径)。
 *    auto 档免门 —— 浏览器 agent 的日常高频动作,逐次过卡必逼用户走
 *    极端(off);但它们作用于任意已授权页面(auto 档 UI 明示此范围)
 *  - persistent:跨会话持久写。auto 档仍过门 —— 记忆每轮以 user 角色
 *    注入所有会话,被注入的指令可借它形成跨会话持久化操纵;delete 还是
 *    按子串的破坏性删除
 * (web_fetch 不在表内:是否过门是参数级判定,见 webFetchNeedsConfirm;
 *  mcp_* 不在表内:语义由各服务器自定义,一律过门,宁慢勿错)
 */
export const TOOL_CATEGORY: Readonly<Record<string, "page-write" | "persistent">> =
  {
    click_element: "page-write",
    fill_input: "page-write",
    memory_save: "persistent",
    memory_delete: "persistent",
  };

/** auto 档免门的组:由 TOOL_CATEGORY 派生(page-write) */
export const PAGE_WRITE_TOOLS: ReadonlySet<string> = new Set(
  Object.entries(TOOL_CATEGORY)
    .filter(([, category]) => category === "page-write")
    .map(([name]) => name),
);

/** auto 档仍过门的组:由 TOOL_CATEGORY 派生(persistent) */
export const PERSISTENT_TOOLS: ReadonlySet<string> = new Set(
  Object.entries(TOOL_CATEGORY)
    .filter(([, category]) => category === "persistent")
    .map(([name]) => name),
);

/** 静态写工具全集(替代旧名 CONFIRM_TOOLS):write 标记双向不变式
 *  (tools.test.ts)钉的是它;「会过门」的权威判定是 needsConfirmation
 *  + 档位,不再等价于本集合(auto/off 档下部分成员免门) */
export const WRITE_TOOLS: ReadonlySet<string> = new Set(
  Object.keys(TOOL_CATEGORY),
);

/** 共享门闭包的类型:dispatch 与批次屏障必须调用同一个实例(契约点 1) */
export type ConfirmGate = (name: string, args: unknown) => boolean;

/** 统一确认门判定(带档位):
 *  - off:恒 false(用户显式自担,UI 已明示记忆写与 MCP 也不再人审)
 *  - auto:page-write 组免门(日常高频动作),记忆写/MCP/web_fetch 出口
 *    判定不变 —— 与调研共性对齐:持久写/外部执行/数据外带通道无论哪档
 *    都有人审,直到 off
 *  - strict:现行为(一切写动作过门)
 *  web_fetch 走参数级底线判定(见 needsConfirmation 旧注释与 outboundGuard):
 *  私网目标,或会话来源域白名单未命中 —— 命中直抓 */
export function needsConfirmation(
  name: string,
  args: unknown,
  level: ConfirmLevel,
  fetchAllowlist?: ReadonlySet<string>,
): boolean {
  if (level === "off") return false;
  if (level === "auto" && PAGE_WRITE_TOOLS.has(name)) return false;
  if (WRITE_TOOLS.has(name)) return true;
  // MCP 工具语义由各服务器自定义,无法静态判定只读:删除/发送/改配置皆可能,
  // 也可能就是把数据外带的通道 —— 一律过门,宁慢勿错(架构不变式:写工具
  // 必须过确认门再上线;off 档关闭即用户自担,同页面写动作口径)
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
