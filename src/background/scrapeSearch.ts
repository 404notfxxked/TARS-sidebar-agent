// web_search 免 Key 兜底路径:抓取搜索结果页 HTML 并解析(service worker 侧)。
// 仅在「联网开启且未配置搜索服务(provider=auto)」时启用。
//
// ── 风控现实(2026-09 实测 + 业界调研,详见 tests/../docs)──
// 判定自动化搜索的信号分层:TLS/HTTP2 指纹 > IP 信誉(机房/共享代理段预标记)
// > cookie/挑战通行状态 > 头一致性 > 请求速率/行为模式。本扩展运行在真实
// Chrome 里,网络栈指纹与 sec-fetch-* 天然真实——劣势只剩 cookie、语言头、
// 节律与出口 IP。因此加固手段按此收敛:
//   1. credentials include:蹭浏览器已有 cookie(Bing 市场偏好 / DDG 挑战通行,
//      用户正常访问过一次搜索引擎就自动携带,等价本人请求)
//   2. Accept-Language 恒定携带(真实浏览器必发,缺失本身是指纹);值取界面语言
//      或查询的 market 参数;Bing 另带 mkt/setlang,DDG 带 kl
//   3. 每引擎最小间隔节流:agent 一轮 4-5 连发是最典型的机器特征,同引擎请求
//      强制拉开间隔
//   4. 挑战/风控页识别(blockMarkers)→ 该引擎进冷却 → 换下一引擎;全部失败
//      才向模型报错(可转告用户去配置搜索服务)
// Google 不做引擎:对非常规流量挑战最激进(「unusual traffic」软封锁),且对
// 机房 IP 几乎必弹验证;Mojeek 实测对代理出口 Captcha、对 CN 段 403,一并放弃。
//
// 已知的诚实边界:出口 IP 信誉被烧(共享代理/机房段)时,任何请求形态修改都
// 无效——实测同一代理出口上 Bing 降级、DDG/Mojeek 挑战,直连/住宅 IP 则一切
// 正常。免 Key 模式的定位是「干净网络下的零配置兜底」,不是对抗手段。

import {
  callOffscreenParser,
  ensureOffscreenDocument,
} from "../shared/docBridge";
import { abortWithTimeout, getToolExecutionContext } from "./toolContext";
import { createLogger } from "../shared/logger";
import type { WebSearchResult } from "./webSearch";

const log = createLogger({ ctx: "bg" });

const FETCH_TIMEOUT_MS = 10_000;
/** 同引擎两次请求的最小间隔:打散 agent 一轮 4-5 连发的机器特征 */
const MIN_INTERVAL_MS = 2_500;

export interface ScrapeArgs {
  query: string;
  limit: number;
  allowed: string[];
  blocked: string[];
}

interface ScrapeRequest {
  url: string;
  acceptLanguage?: string;
}

interface ScrapeEngine {
  id: string;
  buildRequest: (query: string, uiLang: string) => ScrapeRequest;
  /** 响应命中标记且解析不出结果 → 判定为风控/验证页而非「无结果」,继续换引擎 */
  blockMarkers?: RegExp;
}

// ---- 请求形态:最小化实验 ----
// URL 只带 q,不带 count/mkt/setlang/时间过滤等任何辅助参数——排查「降级结果
// 是不是辅助参数引发」。recency/market 在抓取通道被忽略(工具描述已注明仅
// 搜索服务通道支持);Accept-Language 头保留:真实浏览器必发,缺失本身是指纹。

// ---- 引擎顺序:ddg 在前,bing 兜底 ----
// 两家失败形态相反:ddg fail-closed(风控给挑战页,可检测),bing fail-open
// (降级页结构完整、内容垃圾,agent 无告警地吃下)。fail-closed 放第一,
// 健康时结果可信、被标记时干净失败落入冷却/兜底;fail-open 放最后当安全网,
// 避免它以「成功」的姿态污染观察。CN 直连用户首搜会在 ddg 超时一次,
// 之后冷却窗口内直接走 bing。

