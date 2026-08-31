// web_search 工具执行体(service worker 侧):
// 按序尝试多个无 Key 搜索引擎,单个引擎请求失败 / 被风控 / 空结果时自动
// 切换下一个;全部失败才向模型报错。引擎只负责「抓 HTML」,解析借道
// offscreen document 的 DOMParser(PARSE_CALL 协议,见 shared/docBridge.ts)。
//
// 为什么不做成可选配置:无 Key 方案零配置可用,是本工具的设计前提;
// 引擎顺序按「用户网络可达性」排定(Bing 在国内可达,DDG 多数国际网络可达),
// 兜底顺序本身就覆盖了两类环境,不值得为此引入设置项。
//
// 健壮性:引擎失败会按原因进入冷却(storage.session,SW 重启不丢),
// 冷却期内直接跳过 —— 避免每次搜索都先撞一次注定失败的风控/不可达;
// 冷却是启发式,若所有引擎都在冷却中则照常尝试(有结果总比没有强)。
// 用户中止 run 时,在途请求立即中断且不再尝试下一个引擎。

import { callOffscreenParser, ensureOffscreenDocument } from "../shared/docBridge";
import { abortWithTimeout, getToolExecutionContext } from "./toolContext";
import { createLogger } from "../shared/logger";

const log = createLogger({ ctx: "bg" });

/** 单引擎请求超时:搜索引擎应答很快,超时基本等于不可达(如被墙) */
const FETCH_TIMEOUT_MS = 10_000;
/** 默认返回条数与上限(条数越大 token 越贵,且首页之后的相关度急剧下降) */
const RESULTS_DEFAULT = 6;
const RESULTS_MAX = 10;

export interface WebSearchArgs {
  query?: unknown;
  max_results?: unknown;
  /** 时间范围(day/week/month/year),对齐 Tavily time_range 语义 */
  recency?: unknown;
  /** 域名白名单/黑名单,对齐 Anthropic web_search 工具;互斥,同时给时白名单优先 */
  allowed_domains?: unknown;
  blocked_domains?: unknown;
}

export interface WebSearchResult {
  query: string;
  /** 实际产出结果的引擎;空数组时是最后一个正常应答的引擎 */
  engine: string;
  results: { title: string; url: string; snippet: string }[];
  /** 仅空结果时携带:给模型的下一步建议 */
  note?: string;
}

const RECENCY_VALUES = ["day", "week", "month", "year"] as const;
type Recency = (typeof RECENCY_VALUES)[number];

/** recency 对应的天数范围(Bing ez5 过滤用);DDG df 参数直接用首字母 */
const RECENCY_DAYS: Record<Recency, number> = {
  day: 1,
  week: 7,
  month: 30,
  year: 365,
};

interface SearchEngine {
  id: string;
  buildUrl: (query: string, recency: Recency | null) => string;
  /** 响应命中标记且解析不出结果 → 判定为风控/验证页而非「无结果」,继续换引擎 */
  blockMarkers?: RegExp;
}

const ENGINES: SearchEngine[] = [
  {
    id: "bing",
    buildUrl: (q, recency) => {
      let url = `https://www.bing.com/search?q=${encodeURIComponent(q)}&count=${RESULTS_MAX}`;
      if (recency) {
        // Bing 时间过滤:ez5_<起>_<结束>,日期序列 = UTC 天数(实测有效,
        // 响应里会出现「2026/8/22 - 2026/8/29」这类生效标签)
        const end = Math.floor(Date.now() / 86_400_000);
        const range = `ex1:"ez5_${end - RECENCY_DAYS[recency]}_${end}"`;
        url += `&filters=${encodeURIComponent(range)}`;
      }
      return url;
    },
    blockMarkers: /grecaptcha|challengesurvey/i,
  },
  {
    id: "ddg",
    buildUrl: (q, recency) => {
      let url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
      if (recency) url += `&df=${recency[0]}`; // d/w/m/y
      return url;
    },
    blockMarkers: /anomaly|captcha/i,
  },
];

