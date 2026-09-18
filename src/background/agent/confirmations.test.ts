// 确认门判定单测:静态集合(页面写动作 + 记忆持久写)与 web_fetch 的
// 参数级底线(私网目标/长查询串,评审 S1/S3)。总开关 confirmActions
// 由 agent 派发点把守,不在此测。出站判定本体在 ../web/outboundGuard
// (纯模块),那里有独立单测;这里测 needsConfirmation 的接入。

import { describe, expect, it } from "vitest";
import { CONFIRM_TOOLS, needsConfirmation } from "./confirmations";

describe("needsConfirmation 静态集合", () => {
  it("页面写动作与记忆持久写过门;读页/搜索类不过门", () => {
    for (const name of ["click_element", "fill_input", "memory_save", "memory_delete"]) {
      expect(CONFIRM_TOOLS.has(name), name).toBe(true);
      expect(needsConfirmation(name, {}), name).toBe(true);
    }
    for (const name of ["page_read", "page_find", "web_search", "find_elements", "get_tabs"]) {
      expect(needsConfirmation(name, {}), name).toBe(false);
    }
  });
});

describe("needsConfirmation web_fetch 出口判定", () => {
  it("私网/内网目标无条件过确认门,即使域在白名单内", () => {
    const urls = [
      "http://192.168.1.200/admin",
      "http://10.0.0.5/internal/config",
      "http://127.0.0.1:9222/json",
      "http://localhost/dev",
      "http://nas.local/",
      "http://[::ffff:7f00:1]/",
    ];
    const allowAll = new Set([
      "10.0.0.5",
      "192.168.1.200",
      "localhost",
      "nas.local",
      "::ffff:7f00:1",
    ]);
    for (const url of urls) {
      expect(needsConfirmation("web_fetch", { url }), url).toBe(true);
      expect(needsConfirmation("web_fetch", { url }, allowAll), url).toBe(true);
    }
  });

  it("白名单命中直抓,未命中确认(子域不通配)", () => {
    const allowlist = new Set(["example.com"]);
    expect(
      needsConfirmation("web_fetch", { url: "https://example.com/a/b?c=1" }, allowlist),
    ).toBe(false);
    expect(
      needsConfirmation("web_fetch", { url: "https://api.example.com/x" }, allowlist),
    ).toBe(true);
    expect(
      needsConfirmation("web_fetch", { url: "https://evil.tld/collect" }, allowlist),
    ).toBe(true);
  });

  it("无白名单(会话首轮)时,除私网外一律确认", () => {
    expect(
      needsConfirmation("web_fetch", { url: "https://example.com/a/b" }),
    ).toBe(true);
    expect(
      needsConfirmation("web_fetch", { url: `https://evil.tld/${"x".repeat(300)}` }),
    ).toBe(true);
  });

  it("解析失败/非 http(s)/缺参不误触发(由工具自身报错)", () => {
    expect(needsConfirmation("web_fetch", { url: "not a url" })).toBe(false);
    expect(needsConfirmation("web_fetch", { url: "chrome://version" })).toBe(false);
    expect(needsConfirmation("web_fetch", {})).toBe(false);
    expect(needsConfirmation("web_fetch", undefined)).toBe(false);
  });
});
