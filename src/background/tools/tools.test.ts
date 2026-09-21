// 工具注册表单测:write 标记 × 确认门 CONFIRM_TOOLS 的双向不变式。
// 这是 AGENTS.md 硬规则 15②(「新增写工具先入集合再上线」)的机械保障:
// - 往注册表加写工具忘了入 CONFIRM_TOOLS → 第一条红;
// - 入了 CONFIRM_TOOLS 但没在工具上标 write → 第二条红。
// 两个方向都红,注册表与确认门就不可能漂移。
// web_fetch 有意不标 write:是否过门是参数级判定(私网目标/白名单,
// outboundGuard 的 webFetchNeedsConfirm),由 confirmations.test.ts 的
// needsConfirmation 路径覆盖,不属于「静态写工具」。MCP 动态工具不在
// 内置注册表,同样不参与本不变式(needsConfirmation 对 mcp_ 前缀一律过门)。

import { describe, expect, it } from "vitest";
import { listTools } from "./tools";
import { CONFIRM_TOOLS } from "../agent/confirmations";

describe("write 标记 × CONFIRM_TOOLS 双向一致(硬规则 15②)", () => {
  const tools = listTools();
  const writeTools = tools.filter((t) => t.write === true).map((t) => t.name);

  it("注册表非空(import 期成功 + 健全性)", () => {
    expect(tools.length).toBeGreaterThan(0);
  });

  it("标了 write === true 的内置工具必须在 CONFIRM_TOOLS 里", () => {
    expect(writeTools.length).toBeGreaterThan(0);
    for (const name of writeTools) {
      expect(
        CONFIRM_TOOLS.has(name),
        `${name} 标了 write 却不在 CONFIRM_TOOLS —— 写工具必须先过确认门再上线`,
      ).toBe(true);
    }
  });

  it("CONFIRM_TOOLS 里的每个名字都是注册表中 write === true 的内置工具", () => {
    expect(writeTools).toEqual(expect.arrayContaining([...CONFIRM_TOOLS]));
    for (const name of CONFIRM_TOOLS) {
      expect(
        writeTools,
        `${name} 在 CONFIRM_TOOLS 里却没标 write(或不是内置工具)`,
      ).toContain(name);
    }
  });

  it("scroll_page 显式不过门(非破坏性页面状态变更,既有决定)", () => {
    expect(tools.find((t) => t.name === "scroll_page")?.write).toBe(false);
    expect(CONFIRM_TOOLS.has("scroll_page")).toBe(false);
  });
});
