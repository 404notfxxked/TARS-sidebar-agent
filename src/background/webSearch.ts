// web_search 工具执行体(service worker 侧)——双模式:
//   auto(免 Key,默认):抓取搜索结果页 HTML,走 scrapeSearch.ts 的加固链路
//   (cookie 蹭行 / 语言头 / 节流 / 风控冷却,详见该文件头部说明);
//   API(BYOK):设置里配置了服务商 key 时走结构化 API。
// API 三家预设:Tavily(海外 agent 生态主流)/ 博查(国产,DeepSeek C 端同款,
// 中文质量好、国内直连稳)/ Brave(独立索引)。响应都是结构化 JSON,直接映射
// {title,url,snippet},各家差异收在 preset 表内(端点、鉴权头、请求体、参数
// 映射、响应解析);域名过滤统一用结果后置(对任何 provider 都成立)。
// 失败按原因进冷却(storage.session,SW 重启不丢;两条路径共用同一冷却表);
// 用户中止 run 时在途请求立即中断。

import { abortWithTimeout, getToolExecutionContext } from "./toolContext";
import { createLogger } from "../shared/logger";
import type { SearchProviderId, SearchProviderSetting } from "../shared/configStore";
import { runScrapeSearch } from "./scrapeSearch";

const log = createLogger({ ctx: "bg" });

/** 单次请求超时:搜索 API 应答很快,超时基本等于不可达 */
const FETCH_TIMEOUT_MS = 15_000;
/** 默认返回条数与上限(条数越大 token 越贵) */
const RESULTS_DEFAULT = 6;
const RESULTS_MAX = 10;

export interface WebSearchArgs {
  query?: unknown;
  max_results?: unknown;
  /** 时间范围(day/week/month/year),映射到各家的 recency 参数 */
  recency?: unknown;
  /** 域名白名单/黑名单,对齐 Anthropic web_search 工具;互斥,同时给时白名单优先 */
  allowed_domains?: unknown;
  blocked_domains?: unknown;
  /** 结果的语言市场(如 zh-CN / ja-JP);当前仅 Brave 支持映射,其余服务忽略 */
  market?: unknown;
}

export interface WebSearchResult {
  query: string;
  /** 实际产出结果的搜索服务;空数组时是最后正常应答的服务 */
  engine: string;
  results: { title: string; url: string; snippet: string }[];
  /** 仅空结果时携带:给模型的下一步建议 */
  note?: string;
}

const RECENCY_VALUES = ["day", "week", "month", "year"] as const;
type Recency = (typeof RECENCY_VALUES)[number];

// ---- 搜索服务预设 ----
// 请求/响应形状各家不同,收口在 buildRequest / parseResponse 两个函数里;
// 鉴权统一「用户提供 key」,地址留空用官方端点(自建中转时在设置里改)。

interface ProviderRequest {
  url: string;
  init: RequestInit;
}

interface SearchProviderPreset {
  id: SearchProviderId;
  /** 官方 API 根地址(不含路径);设置里留空时使用 */
  defaultBaseUrl: string;
  buildRequest(ctx: {
    baseUrl: string;
    apiKey: string;
    query: string;
    limit: number;
    recency: Recency | null;
    market: string | null;
  }): ProviderRequest;
  /** 响应 JSON → 统一结果数组;抛错视为该服务响应异常 */
  parse(body: unknown): { title: string; url: string; snippet: string }[];
}

/** 安全取字符串字段 */
const str = (v: unknown): string => (typeof v === "string" ? v : "");

const TAVILY: SearchProviderPreset = {
  id: "tavily",
  defaultBaseUrl: "https://api.tavily.com",
  buildRequest: ({ baseUrl, apiKey, query, limit, recency }) => ({
    url: `${baseUrl}/search`,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        max_results: limit,
        ...(recency ? { time_range: recency } : {}),
      }),
    },
  }),
  parse: (body) => {
    const results = (body as { results?: unknown })?.results;
    if (!Array.isArray(results)) throw new Error("响应缺少 results 数组");
    return results.map((r) => {
      const o = r as Record<string, unknown>;
      return { title: str(o.title), url: str(o.url), snippet: str(o.content) };
    });
  },
};

