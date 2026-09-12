import { describe, expect, it } from "vitest";
import { pickTargetTabId } from "./toolContext";

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