// ---- 引擎冷却(风控/不可达后短期跳过) ----
// 存 storage.session:浏览器会话内有效,SW 被杀重启也不丢;浏览器重开自动清零。
const COOLDOWN_KEY = "webSearch:engineCooldown";
const COOLDOWN_MS = { blocked: 5 * 60_000, unreachable: 10 * 60_000 } as const;
type CooldownKind = keyof typeof COOLDOWN_MS;
type CooldownMap = Record<string, { until: number; kind: CooldownKind }>;

async function loadCooldowns(): Promise<CooldownMap> {
  try {
    const bag = await chrome.storage.session.get(COOLDOWN_KEY);
    return bag[COOLDOWN_KEY] ?? {};
  } catch {
    return {};
  }
}

async function coolDownEngine(id: string, kind: CooldownKind): Promise<void> {
  const map = await loadCooldowns();
  map[id] = { until: Date.now() + COOLDOWN_MS[kind], kind };
  try {
    await chrome.storage.session.set({ [COOLDOWN_KEY]: map });
  } catch {
    /* 冷却写失败无碍,下次会重新尝试引擎 */
  }
  log.warn("search", "引擎进入冷却,近期搜索将跳过", {
    engine: id,
    kind,
    minutes: COOLDOWN_MS[kind] / 60_000,
  });
}

async function clearEngineCooldown(id: string): Promise<void> {
  const map = await loadCooldowns();
  if (!map[id]) return;
  delete map[id];
  try {
    await chrome.storage.session.set({ [COOLDOWN_KEY]: map });
  } catch {
    /* ignore */
  }
}

/** 失败分类:决定「不再尝试下一个引擎」还是「冷却后换下一个」 */
function classifyFailure(e: unknown, cancelled: boolean): "cancelled" | "timeout" | "blocked" | "error" {
  if (cancelled) return "cancelled";
  const msg = e instanceof Error ? e.message : String(e);
  if (/timeout/i.test(msg)) return "timeout";
  if (/HTTP (403|429)/.test(msg)) return "blocked";
  return "error";
}

