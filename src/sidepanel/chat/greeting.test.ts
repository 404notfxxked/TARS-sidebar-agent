// 空态问候单测:时段定档边界 + 本地池按日播种的确定性 + 问候键都在
// 字典里。loadQuote 的网络/存储分支不在此测(e2e 场景覆盖空态可见性)。

import { afterEach, describe, expect, it, vi } from "vitest";
import { zhCN } from "../../shared/i18n/locales/zh-CN";
import { enUS } from "../../shared/i18n/locales/en-US";
import {
  HITOKOTO_URL,
  LOCAL_QUOTES,
  localQuote,
  peekDailyQuote,
  QUOTE_SOURCE,
  quoteDisplay,
  quoteSourceHref,
  timeGreetKey,
  warmDailyQuote,
  type Quote,
} from "./greeting";

describe("timeGreetKey 时段定档", () => {
  it("五档边界与内部小时落对档位", () => {
    const cases: Array<[number, string]> = [
      [5, "chat.greetMorning"],
      [10, "chat.greetMorning"],
      [11, "chat.greetNoon"],
      [12, "chat.greetNoon"],
      [13, "chat.greetAfternoon"],
      [17, "chat.greetAfternoon"],
      [18, "chat.greetEvening"],
      [22, "chat.greetEvening"],
      [23, "chat.greetLateNight"],
      [0, "chat.greetLateNight"],
      [4, "chat.greetLateNight"],
    ];
    for (const [hour, expected] of cases) {
      expect(timeGreetKey(hour)).toBe(expected);
    }
  });

  it("档位键在双语字典里都存在(防改档漏改键)", () => {
    for (const dict of [zhCN.chat, enUS.chat] as const) {
      const d = dict as unknown as Record<string, string>;
      for (const key of ["greetMorning", "greetNoon", "greetAfternoon", "greetEvening", "greetLateNight"]) {
        expect(d[key], `${key} 缺文案`).toBeTruthy();
      }
    }
  });
});

describe("localQuote 按日播种", () => {
  it("同日同语言恒定", () => {
    const a = localQuote("zh-CN", "2026-09-12");
    const b = localQuote("zh-CN", "2026-09-12");
    expect(a).toEqual(b);
  });

  it("连着几天至少换过一条(播种不是常量)", () => {
    const picks = new Set(
      ["2026-09-12", "2026-09-13", "2026-09-14", "2026-09-15"].map((d) =>
        localQuote("zh-CN", d).text,
      ),
    );
    expect(picks.size).toBeGreaterThan(1);
  });

  it("两池每条都有正文与署名(空串会让空态开天窗)", () => {
    for (const pool of Object.values(LOCAL_QUOTES)) {
      expect(pool.length).toBeGreaterThanOrEqual(16);
      for (const q of pool) {
        expect(q.text.length).toBeGreaterThan(0);
        expect(q.from).toBeTruthy();
      }
    }
  });
});

describe("quoteDisplay 呈现", () => {
  it("弯引号包正文,署名按语言选破折号", () => {
    const q = { text: "千里之行，始于足下。", from: "老子" };
    expect(quoteDisplay(q, "zh-CN")).toEqual({
      text: "“千里之行，始于足下。”",
      from: "—— 老子",
    });
    expect(quoteDisplay(q, "en-US").from).toBe("— 老子");
  });

  it("无署名时不造破折号", () => {
    expect(quoteDisplay({ text: "x" }, "zh-CN").from).toBeUndefined();
  });
});

