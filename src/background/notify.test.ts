// shouldNotifyRunEnd 纯决策单测:run 结束通知「该不该发」的语义契约。
// 判据的可见性/焦点半边在 e2e 无法稳定构造(xvfb 无窗口管理器,见
// notify.ts 头注),由本文件钉住;e2e(verify-notify)只覆盖开关与取消。

import { describe, expect, it } from "vitest";
import { shouldNotifyRunEnd, taskLabel } from "./notify";

describe("shouldNotifyRunEnd", () => {
  const base = { aborted: false, notifyDone: true, hidden: false, focused: true };

  it("用户取消的 run 不打扰(优先级最高)", () => {
    expect(shouldNotifyRunEnd({ ...base, aborted: true, hidden: true })).toBe(false);
  });

  it("总开关关闭不打扰", () => {
    expect(shouldNotifyRunEnd({ ...base, notifyDone: false, hidden: true })).toBe(false);
  });

  it("面板可见且窗口持焦 = 用户正看着,不打扰", () => {
    expect(shouldNotifyRunEnd(base)).toBe(false);
  });

  it("面板可见但窗口失焦(用户看别的窗口去了)→ 发", () => {
    expect(shouldNotifyRunEnd({ ...base, focused: false })).toBe(true);
  });

  it("面板不可见 → 发(无须查窗口焦点)", () => {
    expect(shouldNotifyRunEnd({ ...base, hidden: true })).toBe(true);
    expect(shouldNotifyRunEnd({ ...base, hidden: true, focused: false })).toBe(true);
  });
});

describe("taskLabel", () => {
  it("取首行,超 48 字符截断补省略号", () => {
    expect(taskLabel("第一行\n第二行")).toBe("第一行");
    const long = "字".repeat(60);
    expect(taskLabel(long)).toBe(`${"字".repeat(48)}…`);
  });
});
