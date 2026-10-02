// configStore 读时迁移单测:旧版单供应商字段合成 providers / 旧版搜索单槽
// 串 key 的弃用策略 / 非法输入回落缺省。迁移是「读时进行、不写回」,
// 所以直接喂 chrome.storage 桩再 loadConfig,断言返回的投影。

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectLocale,
  loadConfig,
  normalizeSearch,
  saveConfirmLevel,
} from "./configStore";

afterEach(() => {
  vi.unstubAllGlobals();
});

type Bag = Record<string, unknown>;
const storage = () =>
  (globalThis as Record<string, any>).chrome.storage.local as {
    set: (o: Bag) => Promise<void>;
    clear: () => Promise<void>;
  };

describe("normalizeSearch(旧版单槽 → 分槽,串 key bug 的迁移策略)", () => {
  it("旧版扁平结构:provider 选择保留,旧 key/中转不猜归属、直接弃用", () => {
    const cfg = normalizeSearch({
      provider: "bocha",
      baseUrl: "https://middleman.example.com",
      apiKey: "somebody-old-key",
    });
    expect(cfg.provider).toBe("bocha");
    for (const id of ["tavily", "bocha", "brave"] as const) {
      expect(cfg.services[id]).toEqual({ baseUrl: "", apiKey: "" });
    }
  });

  it("分槽结构原样保留", () => {
    const cfg = normalizeSearch({
      provider: "tavily",
      services: {
        tavily: { baseUrl: "", apiKey: "tvly-1" },
        bocha: { baseUrl: "", apiKey: "bocha-2" },
        brave: { baseUrl: "", apiKey: "" },
      },
    });
    expect(cfg.provider).toBe("tavily");
    expect(cfg.services.tavily.apiKey).toBe("tvly-1");
    expect(cfg.services.bocha.apiKey).toBe("bocha-2");
    expect(cfg.services.brave.apiKey).toBe("");
  });

  it("非法 provider 回落 auto(免 Key 抓取兜底)", () => {
    expect(normalizeSearch({ provider: "bogus" }).provider).toBe("auto");
    expect(normalizeSearch(undefined).provider).toBe("auto");
  });

  it("字段类型不对的槽位值丢弃,不抛错", () => {
    const cfg = normalizeSearch({
      services: { tavily: { apiKey: 42 }, bocha: "junk" },
    });
    expect(cfg.services.tavily).toEqual({ baseUrl: "", apiKey: "" });
    expect(cfg.services.bocha).toEqual({ baseUrl: "", apiKey: "" });
  });
});

