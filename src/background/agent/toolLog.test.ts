// 工具日志脱敏单测:fill_input 的 text 不进日志(评审 S2 —— 键名脱敏
// REDACT_KEY_RE 只匹配键名,输入原文会经诊断导出泄漏);其余工具参数
// 原样透传,选择器与提交提示保留可诊断。

import { describe, expect, it } from "vitest";
import { redactToolArgsForLog } from "./toolLog";

describe("redactToolArgsForLog", () => {
  it("fill_input 的 text 替换为长度占位,其余字段保留", () => {
    const out = redactToolArgsForLog("fill_input", {
      selector: "#pwd",
      text: "S3cret-OTP-918273",
      pressEnterAfter: true,
    }) as { selector: string; text: string; pressEnterAfter: boolean };
    expect(out.text).toBe("[redacted 17 chars]");
    expect(out.text).not.toContain("S3cret");
    expect(out.selector).toBe("#pwd");
    expect(out.pressEnterAfter).toBe(true);
  });

  it("其他工具的参数原样透传(page_write 语义之外不乱脱)", () => {
    const args = { query: "rust async Book".slice(0, 40), tabId: 3 };
    expect(redactToolArgsForLog("web_search", args)).toBe(args);
    expect(redactToolArgsForLog("click_element", { selector: "#a" })).toEqual({
      selector: "#a",
    });
  });

  it("防御形态:text 缺失或 args 非对象时不炸不误伤", () => {
    expect(redactToolArgsForLog("fill_input", { selector: "#a" })).toEqual({
      selector: "#a",
    });
    expect(redactToolArgsForLog("fill_input", null)).toBeNull();
    expect(redactToolArgsForLog("fill_input", "raw string")).toBe("raw string");
    const weird = { text: 42 };
    expect(redactToolArgsForLog("fill_input", weird)).toBe(weird);
  });
});