const BOCHA: SearchProviderPreset = {
  id: "bocha",
  defaultBaseUrl: "https://api.bocha.cn",
  buildRequest: ({ baseUrl, apiKey, query, limit, recency }) => ({
    url: `${baseUrl}/v1/web-search`,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        count: limit,
        summary: true,
        // 博查 freshness 词表:noLimit/oneDay/oneWeek/oneMonth/oneYear
        ...(recency
          ? { freshness: `one${recency[0].toUpperCase()}${recency.slice(1)}` }
          : {}),
      }),
    },
  }),
  parse: (body) => {
    const pages = (body as { data?: { webPages?: { value?: unknown } } })?.data
      ?.webPages?.value;
    if (!Array.isArray(pages))
      throw new Error("响应缺少 data.webPages.value 数组");
    return pages.map((p) => {
      const o = p as Record<string, unknown>;
      return {
        title: str(o.name),
        url: str(o.url),
        snippet: str(o.summary) || str(o.snippet),
      };
    });
  },
};

/** Brave search_lang 词表:中文不接受 "zh",简体要写 zh-hans、繁体 zh-hant;
 *  其余语言直接用 market 的语言码 */
function braveSearchLang(lang: string, region?: string): string {
  if (lang !== "zh") return lang;
  return region === "TW" || region === "HK" || region === "MO"
    ? "zh-hant"
    : "zh-hans";
}

const BRAVE: SearchProviderPreset = {
  id: "brave",
  defaultBaseUrl: "https://api.search.brave.com",
  buildRequest: ({ baseUrl, apiKey, query, limit, recency, market }) => {
    const u = new URL(`${baseUrl}/res/v1/web/search`);
    u.searchParams.set("q", query);
    u.searchParams.set("count", String(limit));
    if (recency) {
      // Brave freshness 词表:pd(天)/pw(周)/pm(月)/py(年)
      u.searchParams.set("freshness", `p${recency[0]}`);
    }
    if (market) {
      const [lang, region] = market.split("-");
      u.searchParams.set("search_lang", braveSearchLang(lang, region));
      if (region) u.searchParams.set("country", region.toLowerCase());
    }
    return {
      url: u.href,
      init: {
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": apiKey,
        },
      },
    };
  },
  parse: (body) => {
    const results = (body as { web?: { results?: unknown } })?.web?.results;
    if (!Array.isArray(results)) throw new Error("响应缺少 web.results 数组");
    return results.map((r) => {
      const o = r as Record<string, unknown>;
      return {
        title: str(o.title),
        url: str(o.url),
        snippet: str(o.description),
      };
    });
  },
};

export const SEARCH_PROVIDERS: Record<SearchProviderId, SearchProviderPreset> =
  {
    tavily: TAVILY,
    bocha: BOCHA,
    brave: BRAVE,
  };

// ---- 失败冷却(限流/不可达后短期跳过) ----
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
    /* 冷却写失败无碍,下次会重新尝试 */
  }
  log.warn("search", "搜索服务进入冷却,近期搜索将报错", {
    provider: id,
    kind,
    minutes: COOLDOWN_MS[kind] / 60_000,
  });
}

/** 搜索服务是否在冷却期内(冷却只影响报错文案,不改变「不可用」的事实) */
export async function searchCooldownKind(
  id: string,
): Promise<CooldownKind | null> {
  const map = await loadCooldowns();
  const hit = map[id];
  return hit?.until > Date.now() ? hit.kind : null;
}

