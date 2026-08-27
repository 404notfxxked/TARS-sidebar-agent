// 内容脚本专用的日志本地小副本 —— 与 src/shared/logger.ts 的条目结构保持一致。
// 为什么不运行时复用共享模块:vite 构建守卫要求 content.js 自包含经典脚本,
// 共享模块会被拆成公共 chunk,content.js 顶部出现 import 即 SyntaxError;
// 故只允许 type-only import(结构改动时 tsc 会报错提醒同步),常量用本地字面量,
// 与 content/index.ts 手抄协议常量是同一先例。同步义务:字段结构、容量常量、
// LOG_HELLO 常量值变更时须两处同步。

import type { LogEntry } from "../shared/logger";

// 与 shared/logger.ts 的 LOG_HELLO / LOG_HELLO_ACK 保持一致(经典脚本不能运行时导入)
const LOG_HELLO = "log_hello";
const LOG_HELLO_ACK = "log_hello_ack";

const MAX_ENTRIES = 400;
const MAX_DATA_CHARS = 2000;
const REDACT_KEY_RE = /passw|pwd|secret|token|api[-_]?key|authorization/i;

type Level = "debug" | "info" | "warn" | "error";

let seqCounter = 0;
let tabId: number | undefined;
/** 报到手之前的回退 key;多个 tab 短暂共用时会互相覆盖(环形缓冲,可接受) */
let storageKey = "log:cs";
const buf: LogEntry[] = [];

let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;

function emit(level: Level, tag: string, msg: string, data?: unknown): void {
  const entry: LogEntry = {
    t: Date.now(),
    seq: ++seqCounter,
    ctx: "cs",
    level,
    tag,
    msg,
    ...(tabId !== undefined ? { tabId } : {}),
    ...(data !== undefined ? { data: serializeData(data) } : {}),
  };
  // 双写 console:页面控制台照常可见
  const fn =
    level === "warn" ? console.warn : level === "error" ? console.error : console.log;
  fn(`[cs/${tag}]`, msg, entry.data ?? "");
  buf.push(entry);
  if (buf.length > MAX_ENTRIES) buf.splice(0, buf.length - MAX_ENTRIES);
  scheduleFlush();
}

export const log = {
  debug: (tag: string, msg: string, data?: unknown) => emit("debug", tag, msg, data),
  info: (tag: string, msg: string, data?: unknown) => emit("info", tag, msg, data),
  warn: (tag: string, msg: string, data?: unknown) => emit("warn", tag, msg, data),
  error: (tag: string, msg: string, data?: unknown) => emit("error", tag, msg, data),
};

function scheduleFlush(): void {
  if (flushTimer !== null || flushing) return;
  flushTimer = setTimeout(flush, 400);
}

async function flush(): Promise<void> {
  flushTimer = null;
  if (flushing || buf.length === 0) return;
  flushing = true;
  const expectedLen = buf.length;
  try {
    await chrome.storage.local.set({ [storageKey]: [...buf] });
  } catch {
    /* 扩展重载(context invalidated)/配额满:静默放弃本次落盘 */
  }
  flushing = false;
  // 落盘期间又有新日志 → 再排一次,保证最终一致
  if (buf.length !== expectedLen) scheduleFlush();
}

// 向 SW 报到拿自己的 tabId:拿到后换专属 key 并把已缓冲的历史迁过去。
// 没握上手(SW 未就绪等)就一直用 log:cs 回退,不阻塞任何业务路径
try {
  chrome.runtime.sendMessage({ type: LOG_HELLO }, (resp: unknown) => {
    if (chrome.runtime.lastError) return;
    const ack = resp as { type?: string; tabId?: number };
    if (
      ack?.type === LOG_HELLO_ACK &&
      typeof ack.tabId === "number" &&
      ack.tabId !== tabId
    ) {
      tabId = ack.tabId;
      storageKey = `log:tab:${ack.tabId}`;
      scheduleFlush();
    }
  });
} catch {
  /* 扩展上下文失效:退化为纯 console 输出 */
}

// 全局兜底:隔离世界的未捕获异常 / unhandledrejection 进日志
try {
  window.addEventListener("error", (ev) => {
    emit(
      "error",
      "crash",
      `未捕获异常:${ev.message}`,
      ev.error instanceof Error ? { stack: ev.error.stack } : undefined,
    );
  });
  window.addEventListener("unhandledrejection", (ev) => {
    const r = (ev as PromiseRejectionEvent).reason;
    emit(
      "error",
      "crash",
      `未处理的 rejection:${r instanceof Error ? r.message : String(r)}`,
      r instanceof Error ? { stack: r.stack } : undefined,
    );
  });
} catch {
  /* 同上 */
}

// ---- 与 shared/logger.ts 对应的脱敏与截断 ----

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
    s = String(safe);
  }
  return s.length > MAX_DATA_CHARS
    ? `${s.slice(0, MAX_DATA_CHARS)}…(+${s.length - MAX_DATA_CHARS} 字符已截断)`
    : s;
}
