import { describe, expect, it } from "vitest";
import {
  clearToolExecutionContext,
  getToolExecutionContext,
  pickTargetTabId,
  setToolExecutionContext,
  type ToolExecutionContext,
} from "./toolContext";

describe("pickTargetTabId 回退链", () => {
  it("参数显式指定最优先", () => {
    expect(pickTargetTabId(7, 3, 2, 9)).toBe(7);
  });

  it("无参数 → 本 run 最近操作的 tab 次优先", () => {
    expect(pickTargetTabId(undefined, 3, 2, 9)).toBe(3);
  });

  it("再退到提交时捕获的 tab", () => {
    expect(pickTargetTabId(undefined, undefined, 2, 9)).toBe(2);
  });

  it("最后才是实时激活 tab", () => {
    expect(pickTargetTabId(undefined, undefined, undefined, 9)).toBe(9);
  });

  it("全部落空 → null(调用方抛 no active tab)", () => {
    expect(pickTargetTabId(undefined, undefined, undefined, null)).toBeNull();
  });

  it("上游缺省(undefined)不拦截回退链", () => {
    expect(pickTargetTabId(undefined, undefined, 2, null)).toBe(2);
  });
});

describe("工具执行上下文的 run 收口清理", () => {
  const makeCtx = (tabId: number): ToolExecutionContext => ({
    tabId,
    sessionId: "s1",
  });

  it("清除自己持有的 ctx", () => {
    const ctx = makeCtx(1);
    setToolExecutionContext(ctx);
    clearToolExecutionContext(ctx);
    expect(getToolExecutionContext()).toBeNull();
  });

  it("全局已被并发 run 覆盖时不清别人的(条件清除)", () => {
    const mine = makeCtx(1);
    const theirs = makeCtx(2);
    setToolExecutionContext(mine);
    setToolExecutionContext(theirs); // 并发 run 后来居上
    clearToolExecutionContext(mine);
    expect(getToolExecutionContext()).toBe(theirs);
    clearToolExecutionContext(theirs);
    expect(getToolExecutionContext()).toBeNull();
  });

  it("set 同一对象不产生新身份,lastOperatedTabId 跨调用保留", () => {
    const ctx = makeCtx(1);
    setToolExecutionContext(ctx);
    ctx.lastOperatedTabId = 42; // 模拟工具执行中写入「最近操作 tab」
    setToolExecutionContext(ctx); // 下一次 dispatchToolCall 重申归属
    expect(getToolExecutionContext()?.lastOperatedTabId).toBe(42);
    clearToolExecutionContext(ctx);
  });
});
