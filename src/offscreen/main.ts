// Offscreen document 常驻入口:
// 持有各 tab 的虚拟文档快照(LRU 上限),处理来自 service worker 的
// DOC_TOOL_CALL / DOC_TOOL_INVALIDATE。快照缺失时向 SW 发 CAPTURE_DOC_REQUEST,
// 由 SW 向目标 tab 的 content script 索取 HTML——本上下文没有 chrome.tabs /
// chrome.scripting 权限面(offscreen 只开放 runtime 消息等子集),
// 中继协议见 shared/docBridge.ts。

import {
  buildVirtualDoc,
  runPageFind,
  runPageOutline,
  runPageRead,
  type CaptureMeta,
  type VirtualDoc,
} from "./pipeline";
import { fetchBuild, fetchRead } from "./fetchDoc";
import { parseSearchResults } from "./searchParse";
import { SnapshotPool } from "./snapshotPool";
import { createLogger, installGlobalErrorHook } from "../shared/logger";
import { errText } from "../shared/errors";

const log = createLogger({ ctx: "off" });
installGlobalErrorHook(log);

/** 快照缓存份数上限,超出淘汰最久未使用的 */
const DOC_CACHE_MAX = 6;

/**
 * 经 SW 中继抓取页面快照(docBridge 转发给目标 tab 的 capture_doc;
 * 剩余的兜底注入、受限页报错都在那一侧处理)。超时给得比中继侧
 * 20s 宽裕,让真实错误先到,而不是先在这里掐断。
 */
function requestCaptureDoc(tabId: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("capture_doc 中继超时")),
      25_000,
    );
    chrome.runtime.sendMessage(
      { type: "CAPTURE_DOC_REQUEST", tabId },
      (raw: unknown) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          reject(
            new Error(
              String(chrome.runtime.lastError.message ?? "runtime message failed"),
            ),
          );
          return;
        }
        const resp = raw as { type?: string; ok?: boolean; result?: unknown; error?: string };
        if (resp?.type !== "CAPTURE_DOC_RESPONSE") {
          reject(new Error("invalid capture response"));
          return;
        }
        if (!resp.ok) reject(new Error(resp.error ?? "unknown capture error"));
        else resolve(resp.result);
      },
    );
  });
}

// 缓存/单飞合并/LRU 全在 SnapshotPool(并发语义可单测);这里只负责采集
// 动作本身:向 content 索取 HTML → 构建虚拟文档 → 记录重建诊断
const pool = new SnapshotPool<VirtualDoc>(async (tabId, refresh) => {
  const startedAt = Date.now();
  const meta = await requestCaptureDoc(tabId);
  const cap = meta as Partial<CaptureMeta>;
  if (!cap || typeof cap.html !== "string" || !cap.html) {
    throw new Error("capture_doc 返回内容异常");
  }
  const doc = buildVirtualDoc({
    html: cap.html,
    baseURI: cap.baseURI ?? "",
    url: cap.url ?? "",
    title: cap.title ?? "",
    // content 侧的采样截断上报必须消费(REQ-P0-1):透出为 source_truncated
    truncated: cap.truncated === true,
  });
  // 快照重建是 page_* 工具最常见的第一跳,耗时与输入/输出体量记下来:
  // htmlBytes 大而 mdChars 异常小 = 采集到了但解析/分节丢内容,排查入口
  log.info("doc", `快照已重建(tab ${tabId})`, {
    ms: Date.now() - startedAt,
    htmlBytes: cap.html.length,
    url: cap.url || undefined,
    refresh,
    mdChars: doc.totalChars,
    headings: doc.headings.length,
    ...(doc.truncatedTotal ? { truncatedTotal: true } : {}),
    ...(doc.sourceTruncated ? { sourceTruncated: true } : {}),
  });
  return doc;
}, DOC_CACHE_MAX);

async function ensureSnapshot(tabId: number, refresh?: boolean): Promise<VirtualDoc> {
  try {
    return await pool.get(tabId, refresh);
  } catch (e) {
    const msg = errText(e);
    throw new Error(
      `无法读取目标页面(tab ${tabId}):${msg}。可能是受限页(chrome://、PDF、商店页)、` +
        `已关闭的 tab 或页面尚未加载完成;请先确认目标再重试`,
    );
  }
}