const ENGINES: ScrapeEngine[] = [
  {
    id: "ddg",
    buildRequest: (q, uiLang) => ({
      url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
      acceptLanguage: acceptLanguageFor(deriveMarket(uiLang)),
    }),
    blockMarkers: /anomaly|captcha/i,
  },
  {
    id: "bing",
    buildRequest: (q, uiLang) => ({
      url: `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
      acceptLanguage: acceptLanguageFor(deriveMarket(uiLang)),
    }),
    blockMarkers: /grecaptcha|challengesurvey/i,
  },
];

/** 界面语言 → 默认市场(zh-CN / en-US / xx-XX);拿不准回 en-US,仅用于语言头 */
function deriveMarket(uiLang: string): string {
  const m = /^([a-z]{2,3})[-_]([a-zA-Z]{2,4})/.exec(uiLang ?? "");
  return m ? `${m[1]}-${m[2].toUpperCase()}` : "en-US";
}

function acceptLanguageFor(market: string): string {
  return `${market},${market.split("-")[0]};q=0.9`;
}

// ---- 同引擎节流(进程内即可:SW 被杀重启后节律记忆丢失可接受) ----
const lastHitAt = new Map<string, number>();

async function pace(engineId: string): Promise<void> {
  const prev = lastHitAt.get(engineId) ?? 0;
  const wait = MIN_INTERVAL_MS - (Date.now() - prev);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastHitAt.set(engineId, Date.now());
}

export async function runScrapeSearch(
  args: ScrapeArgs,
): Promise<WebSearchResult> {
  const { query, limit, allowed, blocked } = args;
  const cancelSignal = getToolExecutionContext()?.signal;
  await ensureOffscreenDocument();
  const uiLang = chrome.i18n?.getUILanguage?.() ?? "en-US";

  const startedAt = Date.now();
  const failures: string[] = [];
  let lastGoodEngine = "";

  for (const engine of ENGINES) {
    if (cancelSignal?.aborted) throw new Error("Search cancelled by the user");
    try {
      await throwIfCoolingDown(engine.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failures.push(`${engine.id}: ${msg}`);
      log.info("search", "引擎冷却中,跳过", { engine: engine.id, error: msg });
      continue;
    }
    try {
      await pace(engine.id);
      const req = engine.buildRequest(query, uiLang);
      const { html, finalUrl } = await fetchHtml(req, cancelSignal);
      const results = (await callOffscreenParser("search", {
        engine: engine.id,
        html,
        base: finalUrl,
        limit,
      })) as { title: string; url: string; snippet: string }[];
      if (!Array.isArray(results)) throw new Error("Malformed parse result");

      const beforeFilter = results.length;
      const filtered = results.filter((r) =>
        passesDomainFilter(r.url, allowed, blocked),
      );
      if (
        beforeFilter > 0 &&
        filtered.length === 0 &&
        (allowed.length > 0 || blocked.length > 0)
      ) {
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
          note: `${beforeFilter} results found but all excluded by domain filters. Relax allowed_domains / blocked_domains and retry, or drop the filter parameters.`,
        };
      }
      if (filtered.length === 0) {
        if (engine.blockMarkers?.test(html)) {
          await coolDownEngine(engine.id, "blocked");
          throw new Error("Engine returned a bot-check / captcha page");
        }
        lastGoodEngine = engine.id;
        log.info("search", "引擎无结果,切换下一个", {
          engine: engine.id,
          query,
        });
        continue;
      }
      clearEngineCooldown(engine.id);
      log.info("search", "web_search 完成", {
        query,
        engine: engine.id,
        mode: "scrape",
        count: filtered.length,
        ms: Date.now() - startedAt,
        results: filtered.slice(0, limit).map((r) => ({
          t: clipLog(r.title, 80),
          u: r.url,
          s: clipLog(r.snippet, 120),
        })),
      });
      return { query, engine: engine.id, results: filtered.slice(0, limit) };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (cancelSignal?.aborted) throw new Error("Search cancelled by the user");
      if (/timeout/i.test(msg)) await coolDownEngine(engine.id, "unreachable");
      if (/HTTP (403|429)/.test(msg))
        await coolDownEngine(engine.id, "blocked");
      failures.push(`${engine.id}: ${msg}`);
      log.warn("search", "引擎失败,切换下一个", {
        engine: engine.id,
        error: msg,
      });
    }
  }

  if (!lastGoodEngine) {
    throw new Error(
      `All search engines failed (${failures.join("; ")}). The key-free scraping channel may be blocked for this network; configure a search provider (Tavily / Bocha / Brave) in Settings → Web search for stable results`,
    );
  }
  return {
    query,
    engine: lastGoodEngine,
    results: [],
    note: "No relevant results found. Try more specific core keywords, or keywords in another language; if you already know the answer, answer directly.",
  };
}

/** SW 内 fetch:host_permissions 覆盖 <all_urls>。credentials include = 蹭浏览器
 *  已有 cookie(挑战通行/市场偏好),等价本人正常访问;Accept-Language 恒定携带 */
async function fetchHtml(
  req: ScrapeRequest,
  external?: AbortSignal,
): Promise<{ html: string; finalUrl: string }> {
  const { signal, cleanup } = abortWithTimeout(FETCH_TIMEOUT_MS, external);
  try {
    const res = await fetch(req.url, {
      signal,
      credentials: "include",
      headers: req.acceptLanguage
        ? { "Accept-Language": req.acceptLanguage }
        : undefined,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    if (!html.trim()) throw new Error("Empty response");
    return { html, finalUrl: res.url || req.url };
  } finally {
    cleanup();
  }
}

// ---- 引擎冷却(storage.session,与 API 路径共用同一个 key:被标记的引擎
//      不论走哪条路径都该跳)----
const COOLDOWN_KEY = "webSearch:engineCooldown";

type CooldownKind = "blocked" | "unreachable";

async function coolDownEngine(id: string, kind: CooldownKind): Promise<void> {
  const minutes = kind === "blocked" ? 5 : 10;
  try {
    const bag = await chrome.storage.session.get(COOLDOWN_KEY);
    const map = (bag[COOLDOWN_KEY] ?? {}) as Record<
      string,
      { until: number; kind: CooldownKind }
    >;
    map[id] = { until: Date.now() + minutes * 60_000, kind };
    await chrome.storage.session.set({ [COOLDOWN_KEY]: map });
  } catch {
    /* 冷却写失败无碍 */
  }
  log.warn("search", "引擎进入冷却,近期搜索将跳过", {
    engine: id,
    kind,
    minutes,
  });
}

/** 引擎在冷却期内则直接抛错(文案可转告用户),调用方跳到下一引擎 */
async function throwIfCoolingDown(id: string): Promise<void> {
  let bag: Record<string, unknown>;
  try {
    bag = await chrome.storage.session.get(COOLDOWN_KEY);
  } catch {
    return; /* 存储读失败视为无冷却 */
  }
  const hit = ((bag[COOLDOWN_KEY] ?? {}) as Record<string, { until?: number }>)[id];
  if (hit?.until != null && hit.until > Date.now()) {
    const min = Math.max(1, Math.round((hit.until - Date.now()) / 60_000));
    throw new Error(`Search engine ${id} was just rate-limited and is cooling down (~${min} min left)`);
  }
}

function clearEngineCooldown(id: string): void {
  void (async () => {
    try {
      const bag = await chrome.storage.session.get(COOLDOWN_KEY);
      const map = bag[COOLDOWN_KEY] ?? {};
      if (!map[id]) return;
      delete map[id];
      await chrome.storage.session.set({ [COOLDOWN_KEY]: map });
    } catch {
      /* ignore */
    }
  })();
}

function passesDomainFilter(
  url: string,
  allowed: string[],
  blocked: string[],
): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (
    allowed.length > 0 &&
    !allowed.some((d) => hostname === d || hostname.endsWith(`.${d}`))
  ) {
    return false;
  }
  return !blocked.some((d) => hostname === d || hostname.endsWith(`.${d}`));
}

function clipLog(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
