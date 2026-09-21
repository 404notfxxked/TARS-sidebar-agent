// web_search 免 Key 通道:后台新开真实搜索引擎标签页,读完整渲染的结果页。
// 真实标签页 = 完整浏览器指纹 + cookie + JS 渲染,是用户浏览器里最不容易
// 触发风控的请求形态(2026-09-10 双通道对照实测:同网络同引擎,SW fetch
// 的免 Key 抓取两轮全被 ddg 挑战,tab 通道 6/7 正常出结果,故抓取通道已
// 删,本通道成为唯一免 Key 路径)。读到的 HTML 交给 offscreen 的引擎解析器
// (searchParse.ts),选择器只负责「定位条目」,文本清洗与 URL 还原在那边。
// 加固手段:同引擎最小间隔节流(打散连发节律)+ 风控页标记识别 → 冷却 →
// 换下一引擎 + 加载超时 → 冷却(CN 网络对 google 的不可达只付一次代价)。

import {
  callOffscreenParser,
  ensureOffscreenDocument,
} from "../../shared/docBridge";
import { hasPageAccess } from "../../shared/hostAccess";
import { errText } from "../../shared/errors";
import { oneLine } from "../../shared/text";
import { getToolExecutionContext } from "../tools/toolContext";
import { createLogger } from "../../shared/logger";
import type { WebSearchResult } from "./webSearch";
import {
  getOrderedEngines,
  probeEngines,
  recordEngineReachability,
} from "./engineHealth";
import {
  COOLDOWN_MS,
  clearCooldown,
  coolDown,
  coolingDownEntry,
  type CooldownKind,
} from "./cooldown";
import { passesDomainFilter } from "./domainFilter";

const log = createLogger({ ctx: "bg" });

/** 等标签页 load complete 的超时 */
const TAB_LOAD_TIMEOUT_MS = 15_000;
/** complete 后的静置:给渐进渲染的页面留一点收尾时间 */
const TAB_SETTLE_MS = 800;
/** 同引擎两次请求的最小间隔:打散 agent 一轮 4-5 连发的机器特征 */
const MIN_INTERVAL_MS = 2_500;

export interface TabSearchArgs {
  query: string;
  limit: number;
  allowed: string[];
  blocked: string[];
}

interface TabEngine {
  id: string;
  buildUrl: (q: string) => string;
  /** 结果区命中标记且解析不出条目 → 风控/验证页(而非无结果),进冷却换下一家 */
  blockMarkers?: RegExp;
}

// ---- 引擎表:ddg 主力 → bing 兜底 → google / baidu 储备 ----
// 顺序依据(2026-09-10 双通道对照实测):tab 通道下 ddg 对中英文都稳且
// fail-closed(风控给可检测的挑战页,能干净冷却);bing fail-open(降级页
// 结构完整、内容垃圾,只能事后识别,放第二);google 海外质量最高但 CN
// 网络表现为加载超时(超时 → 冷却 10 分钟,每个冷却窗口只付一次代价);
// baidu 中文兜底(结果链接是加密跳转包装,无法本地还原,SW fetch 读取时会
// 跟随到真实 URL)。此静态序只是健康表为空时的初值:运行时由
// engineHealth.ts 按可达性动态排序(dead 沉底),语言分流待有数据再议。

const ENGINES: TabEngine[] = [
  {
    id: "ddg",
    buildUrl: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    blockMarkers: /anomaly|captcha/i,
  },
  {
    id: "bing",
    buildUrl: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
    blockMarkers: /grecaptcha|challengesurvey/i,
  },
  {
    id: "google",
    buildUrl: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
    blockMarkers: /unusual traffic|g-recaptcha|captcha/i,
  },
  {
    id: "baidu",
    buildUrl: (q) => `https://www.baidu.com/s?wd=${encodeURIComponent(q)}`,
    blockMarkers: /wappass|百度安全验证|安全验证/i,
  },
];

// ---- 同引擎节流(进程内即可:SW 被杀重启后节律记忆丢失可接受) ----
const lastHitAt = new Map<string, number>();