async function handleDocTool(name: string, args: unknown, targetTabId: number, refresh: boolean): Promise<unknown> {
  const doc = await ensureSnapshot(targetTabId, refresh);
  switch (name) {
    case "page_read":
      return runPageRead(
        doc,
        (args as { offset?: unknown })?.offset,
        (args as { chars?: unknown })?.chars,
      );
    case "page_find":
      return runPageFind(doc, (args as { query?: unknown })?.query, (args as { limit?: unknown })?.limit);
    case "page_outline":
      return runPageOutline(doc);
    default:
      throw new Error(`unknown document tool: ${name}`);
  }
}

// ---- 一次性解析任务(PARSE_CALL,不依赖任何 tab 快照)----
// 与 DOC_TOOL_CALL 的区别:数据由 SW 随消息自带(web_fetch 抓到的网页 HTML),
// 不需要先向某个 tab 索取快照

// async:内部 throw 必须变成 rejected promise —— 同步 throw 会逃出
// Promise.resolve(...) 成为 listener 未捕获异常,SW 侧拿到的是被 Chrome
// 包装过的错误文本(如 "Uncaught Error: ..."),协议约定的错误前缀会失效
async function handleParse(kind: string, payload: unknown): Promise<unknown> {
  switch (kind) {
    case "search": {
      const p = (payload ?? {}) as {
        engine?: unknown;
        html?: unknown;
        base?: unknown;
        limit?: unknown;
      };
      if (typeof p.html !== "string" || !p.html) {
        throw new Error("search 解析任务缺少 html 内容");
      }
      return parseSearchResults(
        typeof p.engine === "string" ? p.engine : "",
        p.html,
        typeof p.base === "string" ? p.base : "",
        typeof p.limit === "number" ? p.limit : 10,
      );
    }
    case "fetch_build": {
      const p = (payload ?? {}) as { url?: unknown; html?: unknown; base?: unknown };
      if (typeof p.url !== "string" || typeof p.html !== "string" || typeof p.base !== "string") {
        throw new Error("fetch_build 参数不完整");
      }
      return fetchBuild({ url: p.url, html: p.html, base: p.base });
    }
    case "fetch_read": {
      const p = (payload ?? {}) as { url?: unknown };
      if (typeof p.url !== "string" || !p.url) throw new Error("fetch_read 缺少 url");
      return fetchRead(p as { url: string; offset?: unknown; chars?: unknown });
    }
    default:
      throw new Error(`unknown parse kind: ${kind}`);
  }
}

chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
  const msg = raw as
    | {
        type?: string;
        id?: string | number;
        name?: string;
        args?: unknown;
        targetTabId?: number;
        refresh?: boolean;
        tabId?: number;
        kind?: string;
        payload?: unknown;
      };
  if (msg?.type === "DOC_TOOL_CALL") {
    handleDocTool(msg.name ?? "", msg.args, msg.targetTabId ?? -1, msg.refresh === true)
      .then((result) =>
        sendResponse({ type: "DOC_TOOL_RESULT", id: msg.id, ok: true, result }),
      )
      .catch((e: unknown) => {
        const error = errText(e);
        log.error("doc", `${msg.name ?? "?"} 失败`, {
          targetTabId: msg.targetTabId,
          error,
        });
        sendResponse({
          type: "DOC_TOOL_RESULT",
          id: msg.id,
          ok: false,
          error,
        });
      });
    return true; // 异步响应
  }
  if (msg?.type === "PARSE_CALL") {
    Promise.resolve(handleParse(msg.kind ?? "", msg.payload))
      .then((result) =>
        sendResponse({ type: "PARSE_RESULT", id: msg.id, ok: true, result }),
      )
      .catch((e) => {
        const error = errText(e);
        log.error("parse", `${msg.kind ?? "?"} 解析失败`, { error });
        sendResponse({ type: "PARSE_RESULT", id: msg.id, ok: false, error });
      });
    return true; // 异步响应
  }
  if (msg?.type === "DOC_TOOL_INVALIDATE") {
    if (typeof msg.tabId === "number") pool.invalidate(msg.tabId);
    return false;
  }
  return false;
});
