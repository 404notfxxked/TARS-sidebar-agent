// 长期记忆注入规划单测(shared/memory,面板与后台共用同一套):
// token 粗估公式 / 置顶优先+最近更新优先 / 预算裁剪的不变式 / 跳过大条目继续装小的 /
// 动态预算(按 contextTokens 缩放)/ 裁剪尾注。此前只有 verify-memory T3 的 e2e
// 覆盖裁剪结果,这里把规划本身钉死。

import { describe, expect, it } from "vitest";
import {
  MEMORY_BUDGET_TOKENS,
  MEMORY_PREAMBLE,
  estimateTokens,
  isMemoryCard,
  memoryBudgetTokens,
  memoryFooterText,
  memoryInjectionLines,
  memoryLine,
  memoryShortId,
  memoryUsedTokens,
  planMemoryInjection,
  resolveMemoryRef,
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

  it("预算不变式:kept 全装下;放回任一条 dropped 就超装箱预算", () => {
    // 30 条中等长度(400 西文字符 ≈ 104 token/条),总占用必然超 600 预算。
    // 装箱预算 = 总预算 − 尾注预留(规划时先扣,保证「头注+条目+尾注」≤ 预算)
    const items = Array.from({ length: 30 }, (_, i) =>
      item(`item ${i}: ${"x".repeat(400)}`, i < 3, 1_000 - i),
    );
    const { kept, dropped } = planMemoryInjection(items);
    const packingBudget =
      MEMORY_BUDGET_TOKENS - estimateTokens(memoryFooterText(999));

    // 裸和(不走 memoryUsedTokens —— 它内部会先规划,把放回的条目再裁掉)
    const rawUsed = (rows: ReturnType<typeof item>[]) =>
      estimateTokens(MEMORY_PREAMBLE) +
      rows.reduce((s, r) => s + estimateTokens(`・${r.text}`), 0);

    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length + dropped.length).toBe(items.length);
    expect(rawUsed(kept)).toBeLessThanOrEqual(packingBudget);
    for (const d of dropped) {
      expect(rawUsed([...kept, d])).toBeGreaterThan(packingBudget);
    }
  });

  it("装不下的大条目被跳过,更小的后续条目继续装", () => {
    const huge = item(`huge ${"x".repeat(4_000)}`, false, 300); // ≈1001 token,必超预算
    const small = item("small", false, 200);
    const { kept, dropped } = planMemoryInjection([huge, small]);
    expect(kept.map((r) => r.text)).toEqual(["small"]);
    expect(dropped.map((r) => r.text)).toEqual([huge.text]);
  });

  it("段头成本计入预留:整块(头注+段头+条目+尾注)不破注入预算", () => {
    // 120 条等行价(每行 ≈6 token)的交错卡片/简条把装箱逼到边界:
    // 若段头成本没计入预留,装箱会多塞 ~5 token,本断言必红 —— 有牙。
    // 行价对齐:卡片「・[ccccNNNN] kN: x」与简条「・[nnnnNNNN] xxxxx」同 17 字符
    const rows = Array.from({ length: 120 }, (_, i) =>
      i % 2 === 0
        ? {
            id: `cccc${String(i).padStart(4, "0")}-1111`,
            text: "x",
            key: `k${i}`,
            pinned: false,
            updatedAt: i,
          }
        : {
            id: `nnnn${String(i).padStart(4, "0")}-1111`,
            text: "xxxxx",
            pinned: false,
            updatedAt: i,
          },
    );
    const { kept } = planMemoryInjection(rows);
    const lines = memoryInjectionLines(kept);
    expect(lines).toContain("[profile]");
    expect(lines).toContain("[notes]");
    const total =
      estimateTokens(MEMORY_PREAMBLE) +
      lines.reduce((s, l) => s + estimateTokens(l), 0) +
      estimateTokens(memoryFooterText(999));
    expect(total).toBeLessThanOrEqual(memoryBudgetTokens());
  });
});

