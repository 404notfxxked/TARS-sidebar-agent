import { describe, expect, it } from "vitest";
import {
  MAX_PARALLEL_TOOLS,
  partitionToolBatches,
} from "./toolBatch";

const calls = (...names: string[]) => names.map((name) => ({ name }));

describe("partitionToolBatches", () => {
  it("空输入 → 无批次", () => {
    expect(partitionToolBatches([])).toEqual([]);
  });

  it("单个只读工具自成一批", () => {
    expect(partitionToolBatches(calls("page_read"))).toEqual([
      [{ name: "page_read" }],
    ]);
  });

  it("相邻只读工具并入同批,保持原始顺序", () => {
    expect(partitionToolBatches(calls("page_outline", "page_find"))).toEqual([
      [{ name: "page_outline" }, { name: "page_find" }],
    ]);
  });

  it("写工具与未知(MCP)工具自成单批,不并入相邻只读批", () => {
    expect(
      partitionToolBatches(calls("page_read", "click_element", "mcp__search")),
    ).toEqual([
      [{ name: "page_read" }],
      [{ name: "click_element" }],
      [{ name: "mcp__search" }],
    ]);
  });

  it("只读 / 写 / 只读 交错时按相邻关系切三批", () => {
    expect(
      partitionToolBatches(calls("web_search", "fill_input", "web_fetch")),
    ).toEqual([
      [{ name: "web_search" }],
      [{ name: "fill_input" }],
      [{ name: "web_fetch" }],
    ]);
  });

  it(`批内上限 ${MAX_PARALLEL_TOOLS}:超出部分开新批`, () => {
    const batches = partitionToolBatches(
      calls("page_read", "page_find", "get_tabs", "page_outline", "web_search"),
    );
    expect(batches).toEqual([
      [
        { name: "page_read" },
        { name: "page_find" },
        { name: "get_tabs" },
      ],
      [{ name: "page_outline" }, { name: "web_search" }],
    ]);
  });

  it("find_elements 是只读观察,可并行", () => {
    expect(
      partitionToolBatches(calls("find_elements", "page_read")),
    ).toEqual([[{ name: "find_elements" }, { name: "page_read" }]]);
  });
});

describe("partitionToolBatches 屏障谓词(确认门单槽约束)", () => {
  const withArgs = (...specs: [name: string, gated: boolean][]) =>
    specs.map(([name, gated], i) => ({
      name,
      args: { url: `https://x.test/${i}` },
      gated,
    }));
  const barrier = (c: { gated: boolean }) => c.gated;

  it("屏障调用自成单批:同轮两个过门 fetch 不并批", () => {
    const list = withArgs(["web_fetch", true], ["web_fetch", true]);
    expect(partitionToolBatches(list, barrier)).toEqual([[list[0]], [list[1]]]);
  });

  it("屏障打断相邻只读工具的并批:确认应答之间不夹带并发副作用", () => {
    const list = withArgs(
      ["web_search", false],
      ["web_fetch", true],
      ["page_read", false],
      ["web_fetch", true],
      ["web_search", false],
    );
    expect(partitionToolBatches(list, barrier)).toEqual([
      [list[0]],
      [list[1]],
      [list[2]],
      [list[3]],
      [list[4]],
    ]);
  });

  it("未过门的同族调用不受屏障牵连:全开时照常并批", () => {
    const allOpen = withArgs(["web_fetch", false], ["web_fetch", false]);
    expect(partitionToolBatches(allOpen, barrier)).toEqual([allOpen]);
  });

  it("过门与未过门交错时各自成批(按 args 判定,不按工具名)", () => {
    const list = withArgs(["web_fetch", true], ["web_fetch", false]);
    expect(partitionToolBatches(list, barrier)).toEqual([[list[0]], [list[1]]]);
  });

  it("谓词缺省时行为与只按并行集划分完全一致(向后兼容)", () => {
    const list = withArgs(["web_fetch", true], ["web_fetch", true]);
    expect(partitionToolBatches(list)).toEqual([list]);
  });
});
