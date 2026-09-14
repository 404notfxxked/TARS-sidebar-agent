// 空态问候:标题按本机时段定档(5 档),副标为「每日一句」。
// quote 属内容而非产品话术 —— 本地池与 API 结果都不进 i18n 字典
// (字典只收 UI 文案;网络内容与工具结果同类,见 i18n/index.ts 头注)。
// 语言源:zh 走一言(hitokoto)v1,en 走 ZenQuotes,均免 key;
// 当日结果缓存进 chrome.storage.local,当天打开不再请求、文案稳定;
// 离线/失败静默回落本地池(按日期播种,当天恒定、隔天轮换)。

import type { LocalePref } from "../../shared/configStore";

export interface Quote {
  text: string;
  from?: string;
}

/** 本机时段 → 问候键(hour 为 new Date().getHours()) */
export function timeGreetKey(hour: number): string {
  if (hour >= 5 && hour < 11) return "chat.greetMorning";
  if (hour >= 11 && hour < 13) return "chat.greetNoon";
  if (hour >= 13 && hour < 18) return "chat.greetAfternoon";
  if (hour >= 18 && hour < 23) return "chat.greetEvening";
  return "chat.greetLateNight";
}

/** 本地日期键,如 2026-09-12(跟着用户机器,无时区换算) */
export function dayKeyOf(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 本地兜底池;导出只为单测可直查条目质量 */
export const LOCAL_QUOTES: Record<LocalePref, readonly Quote[]> = {  "zh-CN": [
    { text: "千里之行，始于足下。", from: "老子" },
    { text: "知之为知之，不知为不知，是知也。", from: "孔子" },
    { text: "纸上得来终觉浅，绝知此事要躬行。", from: "陆游" },
    { text: "不积跬步，无以至千里。", from: "荀子" },
    { text: "学而不思则罔，思而不学则殆。", from: "孔子" },
    { text: "工欲善其事，必先利其器。", from: "孔子" },
    { text: "路漫漫其修远兮，吾将上下而求索。", from: "屈原" },
    { text: "问渠那得清如许？为有源头活水来。", from: "朱熹" },
    { text: "尽信书，则不如无书。", from: "孟子" },
    { text: "凡事预则立，不预则废。", from: "《礼记》" },
    { text: "山重水复疑无路，柳暗花明又一村。", from: "陆游" },
    { text: "会当凌绝顶，一览众山小。", from: "杜甫" },
    { text: "长风破浪会有时，直挂云帆济沧海。", from: "李白" },
    { text: "业精于勤，荒于嬉；行成于思，毁于随。", from: "韩愈" },
    { text: "博观而约取，厚积而薄发。", from: "苏轼" },
    { text: "敏而好学，不耻下问。", from: "孔子" },
  ],
  "en-US": [
    { text: "The only true wisdom is in knowing you know nothing.", from: "Socrates" },
    { text: "Well begun is half done.", from: "Aristotle" },
    { text: "Quality is not an act, it is a habit.", from: "Aristotle" },
    { text: "The important thing is not to stop questioning.", from: "Albert Einstein" },
    { text: "Simplicity is the ultimate sophistication.", from: "Leonardo da Vinci" },
    { text: "A journey of a thousand miles begins with a single step.", from: "Laozi" },
    { text: "The best way to predict the future is to invent it.", from: "Alan Kay" },
    { text: "Talk is cheap. Show me the code.", from: "Linus Torvalds" },
    { text: "Make it work, make it right, make it fast.", from: "Kent Beck" },
    { text: "What we know is a drop; what we don't know is an ocean.", from: "Isaac Newton" },
    { text: "Perfection is achieved when there is nothing left to take away.", from: "Antoine de Saint-Exupéry" },
    { text: "Knowledge is power.", from: "Francis Bacon" },
    { text: "Genius is one percent inspiration and ninety-nine percent perspiration.", from: "Thomas Edison" },
    { text: "The only way to do great work is to love what you do.", from: "Steve Jobs" },
    { text: "If you wish to make an apple pie from scratch, you must first invent the universe.", from: "Carl Sagan" },
    { text: "It is not that I am so smart, it is just that I stay with problems longer.", from: "Albert Einstein" },
  ],
};

// djb2:同一天同语言恒定,隔天换一条且不逐日顺移
function daySeed(dayKey: string): number {
  let h = 5381;
  for (let i = 0; i < dayKey.length; i++) {
    h = ((h << 5) + h + dayKey.charCodeAt(i)) >>> 0;
  }
  return h;
}

/** 本地池按日播种取一条(同步,空态首帧即有内容) */
export function localQuote(locale: LocalePref, dayKey: string): Quote {
  const pool = LOCAL_QUOTES[locale];
  return pool[daySeed(dayKey) % pool.length];
}

const QUOTE_CACHE_KEY = "quoteOfDay";
const QUOTE_MAX_LEN = 120; // 超长判为不合适(小标题要短),回落本地池

/** 一言:文学/诗词/哲学三类,max_length 服务端截短 */
async function fetchHitokoto(): Promise<Quote | undefined> {
  const res = await fetch(
    "https://v1.hitokoto.cn/?c=d&c=i&c=k&max_length=36",
    { signal: AbortSignal.timeout(4000) },
  );
  if (!res.ok) return undefined;
  const j = (await res.json()) as {
    hitokoto?: string;
    from?: string | null;
    from_who?: string | null;
  };
  if (!j.hitokoto || j.hitokoto.length > QUOTE_MAX_LEN) return undefined;
  const parts = [...new Set([j.from_who, j.from].filter(Boolean))] as string[];
  return { text: j.hitokoto, from: parts.length ? parts.join(" · ") : undefined };
}

async function fetchZenQuotes(): Promise<Quote | undefined> {
  const res = await fetch("https://zenquotes.io/api/random", {
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) return undefined;
  const j = (await res.json()) as Array<{ q?: string; a?: string }>;
  const q = j[0]?.q;
  if (!q || q.length > QUOTE_MAX_LEN) return undefined;
  return { text: q, from: j[0]?.a || undefined };
}

async function fetchQuote(locale: LocalePref): Promise<Quote | undefined> {
  try {
    return locale === "zh-CN" ? await fetchHitokoto() : await fetchZenQuotes();
  } catch {
    return undefined; // 离线/超时,静默回落
  }
}

/** 每日一句:当日缓存 → 在线补抓(仅 miss 时,成功才落盘)→ 本地池 */
export async function loadQuote(
  locale: LocalePref,
  dayKey: string,
): Promise<Quote> {
  try {
    const hit = await chrome.storage.local.get(QUOTE_CACHE_KEY);
    const c = hit[QUOTE_CACHE_KEY] as
      | { day?: string; locale?: string; text?: string; from?: string }
      | undefined;
    if (c?.day === dayKey && c.locale === locale && c.text) {
      return { text: c.text, from: c.from || undefined };
    }
  } catch {
    // storage 不可用不阻塞问候
  }
  const q = await fetchQuote(locale);
  if (q) {
    try {
      await chrome.storage.local.set({
        [QUOTE_CACHE_KEY]: { day: dayKey, locale, ...q },
      });
    } catch {
      // 缓存失败无碍,本次已可用
    }
    return q;
  }
  return localQuote(locale, dayKey);
}

/** quote 的面板呈现:统一弯引号包正文,署名按语言选破折号 */
export function quoteDisplay(
  q: Quote,
  locale: LocalePref,
): { text: string; from?: string } {
  return {
    text: `“${q.text}”`,
    from: q.from ? (locale === "zh-CN" ? `—— ${q.from}` : `— ${q.from}`) : undefined,
  };
}
