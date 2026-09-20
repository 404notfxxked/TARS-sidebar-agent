// 跨上下文诊断日志(background / offscreen / sidepanel 共用):
// - 每个上下文只写自己的环形缓冲 chrome.storage.local key(log:bg / log:off /
//   log:panel),分 key 写入互不竞争,content script 的 log:tab:<id> 由它的
//   本地小副本维护(content 无法运行时导入本模块——构建守卫,见 vite.config.js)
// - 环形缓冲:每 key 上限 MAX_ENTRIES 条,新进旧出;data 先脱敏再截断,
//   防止把 storage.local 的配额吃穿或把敏感值写盘
// - 导出由 sidepanel 完成(面板 → 下载 JSONL 给项目里的助手分析):
//   枚举所有 log:* key 按时间合并。扩展沙箱无法直接写文件系统,
//   「下载后放进仓库」这步手动拷贝是设计内的一次点击成本

import { errText } from "./errors";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogCtx = "bg" | "panel" | "off" | "cs";

/** 单条日志。data 在写入前已安全序列化 + 截断成字符串 */
export interface LogEntry {
  t: number; // 写入时刻 Date.now()
  seq: number; // 本上下文进程内单调递增,区分同毫秒先后
  ctx: LogCtx;
  level: LogLevel;
  tag: string; // 'agent' | 'tool' | 'port' | 'doc' | ...
  msg: string;
  data?: string;
  /** 仅 content script 副本填写 */
  tabId?: number;
}

// ---- 容量预算 ----
const MAX_ENTRIES = 400; // 每个 storage key 保留条数
const MAX_DATA_CHARS = 2000; // data 序列化后的最大字符数
const EXPORT_MAX_AGE_MS = 7 * 24 * 3600 * 1000; // 导出时丢弃 7 天前的旧条目
const REDACT_KEY_RE = /passw|pwd|secret|token|api[-_]?key|authorization/i;

/** content script 报到协议:cs 侧发 LOG_HELLO,bg 回 sender.tab.id。
 * cs 副本里用本地字面量同步此常量 */
export const LOG_HELLO = "log_hello";
export const LOG_HELLO_ACK = "log_hello_ack";

let seqCounter = 0;

function defaultKey(ctx: LogCtx): string {
  return `log:${ctx}`;
}

export interface Logger {
  debug(tag: string, msg: string, data?: unknown): void;
  info(tag: string, msg: string, data?: unknown): void;
  warn(tag: string, msg: string, data?: unknown): void;
  error(tag: string, msg: string, data?: unknown): void;
}

/**
 * 创建一个绑定上下文的 logger。
 * getKey 可覆盖 storage key(cs 副本报到手才拿到 tabId 前/后的 key 切换),
 * 不传则按 ctx 用默认 key。
 */
export function createLogger(opts: {
  ctx: LogCtx;
  getKey?: () => string;
}): Logger {
  const emit = (
    level: LogLevel,
    tag: string,
    msg: string,
    data?: unknown,
  ): void => {
    const entry: LogEntry = {
      t: Date.now(),
      seq: ++seqCounter,
      ctx: opts.ctx,
      level,
      tag,
      msg,
      ...(data !== undefined ? { data: serializeData(data) } : {}),
    };
    mirrorToConsole(entry);
    void appendBounded(opts.getKey?.() ?? defaultKey(opts.ctx), entry);
  };
  return {
    debug: (tag, msg, data) => emit("debug", tag, msg, data),
    info: (tag, msg, data) => emit("info", tag, msg, data),
    warn: (tag, msg, data) => emit("warn", tag, msg, data),
    error: (tag, msg, data) => emit("error", tag, msg, data),
  };
}