describe("卡片态:优先级 / 行渲染 / 两段式", () => {
  const card = (
    text: string,
    key: string,
    subject?: string,
    pinned = false,
    updatedAt = 0,
  ) => ({ text, key, subject, pinned, updatedAt });

  it("isMemoryCard:有 key 即卡片,空串/缺省为简条", () => {
    expect(isMemoryCard({ key: "diet" })).toBe(true);
    expect(isMemoryCard({ key: "" })).toBe(false);
    expect(isMemoryCard({})).toBe(false);
  });

  it("卡片行渲染 key: text,非本人 subject 加前缀;简条保持原文", () => {
    expect(memoryLine({ text: "不吃香菜", key: "diet", pinned: false, updatedAt: 0 })).toBe(
      "・diet: 不吃香菜",
    );
    expect(
      memoryLine({
        text: "花生过敏",
        key: "allergy",
        subject: "女儿",
        pinned: false,
        updatedAt: 0,
      }),
    ).toBe("・(女儿) allergy: 花生过敏");
    expect(memoryLine({ text: "喜欢简洁回答", pinned: false, updatedAt: 0 })).toBe(
      "・喜欢简洁回答",
    );
  });

  it("注入行带短 id 前缀:模型看得见的引用锚(replaceOf/delete 按 id)", () => {
    const row = { id: "a1b2c3d4-1111-2222-3333-444444444444" };
    expect(
      memoryLine({ ...row, text: "不吃香菜", key: "diet", pinned: false, updatedAt: 0 }),
    ).toBe("・[a1b2c3d4] diet: 不吃香菜");
    expect(
      memoryLine({ ...row, text: "喜欢简洁回答", pinned: false, updatedAt: 0 }),
    ).toBe("・[a1b2c3d4] 喜欢简洁回答");
    expect(memoryShortId(row.id)).toBe("a1b2c3d4");
  });

  it("排序:置顶 > 卡片 > 简条(同级再按最近更新)", () => {
    const { kept } = planMemoryInjection([
      item("新简条", false, 300),
      card("旧卡片", "diet", undefined, false, 200),
      item("旧简条", true, 100),
    ]);
    expect(
      kept.map((r) => ("key" in r && r.key ? `卡:${r.key}` : `条:${r.text}`)),
    ).toEqual(["条:旧简条", "卡:diet", "条:新简条"]);
  });

  it("两段式:卡片与简条混合时加段头,单一形态不加(存量格式逐字节不变)", () => {
    const mixed = memoryInjectionLines([
      { text: "偏好简洁", key: "style", pinned: false, updatedAt: 2 }, // i18n-ok:记忆条目测试种子,与占位符示例同文非 UI 断言
      { text: "女儿爱吃甜食", pinned: false, updatedAt: 1 },
    ]);
    expect(mixed).toEqual([
      "[profile]",
      "・style: 偏好简洁",
      "[notes]",
      "・女儿爱吃甜食",
    ]);
    expect(
      memoryInjectionLines([{ text: "只有简条", pinned: false, updatedAt: 0 }]),
    ).toEqual(["・只有简条"]);
    expect(
      memoryInjectionLines([
        { text: "只有卡片", key: "diet", pinned: false, updatedAt: 0 },
      ]),
    ).toEqual(["・diet: 只有卡片"]);
  });
});

describe("resolveMemoryRef:模型引用 → 库内条目(replaceOf/delete 按 id 共用)", () => {
  const rows = [
    { id: "aaaaaaaa-1111", text: "甲" },
    { id: "aaaaaaaa-2222", text: "乙" },
    { id: "bbbbbbbb-3333", text: "丙" },
  ];

  it("完整 id 精确命中", () => {
    expect(resolveMemoryRef(rows, "aaaaaaaa-2222")?.text).toBe("乙");
  });

  it("唯一短前缀命中(注入行里只露 8 位)", () => {
    expect(resolveMemoryRef(rows, "bbbbbbbb")?.text).toBe("丙");
  });

  it("前缀歧义不猜测:报出候选数,让模型换更长的前缀", () => {
    expect(() => resolveMemoryRef(rows, "aaaaaaaa")).toThrow(
      /2 entries|匹配到 2 条/,
    );
  });

  it("未命中返回 null(调用方决定报错文案)", () => {
    expect(resolveMemoryRef(rows, "cccccccc")).toBeNull();
    expect(resolveMemoryRef(rows, "")).toBeNull();
  });
});

describe("memoryBudgetTokens", () => {
  it("未配置/0 → 兜底 600(不猜窗口,存量行为不变)", () => {
    expect(memoryBudgetTokens()).toBe(MEMORY_BUDGET_TOKENS);
    expect(memoryBudgetTokens(0)).toBe(MEMORY_BUDGET_TOKENS);
  });

  it("小窗按 1% 但保底 200(Ollama 默认 4K 下 600 会占 15%)", () => {
    expect(memoryBudgetTokens(4096)).toBe(200);
    expect(memoryBudgetTokens(8192)).toBe(200);
  });

  it("常规窗口按 1% 缩放", () => {
    expect(memoryBudgetTokens(32768)).toBe(328);
    expect(memoryBudgetTokens(131072)).toBe(1311);
  });

  it("大窗封顶 2000:注意力纪律护栏 + agent loop 每请求携带的成本乘数", () => {
    expect(memoryBudgetTokens(200000)).toBe(2000);
    expect(memoryBudgetTokens(1_000_000)).toBe(2000);
  });

  it("预算随窗口生效:同一批条目,小窗裁得比大窗狠", () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      item(`item ${i}: ${"x".repeat(400)}`, false, 1_000 - i),
    );
    const big = planMemoryInjection(items, 200_000);
    const small = planMemoryInjection(items, 4_096);
    expect(big.kept.length).toBeGreaterThan(small.kept.length);
    expect(small.dropped.length).toBeGreaterThan(0);
  });
});

describe("memoryFooterText / 裁剪尾注", () => {
  it("单复数", () => {
    expect(memoryFooterText(1)).toBe("(+1 older entry not shown)");
    expect(memoryFooterText(3)).toBe("(+3 older entries not shown)");
  });

  it("有条目被裁时,面板估算含尾注开销,整体仍不破预算(尾注走预留)", () => {
    const items = Array.from({ length: 30 }, (_, i) =>
      item(`item ${i}: ${"x".repeat(400)}`, false, 1_000 - i),
    );
    const { kept, dropped } = planMemoryInjection(items);
    expect(dropped.length).toBeGreaterThan(0);
    expect(memoryUsedTokens(items)).toBe(
      estimateTokens(MEMORY_PREAMBLE) +
        kept.reduce((s, r) => s + estimateTokens(`・${r.text}`), 0) +
        estimateTokens(memoryFooterText(dropped.length)),
    );
    expect(memoryUsedTokens(items)).toBeLessThanOrEqual(MEMORY_BUDGET_TOKENS);
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
