// 空态问候单测:时段定档边界 + 本地池按日播种的确定性 + 问候键都在
// 字典里。loadQuote 的网络/存储分支不在此测(e2e 场景覆盖空态可见性)。

import { describe, expect, it } from "vitest";
import { zhCN } from "../../shared/i18n/locales/zh-CN";
import { enUS } from "../../shared/i18n/locales/en-US";
import {
  LOCAL_QUOTES,
  localQuote,
  quoteDisplay,
  timeGreetKey,
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
