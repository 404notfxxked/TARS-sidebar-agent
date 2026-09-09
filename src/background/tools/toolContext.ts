// 工具执行上下文:run 作用域,提交时捕获 tabId / 会话 / 取消信号,工具从中读取
// 解决 P0:用户对 tab A 提问,中途切到 tab B,工具应读 A 而非实时激活的 B
// 安全性:SW 单线程 + dispatchToolCall 被 await 串行化,set 后不会被其他 run 抢占

export interface ToolExecutionContext {
  /** 提交时激活的 tab;无激活 tab 时可能为 undefined */
  tabId: number | undefined;
  sessionId: string;
  /** 本次 run 的取消信号(agent 被中止时 abort);联网工具用于中断在途请求 */
  signal?: AbortSignal;
}

let _ctx: ToolExecutionContext | null = null;

export function setToolExecutionContext(ctx: ToolExecutionContext | null): void {
  _ctx = ctx;
}

export function getToolExecutionContext(): ToolExecutionContext | null {
  return _ctx;
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
