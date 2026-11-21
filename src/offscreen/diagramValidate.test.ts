// diagram_validate(offscreen 侧 mermaid 语法校验)单测:mermaid 模块整体
// mock —— 抛错路径按卡截 300 字符、suppressErrors 下的 false 返回也是坏块、
// 成功 {ok:true};initialize 模块级只跑一次(常驻 offscreen 不按调用重初始化)。
// 被测模块持有模块级初始化单例,vi.resetModules() 保证每用例全新单例,
// 断言互不串(同 diagram.test.ts 缓存跨用例共享的坑)。

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ParseResult } from "mermaid";

vi.mock("mermaid", () => ({
  default: { initialize: vi.fn(), parse: vi.fn() },
}));

async function loadFresh() {
  const m = await import("mermaid");
  const v = await import("./diagramValidate");
  return {
    parse: vi.mocked(m.default.parse),
    init: vi.mocked(m.default.initialize),
    validate: v.validateDiagramSource,
  };
}

describe("validateDiagramSource(offscreen diagram_validate)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("parse 成功 → {ok:true},initialize 带 startOnLoad:false", async () => {
    const { parse, init, validate } = await loadFresh();
    parse.mockResolvedValue({ diagramType: "flowchart", config: {} });
    await expect(validate("flowchart TD\n  A --> B")).resolves.toEqual({
      ok: true,
    });
    expect(init).toHaveBeenCalledWith({ startOnLoad: false });
  });

  it("parse 返回 false(suppressErrors 下的坏源码形态)→ {ok:false}", async () => {
    const { parse, validate } = await loadFresh();
    // vi.mocked 取的是 parse 的非 suppressErrors 重载类型(Promise<ParseResult>);
    // suppressErrors:true 的真实运行时契约是 ParseResult | false,这里按
    // 运行时形态桩 false,类型断言只服务 mock,不改变被测行为
    parse.mockResolvedValue(false as unknown as ParseResult);
    const r = await validate("flowchat TD");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeTruthy();
  });

  it("parse 抛错 → {ok:false} 且 error 截断到 300 字符", async () => {
    const { parse, validate } = await loadFresh();
    const long = `${"Parse error:".padEnd(300, "x")}TAIL-BEYOND-300`;
    parse.mockRejectedValue(new Error(long));
    const r = await validate("flowchart TD\n  bad");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe(long.slice(0, 300));
      expect(r.error).not.toContain("TAIL-BEYOND-300");
    }
  });

  it("initialize 模块级只跑一次:多次校验不重复初始化", async () => {
    const { parse, init, validate } = await loadFresh();
    parse.mockResolvedValue({ diagramType: "flowchart", config: {} });
    await validate("flowchart TD\n  A --> B");
    await validate("flowchart TD\n  C --> D");
    expect(init).toHaveBeenCalledTimes(1);
  });

  it("非字符串 / 空白 source 直接拒绝,不触 mermaid", async () => {
    const { parse, validate } = await loadFresh();
    expect((await validate(undefined)).ok).toBe(false);
    expect((await validate("   ")).ok).toBe(false);
    expect(parse).not.toHaveBeenCalled();
  });
});
