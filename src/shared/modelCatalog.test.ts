// 模型能力目录单测:预填合成与启发式(纯函数,无 chrome 依赖)。
// loadCatalog 依赖 chrome.runtime/fetch,属面板接线,不做单测。

import { describe, expect, it } from "vitest";
import {
  backfillEntry,
  defaultThinkingEffort,
  inferReasoning,
  mergeFetchedModels,
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

describe("mergeFetchedModels(获取列表合并:预填/回填 + 漂移标记)", () => {
  const cat: Catalog = {
    models: {
      "deepseek-chat": { ctx: 64000 },
      "deepseek-reasoner": { ctx: 128000, r: 1 },
    },
  };

  it("新 id 预填且不标;本地独有(含手动添加)标 unlisted;结果按 id 排序", () => {
    const next = mergeFetchedModels(
      [{ id: "z-local" }, { id: "a-manual" }],
      ["deepseek-reasoner"],
      cat,
    );
    expect(next.map((m) => m.id)).toEqual([
      "a-manual",
      "deepseek-reasoner",
      "z-local",
    ]);
    expect(next[1]).toEqual({
      id: "deepseek-reasoner",
      contextTokens: 128000,
      reasoning: true,
    });
    expect(next.map((m) => m.unlisted)).toEqual([true, undefined, true]);
  });

  it("重新在列:上次的 unlisted 摘除,回填照常、其余字段不丢", () => {
    const next = mergeFetchedModels(
      [{ id: "deepseek-chat", alias: "对话", unlisted: true }],
      ["deepseek-chat"],
      cat,
    );
    expect(next).toEqual([
      { id: "deepseek-chat", alias: "对话", contextTokens: 64000 },
    ]);
  });

  it("已有标记的本地独有条目原引用透传;在列条目经回填换新对象(值不变)", () => {
    const flagged: ModelEntry = { id: "gone", unlisted: true };
    const plain: ModelEntry = { id: "kept" };
    const next = mergeFetchedModels([flagged, plain], ["kept"], cat);
    expect(next[0]).toBe(flagged);
    expect(next[1]).not.toBe(plain);
    expect(next[1]).toEqual(plain);
  });

  it("官方返回空列表:整体不动(空响应不构成漂移信号,防端点半残全标)", () => {
    const existing: ModelEntry[] = [
      { id: "b", unlisted: true },
      { id: "a" },
    ];
    expect(mergeFetchedModels(existing, [], { models: {} })).toBe(existing);
  });

  it("手动添加的模型被官方列表命中:回填且不标(在列即无漂移)", () => {
    const next = mergeFetchedModels(
      [{ id: "deepseek-chat" }],
      ["deepseek-chat"],
      cat,
    );
    expect(next[0].unlisted).toBeUndefined();
    expect(next[0].contextTokens).toBe(64000);
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

  it("纯开关模型 → 关 + 开", () => {
    expect(
      thinkingOptionsOf({ models: { "glm-4.5": { ro: ["toggle"] } } }, "glm-4.5"),
    ).toEqual(["off", "on"]);
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

describe("defaultThinkingEffort(未设置时发送的折中默认档)", () => {
  const cat: Catalog = {
    models: {
      "glm-5.3": { ro: ["low", "high", "max"] },
      "gpt-5": { ro: ["minimal", "low", "medium", "high"] },
      "gemini-3.8-flash": { ro: ["low", "medium", "high"] },
      "glm-5.2": { ro: ["high", "max"] },
      "glm-4.5": { ro: ["toggle"] },
      "no-ro": {},
    },
  };

  it("三档取正中([low,high,max] → high)", () => {
    expect(defaultThinkingEffort(cat, "glm-5.3")).toBe("high");
  });

  it("四档取中间偏高一档([minimal,low,medium,high] → medium)", () => {
    expect(defaultThinkingEffort(cat, "gpt-5")).toBe("medium");
  });

  it("三档等距([low,medium,high] → medium)", () => {
    expect(defaultThinkingEffort(cat, "gemini-3.8-flash")).toBe("medium");
  });

  it("两档取较低档(默认宁慢于超支:[high,max] → high)", () => {
    expect(defaultThinkingEffort(cat, "glm-5.2")).toBe("high");
  });

  it("纯开关模型 → \"on\"(显式开,与「关」对应)", () => {
    expect(defaultThinkingEffort(cat, "glm-4.5")).toBe("on");
  });

  it("无目录数据 → undefined", () => {
    expect(defaultThinkingEffort(cat, "no-such")).toBeUndefined();
    expect(defaultThinkingEffort(cat, "no-ro")).toBeUndefined();
  });
});