/** 失败分类:限流/拒绝 → blocked;超时 → unreachable;其余 → error */
function classifyFailure(
  e: unknown,
  cancelled: boolean,
): "cancelled" | "timeout" | "blocked" | "error" {
  if (cancelled) return "cancelled";
  const msg = e instanceof Error ? e.message : String(e);
  if (/timeout/i.test(msg)) return "timeout";
  if (/HTTP (403|429)/.test(msg)) return "blocked";
  return "error";
}

/** 工具入口:按配置分流到 API 或免 Key 抓取兜底 */
export async function runWebSearch(
  args: WebSearchArgs,
): Promise<WebSearchResult> {
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
  const market = validateMarket(args?.market);
  // 域名参数宽松归一后统一做结果后置(Anthropic 语义:两者互斥,同时给时白名单优先)
  const allowed = parseDomainList(args?.allowed_domains);
  const blocked =
    allowed.length === 0 ? parseDomainList(args?.blocked_domains) : [];

  const mode = await readSearchMode();
  if (mode.kind === "scrape") {
    // 抓取通道是最小请求形态(只带 q):recency/market 仅 API 通道支持
    return runScrapeSearch({ query, limit, allowed, blocked });
  }
  return runApiSearch(mode, {
    query,
    limit,
    recency,
    market,
    allowed,
    blocked,
  });
}

type ApiSearchArgs = {
  query: string;
  limit: number;
  recency: Recency | null;
  market: string | null;
  allowed: string[];
  blocked: string[];
};

async function runApiSearch(
  mode: { provider: SearchProviderId; baseUrl: string; apiKey: string },
  args: ApiSearchArgs,
): Promise<WebSearchResult> {
  const { query, limit, recency, market, allowed, blocked } = args;
  const preset = SEARCH_PROVIDERS[mode.provider];

  const cancelSignal = getToolExecutionContext()?.signal;
  const startedAt = Date.now();

  const cooldown = await searchCooldownKind(mode.provider);
  if (cooldown === "blocked") {
    throw new Error(
      `搜索服务(${mode.provider})刚因限流/拒绝进入冷却(5 分钟),请稍后重试或改用其他信息来源`,
    );
  }

  try {
    const req = preset.buildRequest({
      baseUrl: mode.baseUrl,
      apiKey: mode.apiKey,
      query,
      limit,
      recency,
      market,
    });
    const { signal, cleanup } = abortWithTimeout(
      FETCH_TIMEOUT_MS,
      cancelSignal,
    );
    let res: Response;
    try {
      res = await fetch(req.url, { ...req.init, signal });
    } finally {
      cleanup();
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `HTTP ${res.status}${text ? `:${text.slice(0, 120)}` : ""}`,
      );
    }
    const body: unknown = await res.json();
    const results = preset.parse(body);

    const beforeFilter = results.length;
    const filtered = results.filter((r) =>
      passesDomainFilter(r.url, allowed, blocked),
    );
    if (
      beforeFilter > 0 &&
      filtered.length === 0 &&
      (allowed.length > 0 || blocked.length > 0)
    ) {
      // 域名过滤把结果全滤掉了:重试大概率也一样,直接说明
      log.info("search", "结果全被域名过滤排除", {
        query,
        provider: mode.provider,
        allowed,
        blocked,
        beforeFilter,
      });
      return {
        query,
        engine: mode.provider,
        results: [],
        note: `有 ${beforeFilter} 条结果但全被域名过滤排除。请放宽 allowed_domains / blocked_domains 后重试,或去掉过滤参数。`,
      };
    }
    const finalResults = filtered.slice(0, limit);
    // 搜索质量复盘档案:一次搜索的完整链路(词/过滤参数/服务/结果预览)一条记全
    log.info("search", "web_search 完成", {
      query,
      ...(market ? { market } : {}),
      ...(recency ? { recency } : {}),
      ...(allowed.length ? { allowed } : {}),
      ...(blocked.length ? { blocked } : {}),
      engine: mode.provider,
      mode: "api",
      count: finalResults.length,
      ms: Date.now() - startedAt,
      results: finalResults.map((r) => ({
        t: clipLog(r.title, 80),
        u: r.url,
        s: clipLog(r.snippet, 120),
      })),
    });
    if (finalResults.length === 0) {
      log.info("search", "搜索无结果", {
        query,
        ...(market ? { market } : {}),
        engine: mode.provider,
        ms: Date.now() - startedAt,
      });
      return {
        query,
        engine: mode.provider,
        results: [],
        note: "没有搜索到相关结果。可换更具体的核心词、或换一种语言的关键词重试;若已知答案请直接回答。",
      };
    }
    return { query, engine: mode.provider, results: finalResults };
  } catch (e) {
    const kind = classifyFailure(e, cancelSignal?.aborted ?? false);
    if (kind === "cancelled") {
      throw new Error("用户已取消本次搜索");
    }
    if (kind === "timeout" || kind === "blocked") {
      await coolDownEngine(
        mode.provider,
        kind === "timeout" ? "unreachable" : "blocked",
      );
    }
    const msg = e instanceof Error ? e.message : String(e);
    log.warn("search", "搜索服务失败", { provider: mode.provider, error: msg });
    throw new Error(`搜索服务(${mode.provider})请求失败:${msg}`);
  }
}

