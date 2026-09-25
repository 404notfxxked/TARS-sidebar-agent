// 空态问候单测:时段定档边界 + 问候键都在字典里。

import { describe, expect, it } from "vitest";
import { zhCN } from "../../shared/i18n/locales/zh-CN";
import { enUS } from "../../shared/i18n/locales/en-US";
import { timeGreetKey } from "./greeting";

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
