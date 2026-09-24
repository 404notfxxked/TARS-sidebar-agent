// 空态问候:标题按本机时段定档(5 档),副标为「每日一句」。
// quote 属内容而非产品话术 —— 本地池与 API 结果都不进 i18n 字典
// (字典只收 UI 文案;网络内容与工具结果同类,见 i18n/index.ts 头注)。
// 语言源:zh 走一言(hitokoto)v1(免 key);en 只用内置短句池、不联网
// (英文第三方源实测走不通,理由见 QUOTE_SOURCE 头注);
// 当日结果缓存进 chrome.storage.local:挂载时同步窥探,有当日条目就用,
// 否则用本地池播种条 —— 一次挂载只显示一条(首帧即终帧),补抓在后台
// 进行、只落盘供下次挂载,API 延迟不会造成挂载中的文案跳变。
// 离线/失败静默保持本地池(按日期播种,当天恒定、隔天轮换)。

import type { LocalePref } from "../../shared/configStore";

export interface Quote {
  text: string;
  from?: string;
  /** 内容来源标记:只有「从 API 取回」的句子带它,本地池一律不标 ——
   *  面板据此决定是否显示「来自 一言」署名;给本地池标来源就是错标 */
  src?: "hitokoto";
  /** 一言句子 UUID:署名链接用它直达该句页面(官方建议的溯源方式);
   *  缺失时回落到站点首页 */
  uuid?: string;
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

/** 本地兜底池;导出只为单测可直查条目质量。
 *  ⚠️ 条目必须自撰:一言的语句库(sentences-bundle)是 AGPL 授权,抄进本仓库
 *  (MIT)属许可证冲突 —— 要扩池就自己写,或走其「超链接引用」的豁免路径 */
export const LOCAL_QUOTES: Record<LocalePref, readonly Quote[]> = {
  "zh-CN": [
    { text: "千里之行，始于足下。", from: "老子《道德经》" },
    { text: "知之为知之，不知为不知，是知也。", from: "孔子《论语》" },
    { text: "纸上得来终觉浅，绝知此事要躬行。", from: "陆游《冬夜读书示子聿》" },
    { text: "不积跬步，无以至千里。", from: "荀子《劝学》" },
    { text: "学而不思则罔，思而不学则殆。", from: "孔子《论语》" },
    { text: "工欲善其事，必先利其器。", from: "孔子《论语》" },
    { text: "路漫漫其修远兮，吾将上下而求索。", from: "屈原《离骚》" },
    { text: "问渠那得清如许？为有源头活水来。", from: "朱熹《观书有感》" },
    { text: "尽信书，则不如无书。", from: "《孟子》" },
    { text: "凡事预则立，不预则废。", from: "《礼记·中庸》" },
    { text: "山重水复疑无路，柳暗花明又一村。", from: "陆游《游山西村》" },
    { text: "会当凌绝顶，一览众山小。", from: "杜甫《望岳》" },
    { text: "长风破浪会有时，直挂云帆济沧海。", from: "李白《行路难》" },
    { text: "业精于勤，荒于嬉；行成于思，毁于随。", from: "韩愈《进学解》" },
    { text: "博观而约取，厚积而薄发。", from: "苏轼《稼说送张琥》" },
    { text: "敏而好学，不耻下问。", from: "孔子《论语》" },
  ],
  "en-US": [
    {
      text: "The only true wisdom is in knowing you know nothing.",
      from: "Socrates",
    },
    { text: "Well begun is half done.", from: "Aristotle" },
    { text: "Quality is not an act, it is a habit.", from: "Aristotle" },
    {
      text: "The important thing is not to stop questioning.",
      from: "Albert Einstein",
    },
    {
      text: "Simplicity is the ultimate sophistication.",
      from: "Leonardo da Vinci",
    },
    {
      text: "A journey of a thousand miles begins with a single step.",
      from: "Laozi",
    },
    {
      text: "The best way to predict the future is to invent it.",
      from: "Alan Kay",
    },
    { text: "Talk is cheap. Show me the code.", from: "Linus Torvalds" },
    { text: "Make it work, make it right, make it fast.", from: "Kent Beck" },
    {
      text: "What we know is a drop; what we don't know is an ocean.",
      from: "Isaac Newton",
    },
    {
      text: "Perfection is achieved when there is nothing left to take away.",
      from: "Antoine de Saint-Exupéry",
    },
    { text: "Knowledge is power.", from: "Francis Bacon" },
    {
      text: "Genius is one percent inspiration and ninety-nine percent perspiration.",
      from: "Thomas Edison",
    },
    {
      text: "The only way to do great work is to love what you do.",
      from: "Steve Jobs",
    },
    {
      text: "If you wish to make an apple pie from scratch, you must first invent the universe.",
      from: "Carl Sagan",
    },
    {
      text: "It is not that I am so smart, it is just that I stay with problems longer.",
      from: "Albert Einstein",
    },
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

/** 缓存策略版本:缓存里装的是「按当时请求参数取回的句子」,参数一变旧条目就
 *  不再代表现行口径 —— 2026-09-24 类别从 a/b/c/d/i/k 收窄到 i(诗词)后,
 *  旧条目仍可能来自已停用的分类(实测:用户缓存里的 d 类「龙应台·目送」)。
 *  读时版本不符即当未命中:升级后首次挂载回落本地池,后台补抓新策略的句子,
 *  下一次挂载生效 —— 内容口径从第一次挂载起就是新的,不用等缓存自然过期。
 *  改 HITOKOTO_URL 的筛选口径时必须同步改这个串。 */
const QUOTE_CACHE_POLICY = "hitokoto-i-only/1";

/** 一言只取「诗词」一类(c=i)。
 *  一言是社区投稿库、分类标签很松(2026-09-24 实测):
 *  a/b/c(动画/漫画/游戏)会出游戏台词「可爱……你……会再次……见到……我的……」;
 *  d(文学)混进网络小说与影视台词(「天自撰我命 唤魂为逆」——魔道祖师);
 *  k(哲学)混进民间俗语与网络段子号。只有 i(诗词)稳定是古典诗文,
 *  与本模块本地兜底池(古文格言)气质一致 —— 空态是产品的第一眼,宁窄勿杂。
 *  放宽类别前先重跑一次抽样,别凭分类名想当然。
 *  max_length 是服务端「只返回不超过该长度的句子」(过滤,非截断) */
export const HITOKOTO_URL = "https://v1.hitokoto.cn/?c=i&max_length=36";

/** 内容源署名:一言官方恳求带链接(见 README 致谢),故署名行是链接。
 *  英文侧不接第三方源:ZenQuotes 免费版不返回 CORS 头(官方文档明写
 *  「API key is required to enable Access-Control-Allow-Origin headers」),
 *  而「安装零站点授权」正是本产品的出厂默认态 —— 未授权时该请求必被拦,
 *  等于一个永远拉不到、却要背署名义务的通道。故英文只用本地池。 */
export const QUOTE_SOURCE = {
  name: "一言",
  href: "https://hitokoto.cn/",
  /** 只有这个来源的句子需要署名 */
  id: "hitokoto",
} as const;

/** 署名链接:有 uuid 直达该句页面(官方建议的溯源方式),没有则回落站点首页。
 *  本地池句(无 src)不该被署名,调用方先判 src。 */
export function quoteSourceHref(q: Quote): string {
  return q.uuid ? `${QUOTE_SOURCE.href}?uuid=${q.uuid}` : QUOTE_SOURCE.href;
}

async function fetchHitokoto(): Promise<Quote | undefined> {
  const res = await fetch(HITOKOTO_URL, {
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) return undefined;
  const j = (await res.json()) as {
    hitokoto?: string;
    from?: string | null;
    from_who?: string | null;
    uuid?: string | null;
  };
  if (!j.hitokoto || j.hitokoto.length > QUOTE_MAX_LEN) return undefined;
  const parts = [...new Set([j.from_who, j.from].filter(Boolean))] as string[];
  return {
    text: j.hitokoto,
    from: parts.length ? parts.join(" · ") : undefined,
    src: "hitokoto",
    uuid: j.uuid || undefined,
  };
}

/** 仅中文走网络:英文直接返回 undefined(本地池即其全部内容源)。
 *  离线/超时静默回落本地池。 */
async function fetchQuote(locale: LocalePref): Promise<Quote | undefined> {
  if (locale !== "zh-CN") return undefined;
  try {
    return await fetchHitokoto();
  } catch {
    return undefined;
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
        | {
            day?: string;
            locale?: string;
            text?: string;
            from?: string;
            uuid?: string;
            policy?: string;
          }
        | undefined;
      // 版本不符(含本字段引入前写入的老条目)一律当未命中,见 QUOTE_CACHE_POLICY
      const usable =
        c?.policy === QUOTE_CACHE_POLICY && c.day && c.locale && c.text;
      cachePeek = usable
        ? {
            day: c.day as string,
            locale: c.locale as LocalePref,
            q: {
              text: c.text as string,
              from: c.from || undefined,
              uuid: c.uuid || undefined,
              // 能进缓存的只可能是 API 结果(本地池从不落盘,见 warmDailyQuote),
              // 故缓存命中一律按网络来源认 —— 署名据此显示
              src: QUOTE_SOURCE.id,
            },
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
export function warmDailyQuote(
  locale: LocalePref,
  dayKey: string,
): Promise<void> {
  const key = `${locale}:${dayKey}`;
  const inflight = warming.get(key);
  if (inflight) return inflight;
  const task = (async () => {
    try {
      const hit = await chrome.storage.local.get(QUOTE_CACHE_KEY);
      const c = hit[QUOTE_CACHE_KEY] as
        | { day?: string; locale?: string; text?: string; policy?: string }
        | undefined;
      // 已是当日 且 是现行策略取回的:无需再抓。
      // 缺 policy 判断会让旧策略的条目一直挡住补抓(升级当天口径不生效)
      if (
        c?.policy === QUOTE_CACHE_POLICY &&
        c.day === dayKey &&
        c.locale === locale &&
        c.text
      ) {
        return;
      }
      const q = await fetchQuote(locale);
      if (q) {
        await chrome.storage.local.set({
          [QUOTE_CACHE_KEY]: {
            day: dayKey,
            locale,
            ...q,
            policy: QUOTE_CACHE_POLICY,
          },
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
    from: q.from
      ? locale === "zh-CN"
        ? `—— ${q.from}`
        : `— ${q.from}`
      : undefined,
  };
}