/** 读搜索模式:provider=auto 或没配 key → 免 Key 抓取兜底;否则 API 路径 */
async function readSearchMode(): Promise<
  { kind: "scrape" } | { kind: "api"; provider: SearchProviderId; baseUrl: string; apiKey: string }
> {
  const bag = await chrome.storage.local.get("search");
  const s = (bag.search ?? {}) as Partial<{
    provider: SearchProviderSetting;
    baseUrl: string;
    apiKey: string;
  }>;
  const apiKey = typeof s.apiKey === "string" ? s.apiKey.trim() : "";
  if (s.provider === "auto" || !apiKey) return { kind: "scrape" };
  const provider: SearchProviderId =
    s.provider && s.provider in SEARCH_PROVIDERS ? s.provider : "tavily";
  const baseUrl =
    typeof s.baseUrl === "string" && s.baseUrl.trim()
      ? s.baseUrl.trim().replace(/\/+$/, "")
      : SEARCH_PROVIDERS[provider].defaultBaseUrl;
  return { kind: "api", provider, baseUrl, apiKey };
}

function validateRecency(v: unknown): Recency {
  if (
    typeof v === "string" &&
    (RECENCY_VALUES as readonly string[]).includes(v)
  ) {
    return v as Recency;
  }
  throw new Error(
    `recency 只接受 ${RECENCY_VALUES.join(" / ")} 之一,收到:${JSON.stringify(v) ?? String(v)}`,
  );
}

const MARKET_RE = /^[a-z]{2,3}(?:-[a-z]{2,4})?$/i;

/** market 宽松校验并归一:小写语言 + 大写地区(zh-cn → zh-CN);空/缺省返回 null */
function validateMarket(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const raw = typeof v === "string" ? v.trim() : "";
  if (!raw || !MARKET_RE.test(raw)) {
    throw new Error(
      `market 需为「语言-地区」格式(如 zh-CN / ja-JP / en-US),收到:${JSON.stringify(v) ?? String(v)}`,
    );
  }
  const [lang, region] = raw.split("-");
  return region
    ? `${lang.toLowerCase()}-${region.toUpperCase()}`
    : lang.toLowerCase();
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
function passesDomainFilter(
  url: string,
  allowed: string[],
  blocked: string[],
): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false; // 非法 URL 视为不通过
  }
  if (
    allowed.length > 0 &&
    !allowed.some((d) => hostname === d || hostname.endsWith(`.${d}`))
  ) {
    return false;
  }
  return !blocked.some((d) => hostname === d || hostname.endsWith(`.${d}`));
}

/** 日志预览字段截断(标题/摘要用),压平空白 */
function clipLog(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
