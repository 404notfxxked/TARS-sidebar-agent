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
