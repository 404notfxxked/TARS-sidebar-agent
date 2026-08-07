// 工具执行上下文:run 作用域,提交时捕获 tabId,工具从中读取
// 解决 P0:用户对 tab A 提问,中途切到 tab B,工具应读 A 而非实时激活的 B
// 安全性:SW 单线程 + dispatchToolCall 被 await 串行化,set 后不会被其他 run 抢占

export interface ToolExecutionContext {
  /** 提交时激活的 tab;无激活 tab 时可能为 undefined */
  tabId: number | undefined;
  sessionId: string;
}

let _ctx: ToolExecutionContext | null = null;

export function setToolExecutionContext(ctx: ToolExecutionContext | null): void {
  _ctx = ctx;
}

export function getToolExecutionContext(): ToolExecutionContext | null {
  return _ctx;
}
