// 模型能力目录单测:预填合成与启发式(纯函数,无 chrome 依赖)。
// loadCatalog 依赖 chrome.runtime/fetch,属面板接线,不做单测。

import { describe, expect, it } from "vitest";
import {
  backfillEntry,
  inferReasoning,
  prefillEntry,
  thinkingOptionsOf,
  type Catalog,
} from "./modelCatalog";
import type { ModelEntry } from "./configStore";

describe("inferReasoning(id 启发式:只报肯定,不猜否定)", () => {
  it.each([
    "deepseek-reasoner",
    "deepseek-reasoner-v2",
    "o3",
    "o3-mini",
    "openai/o3-mini:free",
    "qwen3-235b-a22b-thinking",
    "glm-4.5-thinking",
    "gemini-2.5-flash-thinking-preview",
  ])("%s → true", (id) => {
    expect(inferReasoning(id)).toBe(true);
  });

  it.each([
    "deepseek-chat",
    "deepseek-v4-flash",
    "gpt-4o",
    "gpt-5",
    "claude-sonnet-4",
    "glm-4.5",
    "mistral-large-latest",
  ])("%s → undefined(未知不猜)", (id) => {
    expect(inferReasoning(id)).toBeUndefined();
  });
});

describe("prefillEntry(目录 → 启发式 → 留空)", () => {
  const cat: Catalog = {
    models: {
      // 目录全字段命中
      "deepseek-v4-flash": { ctx: 1000000, r: 1 },
      // 目录明确否定推理(负面标记也是信息)
      "gpt-4o": { ctx: 128000, r: 0, v: 1 },
      // 目录只有窗口
      "some-model": { ctx: 32000 },
      // 目录负面标记与启发式冲突:启发式肯定优先(聚合站对旧 id 的
      // 数据可能陈旧,先例 deepseek-reasoner 被聚合站标 0)
      "deepseek-reasoner": { ctx: 128000, r: 0 },
    },
  };

  it("目录命中:窗口/推理预填,无图像输入不给视觉", () => {
    expect(prefillEntry(cat, "deepseek-v4-flash")).toEqual({
      contextTokens: 1000000,
      reasoning: true,
    });
  });

  it("目录否定推理 → 预填 false;视觉命中预填 true", () => {
    expect(prefillEntry(cat, "gpt-4o")).toEqual({
      contextTokens: 128000,
      reasoning: false,
      vision: true,
    });
  });

  it("目录只有窗口 → 其余留空", () => {
    expect(prefillEntry(cat, "some-model")).toEqual({ contextTokens: 32000 });
  });

  it("目录未命中 → 全空(不猜)", () => {
    expect(prefillEntry(cat, "unknown-model")).toEqual({});
  });

  it("启发式肯定压过目录负面标记(陈旧聚合数据先例)", () => {
    expect(prefillEntry(cat, "deepseek-reasoner")).toEqual({
      contextTokens: 128000,
      reasoning: true,
    });
  });

  it("目录未命中但启发式命中 → 只给推理标记", () => {
    expect(prefillEntry({ models: {} }, "o3-mini")).toEqual({
      reasoning: true,
    });
  });
});

describe("backfillEntry(已有条目:只补缺失,绝不覆盖手动值)", () => {
  const cat: Catalog = {
    models: {
      "deepseek-v4-flash": { ctx: 1000000, r: 1 },
      "gpt-4o": { ctx: 128000, r: 0, v: 1 },
      "deepseek-reasoner": { ctx: 128000, r: 0 },
    },
  };

  it("全空的已有条目:窗口/推理/视觉都回填", () => {
    expect(backfillEntry(cat, "deepseek-v4-flash", { id: "deepseek-v4-flash" })).toEqual({
      id: "deepseek-v4-flash",
      contextTokens: 1000000,
      reasoning: true,
    });
  });

  it("手动设过的字段不覆盖(窗口数值/显式 false 都尊重)", () => {
    const entry: ModelEntry = {
      id: "gpt-4o",
      contextTokens: 999,
      reasoning: false,
      vision: false,
    };
    expect(backfillEntry(cat, "gpt-4o", entry)).toEqual(entry);
  });

  it("contextTokens 显式 0 = 用户主动清空,不回填;推理 undefined 回填 true", () => {
    expect(
      backfillEntry(cat, "deepseek-v4-flash", {
        id: "deepseek-v4-flash",
        contextTokens: 0,
      }),
    ).toEqual({ id: "deepseek-v4-flash", contextTokens: 0, reasoning: true });
  });

  it("目录负面标记不对已有条目回填(只写正面信息);启发式肯定会回填", () => {
    expect(
      backfillEntry({ models: {} }, "deepseek-reasoner", {
        id: "deepseek-reasoner",
      }),
    ).toEqual({ id: "deepseek-reasoner", reasoning: true });
  });

  it("目录未命中 → 原样返回(字段引用不变)", () => {
    const entry: ModelEntry = { id: "no-such", alias: "x" };
    expect(backfillEntry({ models: {} }, "no-such", entry)).toEqual(entry);
  });
});

describe("thinkingOptionsOf(思考档位选项,null = 不显示入口)", () => {
  it("effort 档位原样给出(无 toggle → 无关选项)", () => {
    expect(
      thinkingOptionsOf(
        { models: { "glm-5.3": { ro: ["low", "high", "max"] } } },
        "glm-5.3",
      ),
    ).toEqual(["low", "high", "max"]);
  });

  it("toggle → off 在首位,排在 effort 档位之前", () => {
    expect(
      thinkingOptionsOf(
        {
          models: {
            "deepseek-flash": { ro: ["toggle", "low", "high", "max"] },
          },
        },
        "deepseek-flash",
      ),
    ).toEqual(["off", "low", "high", "max"]);
  });

  it("纯开关模型 → 只有 off", () => {
    expect(
      thinkingOptionsOf({ models: { "glm-4.5": { ro: ["toggle"] } } }, "glm-4.5"),
    ).toEqual(["off"]);
  });

  it("effort 里的 none 语义同关,并入 off 去重", () => {
    expect(
      thinkingOptionsOf(
        {
          models: {
            x: { ro: ["toggle", "none", "low", "high"] },
            y: { ro: ["none", "low"] },
          },
        },
        "x",
      ),
    ).toEqual(["off", "low", "high"]);
    expect(
      thinkingOptionsOf(
        { models: { y: { ro: ["none", "low"] } } },
        "y",
      ),
    ).toEqual(["off", "low"]);
  });

  it("无 ro / 空 ro → null(不显示入口)", () => {
    expect(thinkingOptionsOf({ models: { a: {} } }, "a")).toBeNull();
    expect(thinkingOptionsOf({ models: { b: { ro: [] } } }, "b")).toBeNull();
    expect(thinkingOptionsOf({ models: {} }, "c")).toBeNull();
  });
});
