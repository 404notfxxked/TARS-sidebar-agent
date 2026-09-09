// 长期记忆注入规划单测(shared/memory,面板与后台共用同一套):
// token 粗估公式 / 置顶优先+最近更新优先 / 预算裁剪的不变式 / 跳过大条目继续装小的。
// 此前只有 verify-memory T3 的 e2e 覆盖裁剪结果,这里把规划本身钉死。

import { describe, expect, it } from "vitest";
import {
  MEMORY_BUDGET_TOKENS,
  MEMORY_PREAMBLE,
  estimateTokens,
  memoryUsedTokens,
  planMemoryInjection,
} from "./memory";

const item = (text: string, pinned = false, updatedAt = 0) => ({
  text,
  pinned,
  updatedAt,
});

describe("estimateTokens", () => {
  it("西文按 4 字符/token 向上取整", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("CJK 按 1.1 token/字向上取整", () => {
    expect(estimateTokens("中文了")).toBe(4); // 3.3 → 4
  });

  it("混合文本分开计", () => {
    // 1 CJK(1.1)+ 2 西文(0.5)= 1.6 → 2
    expect(estimateTokens("中ab")).toBe(2);
  });
});

describe("planMemoryInjection", () => {
  it("空列表", () => {
    expect(planMemoryInjection([])).toEqual({ kept: [], dropped: [] });
  });

  it("置顶优先于最近更新(排序键:pinned 先,updatedAt 后)", () => {
    const { kept } = planMemoryInjection([
      item("新的普通条目", false, 200),
      item("旧的置顶条目", true, 100),
    ]);
    expect(kept.map((r) => r.text)).toEqual(["旧的置顶条目", "新的普通条目"]);
  });

  it("同优先级按 updatedAt 降序", () => {
    const { kept } = planMemoryInjection([
      item("旧", false, 1),
      item("新", false, 2),
    ]);
    expect(kept.map((r) => r.text)).toEqual(["新", "旧"]);
  });

  it("预算不变式:kept 全装下;放回任一条 dropped 就超预算", () => {
    // 30 条中等长度(400 西文字符 ≈ 104 token/条),总占用必然超 600 预算
    const items = Array.from({ length: 30 }, (_, i) =>
      item(`item ${i}: ${"x".repeat(400)}`, i < 3, 1_000 - i),
    );
    const { kept, dropped } = planMemoryInjection(items);

    // 裸和(不走 memoryUsedTokens —— 它内部会先规划,把放回的条目再裁掉)
    const rawUsed = (rows: ReturnType<typeof item>[]) =>
      estimateTokens(MEMORY_PREAMBLE) +
      rows.reduce((s, r) => s + estimateTokens(`・${r.text}`), 0);

    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length + dropped.length).toBe(items.length);
    expect(rawUsed(kept)).toBeLessThanOrEqual(MEMORY_BUDGET_TOKENS);
    for (const d of dropped) {
      expect(rawUsed([...kept, d])).toBeGreaterThan(MEMORY_BUDGET_TOKENS);
    }
  });

  it("装不下的大条目被跳过,更小的后续条目继续装", () => {
    const huge = item(`huge ${"x".repeat(4_000)}`, false, 300); // ≈1001 token,必超预算
    const small = item("small", false, 200);
    const { kept, dropped } = planMemoryInjection([huge, small]);
    expect(kept.map((r) => r.text)).toEqual(["small"]);
    expect(dropped.map((r) => r.text)).toEqual([huge.text]);
  });
});

describe("memoryUsedTokens", () => {
  it("= 头部纪律开销 + 每条 ・前缀文本之和", () => {
    const items = [item("中文条目", true, 1), item("latin only", false, 2)];
    const expected =
      estimateTokens(MEMORY_PREAMBLE) +
      estimateTokens("・中文条目") +
      estimateTokens("・latin only");
    expect(memoryUsedTokens(items)).toBe(expected);
  });

  it("入参超预算时先规划再计数(返回的是装得下的部分,不是裸和)", () => {
    const items = Array.from({ length: 30 }, (_, i) =>
      item(`item ${i}: ${"x".repeat(400)}`, false, 1_000 - i),
    );
    expect(memoryUsedTokens(items)).toBeLessThanOrEqual(MEMORY_BUDGET_TOKENS);
  });
});