async function pace(engineId: string): Promise<void> {
  const prev = lastHitAt.get(engineId) ?? 0;
  const wait = MIN_INTERVAL_MS - (Date.now() - prev);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastHitAt.set(engineId, Date.now());
}

export async function runTabSearch(args: TabSearchArgs): Promise<WebSearchResult> {
  const { query, limit, allowed, blocked } = args;
  const cancelSignal = getToolExecutionContext()?.signal;
  // 页面访问授权是 tab 通道的前提(extractTabHtml 靠 executeScript 读结果页):
  // 未授权时所有引擎都会死在同一个坑,快速失败,不逐个引擎烧 15s 加载超时
  if (!(await hasPageAccess())) {
    throw new Error(
      "Web search is unavailable: site access has not been granted. Tell the user to enable \"页面与网络访问\" in TARS Settings → Security, then retry",
    );
  }
  await ensureOffscreenDocument();

  const startedAt = Date.now();
  const failures: string[] = [];
  let lastGoodEngine = "";

  // 引擎健康表动态排序:网络不可达的引擎沉底(见 engineHealth.ts)
  const engines = await getOrderedEngines(ENGINES);
  for (const engine of engines) {
    if (cancelSignal?.aborted) throw new Error("Search cancelled by the user");
    try {
      await throwIfCoolingDown(engine.id);
    } catch (e) {
      const msg = errText(e);
      failures.push(`${engine.id}: ${msg}`);
      log.info("search", "引擎冷却中,跳过", { engine: engine.id, error: msg });
      continue;
    }
    // openTab 也在 try 内:tabs.create 抛错(窗口正在关闭等时序)按引擎失败
    // 换下一家,与逐引擎降级的设计一致;finally 对无 tab 的 remove 走 catch no-op
    let tabId: number | undefined;
    try {
      tabId = await openTab();
      await pace(engine.id);
      // 监听先就位、再发导航:target 一创建就带 URL 的话,首航请求可能在
      // 任何监听方(含测试的拦截层)就绪前已经发车,两段式保证确定性
      const loaded = waitForTabComplete(tabId, cancelSignal);
      await chrome.tabs.update(tabId, { url: engine.buildUrl(query) });
      await loaded;
      await new Promise((r) => setTimeout(r, TAB_SETTLE_MS));
      const html = await extractTabHtml(tabId);
      // 相对链接还原的 base:拿 tab 的最终 URL(搜索引擎可能做地区跳转)
      const base =
        (await chrome.tabs.get(tabId).catch(() => null))?.url ||
        engine.buildUrl(query);
      const results = (await callOffscreenParser("search", {
        engine: engine.id,
        html,
        base,
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
        failures.push(`${engine.id}: no results`);
        log.info("search", "引擎无结果,切换下一个", {
          engine: engine.id,
          query: oneLine(query, 40),
        });
        continue;
      }
      clearEngineCooldown(engine.id);
      void recordEngineReachability(engine.id, "ok");
      log.info("search", "web_search 完成", {
        query: oneLine(query, 40),
        engine: engine.id,
        mode: "tab",
        count: filtered.length,
        ms: Date.now() - startedAt,
        results: filtered.slice(0, limit).map((r) => ({
          t: oneLine(r.title, 80),
          u: r.url,
          s: oneLine(r.snippet, 120),
        })),
      });
      return { query, engine: engine.id, results: filtered.slice(0, limit) };
    } catch (e) {
      const msg = errText(e);
      if (cancelSignal?.aborted) throw new Error("Search cancelled by the user");
      if (/timeout/i.test(msg)) {
        await coolDownEngine(engine.id, "unreachable");
        // 网络层不可达写进健康表:沉底排序跨冷却窗口生效,死引擎不再
        // 每个窗口白付一次 15s 加载超时
        void recordEngineReachability(engine.id, "dead");
      }
      if (/HTTP (403|429)/.test(msg))
        await coolDownEngine(engine.id, "blocked");
      failures.push(`${engine.id}: ${msg}`);
      log.warn("search", "引擎失败,切换下一个", {
        engine: engine.id,
        error: msg,
      });
    } finally {
      // openTab 失败时无 tab 可关:undefined 的 remove 拒绝走 catch no-op
      if (tabId !== undefined) {
        void chrome.tabs.remove(tabId).catch(() => {});
      }
    }
  }

  if (!lastGoodEngine) {
    // 全军覆没:可能刚发生网络翻转(如开了代理),立即重探一遍健康表,
    // 下一搜就能按新环境排序
    void probeEngines();
    throw new Error(
      `All search engines failed (${failures.join("; ")}). Check the network or retry later; if the task allows, use another information source instead (e.g. web_fetch a known URL directly)`,
    );
  }
  return {
    query,
    engine: lastGoodEngine,
    results: [],
    note: "No relevant results found. Try more specific core keywords, or keywords in another language; if you already know the answer, answer directly.",
  };
}

// ---- 失败冷却(storage.session,与 API 路径共用同一张表,状态机见 ./cooldown.ts)----
// 这里只留外壳:状态读写收口在 cooldown.ts,本通道的 warn 文案/字段留在此处。

async function coolDownEngine(id: string, kind: CooldownKind): Promise<void> {
  await coolDown(id, kind);
  log.warn("search", "引擎进入冷却,近期搜索将跳过", {
    engine: id,
    kind,
    minutes: COOLDOWN_MS[kind] / 60_000,
  });
}

/** 引擎在冷却期内则直接抛错(文案可转告用户),调用方跳到下一引擎 */
async function throwIfCoolingDown(id: string): Promise<void> {
  const hit = await coolingDownEntry(id);
  if (!hit) return;
  const min = Math.max(1, Math.round((hit.until - Date.now()) / 60_000));
  throw new Error(
    `Search engine ${id} was just rate-limited and is cooling down (~${min} min left)`,
  );
}

function clearEngineCooldown(id: string): void {
  void clearCooldown(id);
}

// ---- 标签页操作 ----

/** 后台开一个空白标签页;导航由调用方在监听就位后再发起(openTab 两段式) */
async function openTab(): Promise<number> {
  const tab = await chrome.tabs.create({ active: false });
  if (tab.id == null) throw new Error("Failed to open search tab");
  return tab.id;
}

/** 等待标签页加载完成;用户关掉 tab / 中止 run / 超时都以错误失败本引擎。
 *  调用方必须先挂本监听、后发导航(tabs.update)。注意新建 tab 的 about:blank
 *  首载也发 complete —— tabs.create 与 tabs.update 之间事件投递是异步的,
 *  空白页的 complete 可能落在监听就位后、导航生效前,因此 complete 时还要
 *  校验 tab 已离开空白页,否则会提前 resolve 读到 about:blank */
function waitForTabComplete(
  tabId: number,
  external?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      external?.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            `timeout: tab load exceeded ${TAB_LOAD_TIMEOUT_MS / 1000}s`,
          ),
        ),
      TAB_LOAD_TIMEOUT_MS,
    );
    const onUpdated = (
      id: number,
      info: chrome.tabs.TabChangeInfo,
    ): void => {
      if (id !== tabId || info.status !== "complete") return;
      chrome.tabs
        .get(tabId)
        .then((t) => {
          const url = t.url ?? "";
          if (url && !url.startsWith("about:")) finish();
          // 仍停在空白页:导航尚未生效,等导航后的下一次 complete
        })
        .catch(() => finish(new Error("tab closed before load completed")));
    };
    const onRemoved = (id: number): void => {
      if (id === tabId) finish(new Error("tab closed before load completed"));
    };
    const onAbort = (): void => finish(new Error("aborted"));
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    external?.addEventListener("abort", onAbort);
  });
}

/** 取整页 HTML(隔离世界读同一 DOM);复用 offscreen 的引擎解析器。
 *  注意:导航被 4xx/断网挡下时 Chrome 落在内部错误页,注入会抛错——
 *  按引擎失败换下一家(内容型风控页仍可注入,由 blockMarkers 识别) */
async function extractTabHtml(tabId: number): Promise<string> {
  const [ins] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => document.documentElement.outerHTML,
  });
  const html = ins?.result;
  if (typeof html !== "string" || !html.trim()) {
    throw new Error("Empty response");
  }
  return html;
}
