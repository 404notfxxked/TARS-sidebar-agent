// 虚拟文档桥(service worker 侧):
// - 懒创建并去重 offscreen document(chrome.offscreen 全局只允许一份)
// - page_* 三工具的调用转发(DOC_TOOL_CALL / DOC_TOOL_RESULT 协议)
// - 一次性解析任务转发(PARSE_CALL / PARSE_RESULT):解析数据由本侧自带,
//   不绑定 tab 快照(如 web_search 抓到的搜索结果页 HTML)
// - capture_doc 中继:offscreen document 没有 chrome.tabs/chrome.scripting 的
//   访问权限面(Chrome 只给它 runtime 消息等子集),抓取宿主页 HTML 必须借道
//   本 SW 完成——offscreen 发 CAPTURE_DOC_REQUEST,这里用 callContentTool
//   向目标 tab 索取后原样带回(字节搬运,不在任何一侧解析)
// - 把 tabs 生命周期事件转成快照失效通知:
//     导航开始 / url 变化 → 该 tab 快照作废;tab 关闭/替换 → 清除。
//   已知残缝:bfcache 前进后退与同 url 动态更新不触发任何事件,
//   靠工具层的 refresh=true 由模型显式重建(代码注释与提示词均已声明)

import { callContentTool } from "./contentTools";

export const OFFSCREEN_URL = "offscreen.html";

let creating: Promise<void> | null = null;

/** 懒创建 offscreen document;并发调用合并为一次创建 */
export async function ensureOffscreenDocument(): Promise<void> {
  // getContexts 需要 Chrome 116+;更早版本走"创建失败即视为已存在"的兜底
  if (typeof chrome.runtime.getContexts === "function") {
    const ctx = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    });
    if (ctx && ctx.length > 0) return;
  }
  if (creating) return creating;
  creating = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.DOM_PARSER],
      justification:
        "把页面 HTML 快照解析成虚拟文档(markdown),供 page_outline/page_find/page_read 离线读取",
    })
    .then(() => undefined)
    .catch((e: unknown) => {
      // "Only a single offscreen document..." = 并发竞态下对方先建好了,无害
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("single offscreen")) throw e;
    });
  try {
    await creating;
  } finally {
    creating = null;
  }
}

let callCounter = 0;

function isNoReceiverError(e: unknown): boolean {
  return e instanceof Error && e.message.includes("Receiving end does not exist");
}

/**
 * 向 offscreen 发一条请求消息并等待同 id 的配对响应(统一超时/错误语义)。
 * DOC_TOOL_CALL 与 PARSE_CALL 共用:响应约定 {type, id, ok, result|error}。
 */
function sendOffscreenRequest(
  msg: Record<string, unknown> & { id: string },
  respType: string,
  timeoutMs: number,
  label: string,
): Promise<unknown> {
  const sendOnce = () =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`offscreen request timeout: ${label}`)), timeoutMs);
      chrome.runtime.sendMessage(msg, (raw: unknown) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          reject(new Error(String(chrome.runtime.lastError.message ?? "runtime message failed")));
          return;
        }
        const resp = raw as { type?: string; id?: string; ok?: boolean; result?: unknown; error?: string };
        if (!resp || resp.id !== msg.id || resp.type !== respType) {
          reject(new Error(`invalid offscreen response: ${label}`));
          return;
        }
        if (!resp.ok) reject(new Error(resp.error ?? "unknown offscreen error"));
        else resolve(resp.result);
      });
    });
  // 文档页刚创建、listener 可能尚未注册(Receiving end does not exist):
  // 短暂等待后重试一次
  return sendOnce().catch(async (e: unknown) => {
    if (!isNoReceiverError(e)) throw e;
    await new Promise((r) => setTimeout(r, 150));
    return sendOnce();
  });
}

/** 转发一次文档工具调用到 offscreen(30s 上限,覆盖大页面首次构建) */
export function callOffscreenTool(
  name: string,
  args: unknown,
  targetTabId: number,
  refresh: boolean,
): Promise<unknown> {
  const id = `doc-${++callCounter}`;
  return sendOffscreenRequest(
    { type: "DOC_TOOL_CALL", id, name, args, targetTabId, refresh },
    "DOC_TOOL_RESULT",
    30_000,
    name,
  );
}

/**
 * 一次性解析任务:解析数据(HTML)由本侧随消息自带或由 offscreen 自取,
 * 不绑定 tab 快照(search:SW 抓好的搜索结果页;fetch_read:offscreen 按
 * URL 自抓自缓存)。默认 15s;web_fetch 含网络抓取,调用方传 30s。
 */
export function callOffscreenParser(
  kind: string,
  payload: unknown,
  timeoutMs = 15_000,
): Promise<unknown> {
  const id = `parse-${++callCounter}`;
  return sendOffscreenRequest({ type: "PARSE_CALL", id, kind, payload }, "PARSE_RESULT", timeoutMs, kind);
}

/** 通知 offscreen 作废某 tab 的快照(offscreen 尚未创建时静默失败,无缓存可失效) */
export function invalidateTabSnapshot(tabId: number): void {
  void chrome.runtime
    .sendMessage({ type: "DOC_TOOL_INVALIDATE", tabId })
    .catch(() => undefined);
}

let wired = false;
/** 注册 tabs 生命周期监听与 capture_doc 中继(模块导入即生效;幂等) */
export function wireDocumentLifecycleListeners(): void {
  if (wired) return;
  wired = true;

  // capture_doc 中继:见文件头注释(offscreen 的受限 API 面)
  chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
    const msg = raw as { type?: string; tabId?: number };
    if (msg?.type !== "CAPTURE_DOC_REQUEST") return false;
    callContentTool(msg.tabId ?? -1, "capture_doc", undefined, 20_000)
      .then((meta) =>
        sendResponse({ type: "CAPTURE_DOC_RESPONSE", ok: true, result: meta }),
      )
      .catch((e: unknown) =>
        sendResponse({
          type: "CAPTURE_DOC_RESPONSE",
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    return true; // 异步响应
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === "loading" || changeInfo.url !== undefined) {
      invalidateTabSnapshot(tabId);
    }
  });
  chrome.tabs.onRemoved.addListener((tabId) => invalidateTabSnapshot(tabId));
  chrome.tabs.onReplaced.addListener((_addedId, removedId) => invalidateTabSnapshot(removedId));
}

wireDocumentLifecycleListeners();
