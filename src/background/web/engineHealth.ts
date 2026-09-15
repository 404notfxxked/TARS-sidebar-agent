// 引擎健康表:网络环境的可达性探测 + 引擎动态排序。
// 背景:引擎可用性随网络环境翻转(实测:无代理时 ddg/google 直连超时,
// 开代理则 ddg 最优),静态引擎顺序会让死引擎每个冷却窗口白付一次 15s
// 加载超时。分层职责:
//   可达性(本模块,网络层)——SW 启动时节流探测一次(SW fetch 各引擎
//   首页、4s 超时,不开 tab 不发搜索词),真实搜索的超时/成功也回写;
//   风控质量(传输层)——由 tabSearch 的现有机制维护(验证码 → 会话级
//   冷却),不进本表:可达但被风控 ≠ 网络不通。
// 排序:dead 引擎沉到队尾,只有健康引擎全部失败才会级联到它们;
// 全部引擎失败时立即重新探测(覆盖「刚开代理」的网络翻转场景)。

import { createLogger } from "../../shared/logger";
import { hasPageAccess } from "../../shared/hostAccess";

const log = createLogger({ ctx: "bg" });

const HEALTH_KEY = "webSearch:engineHealth";
const PROBE_TIMEOUT_MS = 4_000;
const PROBE_TTL_MS = 6 * 3600_000;

export interface EngineHealthEntry {
  reach: "ok" | "dead";
  checkedAt: number;
}

type HealthMap = Record<string, EngineHealthEntry>;

/** 引擎 id → 可达性探测地址。用首页:按 host 判可达性,首页与搜索页同径;
 *  刻意不用搜索 URL,避免与 e2e 的引擎路由、节流计数相互纠缠。
 *  引擎 id 须与 tabSearch.ts 的 ENGINES 表一致 */
const PROBE_URLS: Record<string, string> = {
  ddg: "https://html.duckduckgo.com/",
  bing: "https://www.bing.com/",
  google: "https://www.google.com/",
  baidu: "https://www.baidu.com/",
};

async function loadHealth(): Promise<HealthMap> {
  try {
    const bag = await chrome.storage.local.get(HEALTH_KEY);
    return (bag[HEALTH_KEY] ?? {}) as HealthMap;
  } catch {
    return {};
  }
}

async function saveHealth(map: HealthMap): Promise<void> {
  try {
    await chrome.storage.local.set({ [HEALTH_KEY]: map });
  } catch {
    /* 健康表写失败无碍,大不了按静态顺序走 */
  }
}

/** 按健康表排序:可达/未知保持静态质量序在前,dead 沉底(相对次序不变) */
export function orderEnginesByHealth<T extends { id: string }>(
  engines: T[],
  health: HealthMap,
): T[] {
  const dead = engines.filter((e) => health[e.id]?.reach === "dead");
  return [...engines.filter((e) => health[e.id]?.reach !== "dead"), ...dead];
}

/** tabSearch 用:读健康表并返回排序后的引擎列表 */
export async function getOrderedEngines<T extends { id: string }>(
  engines: T[],
): Promise<T[]> {
  return orderEnginesByHealth(engines, await loadHealth());
}

/** 真实搜索的被动回写:tab 加载超时 = 网络不可达;搜索成功 = 可达。
 *  一分钟内的重复回写去重,避免每次搜索都写 storage */
export async function recordEngineReachability(
  engineId: string,
  reach: "ok" | "dead",
): Promise<void> {
  const map = await loadHealth();
  const prev = map[engineId];
  if (prev?.reach === reach && Date.now() - prev.checkedAt < 60_000) return;
  map[engineId] = { reach, checkedAt: Date.now() };
  await saveHealth(map);
  if (reach === "dead") {
    log.warn("search", "引擎标记为网络不可达,已移出优先队列", {
      engine: engineId,
    });
  }
}

// ---- 主动探测 ----

let probeInFlight: Promise<void> | null = null;

/** 并发探测各引擎首页(4s 超时),整表重写;在途去重 */
export function probeEngines(): Promise<void> {
  if (probeInFlight) return probeInFlight;
  probeInFlight = (async () => {
    // 探测靠 SW fetch 直连引擎首页,依赖 host 授权:未授权时探测必然全
    // dead,白写健康表还会把所有引擎永久沉底 —— 直接跳过(用户授权后,
    // 下一次搜索失败的兜底重探会补上真实结果)
    if (!(await hasPageAccess())) {
      log.debug("search", "未授予页面访问,跳过引擎可达性探测");
      return;
    }
    const entries = await Promise.all(
      Object.entries(PROBE_URLS).map(async ([id, url]) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
        try {
          await fetch(url, { signal: controller.signal });
          return [id, { reach: "ok", checkedAt: Date.now() }] as const;
        } catch {
          return [id, { reach: "dead", checkedAt: Date.now() }] as const;
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    await saveHealth(Object.fromEntries(entries));
    const dead = entries.filter(([, e]) => e.reach === "dead").map(([id]) => id);
    log.info("search", "引擎可达性探测完成", {
      dead: dead.length > 0 ? dead : "none",
    });
  })().finally(() => {
    probeInFlight = null;
  });
  return probeInFlight;
}

/** SW 启动钩子:健康表缺失或超龄(>6h)才探测;fire-and-forget,不阻塞启动 */
export async function maybeProbeEngines(): Promise<void> {
  const map = await loadHealth();
  const stale = Object.keys(PROBE_URLS).some((id) => {
    const e = map[id];
    return !e || Date.now() - e.checkedAt > PROBE_TTL_MS;
  });
  if (stale) void probeEngines();
}
