// 空态问候:标题按本机时段定档(5 档),副标为「每日一句」。
// quote 属内容而非产品话术 —— 本地池与 API 结果都不进 i18n 字典
// (字典只收 UI 文案;网络内容与工具结果同类,见 i18n/index.ts 头注)。
// 语言源:zh 走一言(hitokoto)v1,en 走 ZenQuotes,均免 key;
// 当日结果缓存进 chrome.storage.local:挂载时同步窥探,有当日条目就用,
// 否则用本地池播种条 —— 一次挂载只显示一条(首帧即终帧),补抓在后台
// 进行、只落盘供下次挂载,API 延迟不会造成挂载中的文案跳变。
// 离线/失败静默保持本地池(按日期播种,当天恒定、隔天轮换)。

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
    // 歌词同款气质的流行句,混进池里换换口味
    { text: "原谅我这一生不羁放纵爱自由。", from: "Beyond《海阔天空》" },
    { text: "我曾经跨过山和大海，也穿过人山人海。", from: "朴树《平凡之路》" },
    { text: "夜空中最亮的星，请照亮我前行。", from: "逃跑计划《夜空中最亮的星》" },
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
    // 短歌词条(fair-use 量级的一两句)
    { text: "Let it be, let it be.", from: "The Beatles · Let It Be" },
    { text: "You may say I'm a dreamer, but I'm not the only one.", from: "John Lennon · Imagine" },
    { text: "The answer, my friend, is blowin' in the wind.", from: "Bob Dylan · Blowin' in the Wind" },
    { text: "Don't worry about a thing, 'cause every little thing is gonna be alright.", from: "Bob Marley · Three Little Birds" },
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

/** 一言:文学/诗词/哲学外,混入动画/漫画/游戏类(台词向,更轻);
 *  max_length 服务端截短 */
async function fetchHitokoto(): Promise<Quote | undefined> {
  const res = await fetch(
    "https://v1.hitokoto.cn/?c=a&c=b&c=c&c=d&c=i&c=k&max_length=36",
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

// ---- 当日缓存:同步窥探 + 后台预热 ----
// 首帧即终帧:一次挂载只显示一条 quote,绝不异步替换 —— 否则 API 延迟
// 会把挂载中的兜底句换掉,视觉上「先一句、几秒后跳成另一句」。
// cachePeek 在模块加载(面板打开)时抢跑读一次:undefined = 还没读到,
// null = 读过且无当日条目。挂载时窥探到当日缓存就用缓存,否则本地池。
let cachePeek: { day: string; locale: LocalePref; q: Quote } | null | undefined;

function primeCache(): void {
  if (cachePeek !== undefined) return;
  const storage =
    typeof chrome !== "undefined" ? chrome.storage?.local : undefined;
  if (!storage) {
    cachePeek = null; // 非扩展环境(单测等)
    return;
  }
  storage
    .get(QUOTE_CACHE_KEY)
    .then((hit: Record<string, unknown>) => {
      const c = hit[QUOTE_CACHE_KEY] as
        | { day?: string; locale?: string; text?: string; from?: string }
        | undefined;
      cachePeek =
        c?.day && c.locale && c.text
          ? {
              day: c.day,
              locale: c.locale as LocalePref,
              q: { text: c.text, from: c.from || undefined },
            }
          : null;
    })
    .catch(() => {
      cachePeek = null;
    });
}
primeCache();

/** 当日缓存的同步窥探;无当日条目(或尚未读到)返回 undefined */
export function peekDailyQuote(
  locale: LocalePref,
  dayKey: string,
): Quote | undefined {
  primeCache();
  if (cachePeek === undefined || cachePeek === null) return undefined;
  return cachePeek.day === dayKey && cachePeek.locale === locale
    ? cachePeek.q
    : undefined;
}

const warming = new Map<string, Promise<void>>();

/** 后台预热:当日缓存缺失时补抓一次并落盘,供下一次挂载使用;
 *  结果不回给当前挂载(首帧即终帧)。同会话并发调用按 key 去重 */
export function warmDailyQuote(locale: LocalePref, dayKey: string): Promise<void> {
  const key = `${locale}:${dayKey}`;
  const inflight = warming.get(key);
  if (inflight) return inflight;
  const task = (async () => {
    try {
      const hit = await chrome.storage.local.get(QUOTE_CACHE_KEY);
      const c = hit[QUOTE_CACHE_KEY] as
        | { day?: string; locale?: string; text?: string }
        | undefined;
      if (c?.day === dayKey && c.locale === locale && c.text) return; // 已是当日
      const q = await fetchQuote(locale);
      if (q) {
        await chrome.storage.local.set({
          [QUOTE_CACHE_KEY]: { day: dayKey, locale, ...q },
        });
        cachePeek = { day: dayKey, locale, q }; // 供后续挂载窥探
      }
    } catch {
      // 离线/存储不可用:本次保持本地池,下次挂载再试
    } finally {
      warming.delete(key);
    }
  })();
  warming.set(key, task);
  return task;
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