/** 全局兜底:未捕获异常与未处理的 promise rejection 自动进日志(SW / 页面通用) */
export function installGlobalErrorHook(log: Logger): void {
  const target = self as unknown as {
    addEventListener(type: "error", fn: (ev: ErrorEvent) => void): void;
    addEventListener(
      type: "unhandledrejection",
      fn: (ev: PromiseRejectionEvent) => void,
    ): void;
  };
  target.addEventListener("error", (ev) => {
    log.error("crash", `未捕获异常:${ev.message}`, {
      file: ev.filename || undefined,
      pos: `${ev.lineno}:${ev.colno}`,
      stack: ev.error instanceof Error ? ev.error.stack : undefined,
    });
  });
  target.addEventListener("unhandledrejection", (ev) => {
    const r = ev.reason;
    log.error(
      "crash",
      `未处理的 rejection:${errText(r)}`,
      { stack: r instanceof Error ? r.stack : undefined },
    );
  });
}

// ---- 写入 ----

// 同一 key 的写入串行化:get→append→set 并发交错时后者会整体覆盖前者丢日志
const writeChains = new Map<string, Promise<void>>();

function appendBounded(key: string, entry: LogEntry): Promise<void> {
  const prev = writeChains.get(key) ?? Promise.resolve();
  const next = prev.then(async () => {
    try {
      const bag = await chrome.storage.local.get(key);
      const arr = Array.isArray(bag[key]) ? (bag[key] as LogEntry[]) : [];
      arr.push(entry);
      if (arr.length > MAX_ENTRIES) arr.splice(0, arr.length - MAX_ENTRIES);
      await chrome.storage.local.set({ [key]: arr });
    } catch {
      /* 存储失败静默:context 失效 / 配额满时不能让日志拖垮业务 */
    }
  });
  writeChains.set(key, next);
  return next.finally(() => {
    if (writeChains.get(key) === next) writeChains.delete(key);
  });
}

/** 对象深走查:疑似敏感字段替换为 [redacted],数组/深度设上限防爆炸 */
function redact(v: unknown, depth: number): unknown {
  if (depth > 4 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redact(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = REDACT_KEY_RE.test(k) ? "[redacted]" : redact(val, depth + 1);
  }
  return out;
}

function serializeData(data: unknown): string {
  const safe = redact(data, 0);
  let s: string;
  try {
    s = typeof safe === "string" ? safe : JSON.stringify(safe) ?? String(safe);
  } catch {
    s = String(safe); // 循环引用等 stringify 失败兜底
  }
  return s.length > MAX_DATA_CHARS
    ? `${s.slice(0, MAX_DATA_CHARS)}…(+${s.length - MAX_DATA_CHARS} 字符已截断)`
    : s;
}

/** 双写到 console:开着 DevTools 时照常可见,存档行为不影响现场调试 */
function mirrorToConsole(e: LogEntry): void {
  const fn =
    e.level === "warn"
      ? console.warn
      : e.level === "error"
        ? console.error
        : console.log;
  const prefix = `[${e.ctx}/${e.tag}]`;
  if (e.data !== undefined) fn(prefix, e.msg, e.data);
  else fn(prefix, e.msg);
}

// ---- 读取 / 导出(panel 用;bg 的清理逻辑也复用 readAllLogEntries 思路)----

/** 枚举所有 log:* key 按时间合并排序,顺带过滤超龄条目 */
export async function readAllLogEntries(): Promise<LogEntry[]> {
  const bag = await chrome.storage.local.get(null);
  const out: LogEntry[] = [];
  const cutoff = Date.now() - EXPORT_MAX_AGE_MS;
  for (const [k, v] of Object.entries(bag)) {
    if (!k.startsWith("log:") || !Array.isArray(v)) continue;
    for (const e of v as LogEntry[]) {
      if (typeof e?.t === "number" && e.t >= cutoff) out.push(e);
    }
  }
  // 跨上下文 seq 不可比,同毫秒时用 ctx+seq 做个稳定次序即可
  out.sort(
    (a, b) =>
      a.t - b.t ||
      (a.ctx < b.ctx ? -1 : a.ctx > b.ctx ? 1 : a.seq - b.seq),
  );
  return out;
}

export function toJsonl(entries: LogEntry[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n");
}
