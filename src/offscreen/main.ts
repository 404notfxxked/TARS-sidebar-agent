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
import { createLogger, installGlobalErrorHook } from "../shared/logger";

const log = createLogger({ ctx: "off" });
installGlobalErrorHook(log);

/** 快照缓存份数上限,超出淘汰最久未使用的 */
const DOC_CACHE_MAX = 6;

interface CacheEntry {
  doc: VirtualDoc;
  capturedAt: number;
}

const snapshots = new Map<number, CacheEntry>();
const inflight = new Map<number, Promise<VirtualDoc>>();

function lruEvict(): void {
  while (snapshots.size > DOC_CACHE_MAX) {
    let oldestId = -1;
    let oldestAt = Infinity;
    for (const [id, entry] of snapshots) {
      if (entry.capturedAt < oldestAt) {
        oldestAt = entry.capturedAt;
        oldestId = id;
      }
    }
    if (oldestId < 0) break;
    snapshots.delete(oldestId);
  }
}

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
        if (!resp || resp.type !== "CAPTURE_DOC_RESPONSE") {
          reject(new Error("invalid capture response"));
          return;
        }
        if (!resp.ok) reject(new Error(resp.error ?? "unknown capture error"));
        else resolve(resp.result);
      },
    );
  });
}

async function ensureSnapshot(tabId: number, refresh?: boolean): Promise<VirtualDoc> {
  if (!refresh) {
    const hit = snapshots.get(tabId);
    if (hit) {
      hit.capturedAt = Date.now();
      log.debug("doc", `snapshot cache hit(tab ${tabId})`);
      return hit.doc;
    }
  }
  // 并发请求同一 tab 时合并为一次提取
  const building = inflight.get(tabId);
  if (building) return building;

  const p = (async (): Promise<VirtualDoc> => {
    try {
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
      });
      snapshots.set(tabId, { doc, capturedAt: Date.now() });
      lruEvict();
      // 快照重建是 page_* 工具最常见的第一跳,耗时与 HTML 体量记下来便于定位慢读页
      log.info("doc", `快照已重建(tab ${tabId})`, {
        ms: Date.now() - startedAt,
        htmlBytes: cap.html.length,
        url: cap.url || undefined,
        refresh: refresh === true,
      });
      return doc;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `无法读取目标页面(tab ${tabId}):${msg}。可能是受限页(chrome://、PDF、商店页)、` +
          `已关闭的 tab 或页面尚未加载完成;请先确认目标再重试`,
      );
    } finally {
      inflight.delete(tabId);
    }
  })();
  inflight.set(tabId, p);
  return p;
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

chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
  const msg = raw as
    | { type?: string; id?: number; name?: string; args?: unknown; targetTabId?: number; refresh?: boolean; tabId?: number };
  if (msg?.type === "DOC_TOOL_CALL") {
    handleDocTool(msg.name ?? "", msg.args, msg.targetTabId ?? -1, msg.refresh === true)
      .then((result) =>
        sendResponse({ type: "DOC_TOOL_RESULT", id: msg.id, ok: true, result }),
      )
      .catch((e: unknown) => {
        const error = e instanceof Error ? e.message : String(e);
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
  if (msg?.type === "DOC_TOOL_INVALIDATE") {
    if (typeof msg.tabId === "number") snapshots.delete(msg.tabId);
    return false;
  }
  return false;
});
