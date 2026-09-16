// 工具执行上下文:run 作用域,提交时捕获 tabId / 会话 / 取消信号,工具从中读取
// 解决 P0:用户对 tab A 提问,中途切到 tab B,工具应读 A 而非实时激活的 B
// 并发安全(1.2.0 只读工具并行后修订):整 run 复用同一个 ctx 对象,
// dispatchToolCall 执行前重复 set 只是重申归属,不产生新对象 ——
// lastOperatedTabId 的跨轮记忆与并行兄弟工具的读取互不干扰;
// 清理只在 run 收口做(clearToolExecutionContext 条件清,并发 run 互不误伤),
// per-call finally 置 null 在并行批次下会砸掉晚完成工具的后置读取

export interface ToolExecutionContext {
  /** 提交时激活的 tab;无激活 tab 时可能为 undefined */
  tabId: number | undefined;
  sessionId: string;
  /** 本次 run 的取消信号(agent 被中止时 abort);联网工具用于中断在途请求 */
  signal?: AbortSignal;
  /** 本 run 内最近一次被页面工具操作过的 tab(读/写都算):
   *  连续多步操作同一页时省掉重复传 tabId */
  lastOperatedTabId?: number;
}

/**
 * 目标 tabId 的回退链(纯函数,单测覆盖):
 * 参数显式指定 > 本 run 最近操作的 tab > 提交时捕获的 tab > 实时激活 tab。
 * 全部落空返回 null(调用方抛「no active tab」)。
 */
export function pickTargetTabId(
  argsTabId: number | undefined,
  lastOperatedTabId: number | undefined,
  submitTabId: number | undefined,
  activeTabId: number | null,
): number | null {
  const picked =
    argsTabId ?? lastOperatedTabId ?? submitTabId ?? activeTabId ?? null;
  return picked;
}

let _ctx: ToolExecutionContext | null = null;

export function setToolExecutionContext(ctx: ToolExecutionContext | null): void {
  _ctx = ctx;
}

export function getToolExecutionContext(): ToolExecutionContext | null {
  return _ctx;
}

/** run 收口清除:仅当全局 ctx 仍是本 run 传入的对象时才清。
 *  并发 run(多窗口各开面板)下,后来 run 已覆盖全局时不动它 —— 清理
 *  只属于还持有全局的那个 run */
export function clearToolExecutionContext(ctx: ToolExecutionContext): void {
  if (_ctx === ctx) _ctx = null;
}

/**
 * 组合「外部取消(用户中止 run)」与「超时」的 AbortSignal。
 * 外部先中止 → 立即中止(reason="cancelled");否则到时中止(reason="timeout")。
 * cleanup 必须在请求落定后调用,否则定时器与监听器泄漏。
 */
export function abortWithTimeout(
  timeoutMs: number,
  external?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
  const ctl = new AbortController();
  const timer = setTimeout(
    () => ctl.abort(new Error(`timeout after ${timeoutMs}ms`)),
    timeoutMs,
  );
  const onExternalAbort = () => ctl.abort(new Error("cancelled"));
  if (external) {
    if (external.aborted) onExternalAbort();
    else external.addEventListener("abort", onExternalAbort, { once: true });
  }
  const cleanup = () => {
    clearTimeout(timer);
    external?.removeEventListener("abort", onExternalAbort);
  };
  return { signal: ctl.signal, cleanup };
}