// 决策锁:一言是社区投稿库、分类标签很松 —— 放宽任何一类都可能让空态出现
// 游戏台词/网文/网络段子。2026-09-24 抽样实证见 greeting.ts 该常量头注。
// 这条用例红了说明有人放开了类别:先重跑抽样确认内容气质,再决定是否改断言。
describe("一言请求分类(决策锁)", () => {
  it("只请求诗词一类", () => {
    expect(HITOKOTO_URL).toContain("c=i");
  });

  it("不含已被抽样证伪的类别", () => {
    // a/b/c 动画漫画游戏、d 文学(混网文)、k 哲学(混段子)、f 网络、l 抖机灵
    for (const c of ["c=a", "c=b", "c=c", "c=d", "c=k", "c=f", "c=l"]) {
      expect(HITOKOTO_URL, `${c} 会引入气质不符的内容`).not.toContain(c);
    }
  });

  it("服务端长度上界仍在(防小标题被长句撑破)", () => {
    expect(HITOKOTO_URL).toContain("max_length=");
  });
});

// 来源边界:中文走一言(带回来源标记 → 面板才显示「来自 一言」署名),
// 英文只用内置短句池、不联网(英文第三方源走不通,见 QUOTE_SOURCE 头注)。
describe("每日一句的来源边界", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("英文不发任何网络请求", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    await warmDailyQuote("en-US", "2026-09-24");
    expect(spy).not.toHaveBeenCalled();
  });

  it("中文取回的一言句子带来源标记,且请求仍是诗词类", async () => {
    let calledUrl = "";
    const spy = vi.fn(async (url: string) => {
      calledUrl = url;
      return {
        ok: true,
        json: async () => ({
          hitokoto: "花间一壶酒,独酌无相亲。",
          from: "《月下独酌》",
          from_who: "李白",
          uuid: "75a45fd4-4f2f-45eb-80cb-6f0a7bcdfaf2",
        }),
      };
    });
    vi.stubGlobal("fetch", spy);
    await warmDailyQuote("zh-CN", "2026-09-25");
    const q = peekDailyQuote("zh-CN", "2026-09-25");
    expect(q?.src).toBe(QUOTE_SOURCE.id);
    expect(q?.from).toBe("李白 · 《月下独酌》");
    expect(calledUrl).toContain("c=i");
    // 署名链接直达该句页面(一言官方建议的溯源方式)
    expect(quoteSourceHref(q as Quote)).toBe(
      `${QUOTE_SOURCE.href}?uuid=75a45fd4-4f2f-45eb-80cb-6f0a7bcdfaf2`,
    );
  });

  it("缺 uuid 时署名链接回落站点首页(不造坏链)", () => {
    expect(quoteSourceHref({ text: "x", src: "hitokoto" })).toBe(
      QUOTE_SOURCE.href,
    );
  });

  it("本地池句子不带来源标记(不给自家内容错标来源)", () => {
    expect(localQuote("zh-CN", "2026-09-24").src).toBeUndefined();
    expect(localQuote("en-US", "2026-09-24").src).toBeUndefined();
  });

  // 类别收窄前写入的当日缓存可能来自已停用的分类(实测:用户机器上缓存着
  // d 类的「龙应台·目送」)。旧条目必须当未命中,且不得挡住新策略的补抓 ——
  // 否则升级当天口径不生效,还会退化成「有句子、没署名」。
  it("旧策略的当日缓存不复用,也不挡补抓;新条目带来源标记", async () => {
    vi.resetModules();
    await chrome.storage.local.set({
      quoteOfDay: {
        day: "2026-09-26",
        locale: "zh-CN",
        text: "旧分类取回的句子",
        from: "龙应台 · 目送",
      },
    });
    const mod = await import("./greeting");
    await new Promise((r) => setTimeout(r, 0)); // 等 primeCache 的异步窥探落地
    expect(mod.peekDailyQuote("zh-CN", "2026-09-26")).toBeUndefined();

    let called = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        called += 1;
        return { ok: true, json: async () => ({ hitokoto: "新策略取回的句子" }) };
      }),
    );
    await mod.warmDailyQuote("zh-CN", "2026-09-26");
    expect(called).toBe(1); // 旧条目没有把补抓挡掉
    const q = mod.peekDailyQuote("zh-CN", "2026-09-26");
    expect(q?.text).toBe("新策略取回的句子");
    expect(q?.src).toBe(QUOTE_SOURCE.id);
  });
});