export async function runWebSearch(args: WebSearchArgs): Promise<WebSearchResult> {
  const query = typeof args?.query === "string" ? args.query.trim() : "";
  if (!query) {
    throw new Error("web_search: query 不能为空,请给出要搜索的关键词");
  }
  const limit =
    typeof args?.max_results === "number" && Number.isFinite(args.max_results)
      ? Math.min(Math.max(1, Math.floor(args.max_results)), RESULTS_MAX)
      : RESULTS_DEFAULT;
  const recency =
    args?.recency === null || args?.recency === undefined
      ? null
      : validateRecency(args.recency);
  // 域名过滤(Anthropic 语义:两者互斥,同时给时白名单优先)
  const allowed = parseDomainList(args?.allowed_domains);
  const blocked = allowed.length === 0 ? parseDomainList(args?.blocked_domains) : [];

  const cancelSignal = getToolExecutionContext()?.signal;
  await ensureOffscreenDocument();

  const startedAt = Date.now();
  const failures: string[] = [];
  /** 有引擎正常应答(哪怕空结果)时记下它,作为空结果返回值里的 engine */
  let lastGoodEngine = "";

  // 冷却中的引擎直接跳过;若全部在冷却,说明冷却已不可信,照常尝试
  const cooldowns = await loadCooldowns();
  const now = Date.now();
  const available = ENGINES.filter((en) => {
    if (!(cooldowns[en.id]?.until > now)) return true;
    log.info("search", "引擎冷却中,跳过", {
      engine: en.id,
      remainingSec: Math.round(((cooldowns[en.id]?.until ?? 0) - now) / 1000),
    });
    return false;
  });
  const enginesToTry = available.length > 0 ? available : ENGINES;
  if (available.length === 0) {
    log.info("search", "所有引擎均在冷却中,忽略冷却照常尝试");
  }

  for (const engine of enginesToTry) {
    if (cancelSignal?.aborted) {
      throw new Error("用户已取消本次搜索");
    }
    try {
      const { html, finalUrl } = await fetchHtml(engine.buildUrl(query, recency), cancelSignal);
      const results = (await callOffscreenParser("search", {
        engine: engine.id,
        html,
        base: finalUrl,
        limit,
      })) as { title: string; url: string; snippet: string }[];

      if (!Array.isArray(results)) throw new Error("解析结果异常");
      const beforeFilter = results.length;
      const filtered = results.filter((r) => passesDomainFilter(r.url, allowed, blocked));
      if (beforeFilter > 0 && filtered.length === 0 && (allowed.length > 0 || blocked.length > 0)) {
        // 域名过滤把结果全滤掉了:换引擎大概率也一样,直接说明,不继续兜底
        log.info("search", "结果全被域名过滤排除", {
          engine: engine.id,
          allowed,
          blocked,
          beforeFilter,
        });
        return {
          query,
          engine: engine.id,
          results: [],
          note: `有 ${beforeFilter} 条结果但全被域名过滤排除。请放宽 allowed_domains / blocked_domains 后重试,或去掉过滤参数。`,
        };
      }
      if (filtered.length === 0) {
        if (engine.blockMarkers?.test(html)) {
          await coolDownEngine(engine.id, "blocked");
          throw new Error("返回风控/验证页");
        }
        lastGoodEngine = engine.id;
        log.info("search", `引擎无结果,切换下一个`, { engine: engine.id, query });
        continue;
      }
      await clearEngineCooldown(engine.id);
      log.info("search", "web_search 完成", {
        engine: engine.id,
        count: filtered.length,
        ms: Date.now() - startedAt,
      });
      return { query, engine: engine.id, results: filtered.slice(0, limit) };
    } catch (e) {
      const kind = classifyFailure(e, cancelSignal?.aborted ?? false);
      if (kind === "cancelled") {
        throw new Error("用户已取消本次搜索");
      }
      const msg = e instanceof Error ? e.message : String(e);
      if (kind === "timeout") await coolDownEngine(engine.id, "unreachable");
      if (kind === "blocked") await coolDownEngine(engine.id, "blocked");
      failures.push(`${engine.id}: ${msg}`);
      log.warn("search", `引擎失败,切换下一个`, { engine: engine.id, error: msg });
    }
  }

  // 所有引擎都报错(网络/风控)→ 抛错,让模型看到原因后换词重试或直接回答
  if (!lastGoodEngine) {
    throw new Error(`所有搜索引擎都失败了(${failures.join("; ")})`);
  }
  // 有引擎正常应答但确实没有结果 → 空结果 + 建议,不算错误
  return {
    query,
    engine: lastGoodEngine,
    results: [],
    note: "没有搜索到相关结果。可换更具体的核心词、或换一种语言的关键词重试;若已知答案请直接回答。",
  };
}

/** SW 内 fetch(host_permissions 覆盖 <all_urls>,无 CORS 限制);返回最终 URL 供相对链接还原 */
async function fetchHtml(
  url: string,
  external?: AbortSignal,
): Promise<{ html: string; finalUrl: string }> {
  const { signal, cleanup } = abortWithTimeout(FETCH_TIMEOUT_MS, external);
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    if (!html.trim()) throw new Error("空响应");
    return { html, finalUrl: res.url || url };
  } finally {
    cleanup();
  }
}

function validateRecency(v: unknown): Recency {
  if (typeof v === "string" && (RECENCY_VALUES as readonly string[]).includes(v)) {
    return v as Recency;
  }
  throw new Error(
    `recency 只接受 ${RECENCY_VALUES.join(" / ")} 之一,收到:${JSON.stringify(v) ?? String(v)}`,
  );
}

/** 域名参数宽松归一:允许带协议/路径,取主机名部分 */
function parseDomainList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((d): d is string => typeof d === "string" && d.trim().length > 0)
    .map((d) =>
      d
        .trim()
        .toLowerCase()
        .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
        .split("/")[0]
        .replace(/^\.+/, ""),
    )
    .filter((d) => d.length > 0);
}

/** 主机名匹配:等于名单项或为其子域(example.com 匹配 www.example.com) */
function passesDomainFilter(url: string, allowed: string[], blocked: string[]): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false; // 非法 URL 视为不通过
  }
  if (allowed.length > 0 && !allowed.some((d) => hostname === d || hostname.endsWith(`.${d}`))) {
    return false;
  }
  return !blocked.some((d) => hostname === d || hostname.endsWith(`.${d}`));
}