describe("loadConfig 读时迁移", () => {
  it("旧版单供应商字段(无 providers 键)→ 合成一个 p0 条目,host 取 baseUrl 域名", async () => {
    await storage().set({
      baseUrl: "https://api.deepseek.com/v1", // i18n-ok:迁移测试 wire 种子,非 UI 断言
      apiKey: "sk-legacy",
      model: "deepseek-chat",
      maxContextTokens: 65536,
    });
    const cfg = await loadConfig();
    expect(cfg.providers).toEqual([
      {
        id: "p0",
        name: "api.deepseek.com",
        baseUrl: "https://api.deepseek.com/v1", // i18n-ok:wire 端点常量,非 UI 断言
        apiKey: "sk-legacy",
        models: [{ id: "deepseek-chat", contextTokens: 65536 }],
      },
    ]);
    expect(cfg.modelProvider).toBe("p0");
    expect(cfg.model).toBe("deepseek-chat");
  });

  it("providers 键在:新 schema 原样用,旧字段整体废弃", async () => {
    await storage().set({
      providers: [
        {
          id: "p1",
          name: "Prov",
          baseUrl: "https://p1.example.com/v1",
          apiKey: "sk-1",
          models: [{ id: "m1" }],
        },
      ],
      modelProvider: "p1",
      model: "m1",
      // 旧字段残留,不应再被合成
      baseUrl: "https://legacy.example.com/v1",
      apiKey: "sk-legacy",
    });
    const cfg = await loadConfig();
    expect(cfg.providers).toHaveLength(1);
    expect(cfg.providers[0].id).toBe("p1");
    expect(cfg.providers[0].apiKey).toBe("sk-1");
  });

  it("providers 里的非法条目被过滤(缺 apiKey/baseUrl/models)", async () => {
    await storage().set({
      providers: [
        { id: "bad", name: "x" },
        {
          id: "ok",
          name: "Good",
          baseUrl: "https://ok.example.com",
          apiKey: "sk",
          models: [{ id: "m" }],
        },
      ],
    });
    const cfg = await loadConfig();
    expect(cfg.providers.map((p) => p.id)).toEqual(["ok"]);
    expect(cfg.modelProvider).toBe("ok");
  });

  it("modelProvider 指向不存在的供应商时回落第一个", async () => {
    await storage().set({
      providers: [
        {
          id: "only",
          name: "Only",
          baseUrl: "https://x.example.com",
          apiKey: "sk",
          models: [{ id: "m" }],
        },
      ],
      modelProvider: "ghost",
    });
    expect((await loadConfig()).modelProvider).toBe("only");
  });

  it("providers 的 kind 协议字段:合法值保留,非法值丢弃该键(不猜不改写)", async () => {
    await storage().set({
      providers: [
        {
          id: "ant",
          name: "A",
          baseUrl: "https://a.example.com/v1",
          apiKey: "k1",
          kind: "anthropic-messages",
          models: [],
        },
        {
          id: "junk",
          name: "B",
          baseUrl: "https://b.example.com/v1",
          apiKey: "k2",
          kind: "bogus-protocol",
          models: [],
        },
      ],
      modelProvider: "ant",
    });
    const cfg = await loadConfig();
    expect(cfg.providers[0].kind).toBe("anthropic-messages");
    expect(cfg.providers[1].kind).toBeUndefined();
  });

  it("无 kind 字段的旧配置原样消费(缺省 chat-completions,零迁移)", async () => {
    await storage().set({
      providers: [
        {
          id: "p1",
          name: "Prov",
          baseUrl: "https://p1.example.com/v1",
          apiKey: "sk-1",
          models: [{ id: "m1" }],
        },
      ],
      modelProvider: "p1",
      model: "m1",
    });
    const cfg = await loadConfig();
    expect(cfg.providers[0]).not.toHaveProperty("kind", "chat-completions");
    expect(cfg.providers[0].kind).toBeUndefined();
  });

  it("缺省值:联网关、记忆开、保留 7 天、standard 档、zh-CN、green", async () => {
    // navigator 缺席(无法探测)时 locale 落缺省 zh-CN,存量行为不变
    vi.stubGlobal("navigator", {});
    const cfg = await loadConfig();
    expect(cfg.webSearch).toBe(false);
    expect(cfg.memory).toBe(true);
    expect(cfg.historyRetention).toBe(7);
    expect(cfg.compact).toBe("standard");
    expect(cfg.locale).toBe("zh-CN");
    expect(cfg.accent).toBe("green");
    expect(cfg.theme).toBe("system");
    expect(cfg.providers).toEqual([]);
  });

  it("首开语言探测:浏览器语言非 zh → en-US,zh 变体与缺席 → zh-CN", async () => {
    expect(detectLocale(undefined)).toBe("zh-CN");
    expect(detectLocale("")).toBe("zh-CN");
    expect(detectLocale("zh-CN")).toBe("zh-CN");
    expect(detectLocale("zh-TW")).toBe("zh-CN");
    expect(detectLocale("en-US")).toBe("en-US");
    expect(detectLocale("fr")).toBe("en-US");

    vi.stubGlobal("navigator", { language: "en-US" });
    expect((await loadConfig()).locale).toBe("en-US");
  });

  it("显式存储的 locale 永远尊重,不被浏览器语言探测覆盖", async () => {
    await storage().set({ locale: "zh-CN" });
    vi.stubGlobal("navigator", { language: "en-US" });
    expect((await loadConfig()).locale).toBe("zh-CN");
  });
});

describe("confirmLevel 读时迁移(legacy confirmActions 布尔 → 档位)", () => {
  it("无任何键 → strict(安全默认)", async () => {
    const cfg = await loadConfig();
    expect(cfg.confirmLevel).toBe("strict");
  });

  it("legacy confirmActions: false → off;缺席或 true → strict", async () => {
    await storage().set({ confirmActions: false });
    expect((await loadConfig()).confirmLevel).toBe("off");
    await storage().clear();
    await storage().set({ confirmActions: true });
    expect((await loadConfig()).confirmLevel).toBe("strict");
  });

  it("confirmLevel 合法值优先于 legacy 布尔", async () => {
    await storage().set({ confirmLevel: "auto", confirmActions: false });
    expect((await loadConfig()).confirmLevel).toBe("auto");
  });

  it("confirmLevel 非法(大小写/未知值)→ 回落 legacy → 再回落 strict", async () => {
    await storage().set({ confirmLevel: "STRICT", confirmActions: false });
    expect((await loadConfig()).confirmLevel).toBe("off");
    await storage().set({ confirmLevel: "yolo", confirmActions: true });
    expect((await loadConfig()).confirmLevel).toBe("strict");
  });
});

describe("saveConfirmLevel(档位写入唯一入口,legacy 双写保回滚安全)", () => {
  it("写 auto:confirmLevel 与 confirmActions 两键同时在场,后者为 true", async () => {
    await saveConfirmLevel("auto");
    const bag = await chrome.storage.local.get(["confirmLevel", "confirmActions"]);
    expect(bag.confirmLevel).toBe("auto");
    expect(bag.confirmActions).toBe(true);
  });

  it("写 off:双写 legacy false(回滚到旧版读到的也是全免,与用户所选档一致)", async () => {
    await saveConfirmLevel("off");
    const bag = await chrome.storage.local.get(["confirmLevel", "confirmActions"]);
    expect(bag.confirmLevel).toBe("off");
    expect(bag.confirmActions).toBe(false);
  });
});
