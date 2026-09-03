// 跨 context 共享：直接调用 content script 的工具
// background（agent loop 用）和 side panel（UI 直接调用）都通过这里

import { createLogger } from "./logger";

// 本模块在 SW(无 window)与 offscreen 页面(有 window)里都会执行,
// 日志按宿主上下文归档,便于导出合并时分清来源
const log = createLogger({ ctx: typeof window === "undefined" ? "bg" : "off" });

const CONTENT_TOOL_MESSAGE = "execute_tool";
const CONTENT_TOOL_RESULT = "tool_result";

export interface ContentToolCall {
  type: typeof CONTENT_TOOL_MESSAGE;
  callId: string;
  name: string;
  args?: unknown;
}

export interface ContentToolResultMsg {
  type: typeof CONTENT_TOOL_RESULT;
  callId: string;
  result?: unknown;
  error?: string;
}

let callCounter = 0;
const nextCallId = () => `call-${++callCounter}`;

/** 在所有 context（background / sidepanel / popup）里都可用 */
export async function getActiveTabId(): Promise<number | null> {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    return tab?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * 直接向指定 tab 的 content script 发起一次工具调用
 * 用 chrome.tabs.sendMessage 实现 request/response 模式
 * 兜底:content script 未注入(如 reload 扩展前就打开的旧 tab)时,executeScript 注入后重试一次
 */
export function callContentTool(
  tabId: number,
  name: string,
  args?: unknown,
  timeoutMs = 10_000,
): Promise<unknown> {
  // 只记 name+tabId 不记 args:args 可能是待填写的表单文本或大请求体
  log.debug("cstool", `${name} → tab ${tabId}`);
  const callId = nextCallId();
  const message: ContentToolCall = {
    type: CONTENT_TOOL_MESSAGE,
    callId,
    name,
    args,
  };

  const sendOnce = (): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`content tool timeout: ${name}`));
      }, timeoutMs);

      chrome.tabs.sendMessage(tabId, message, (raw: unknown) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          const e =
            typeof chrome.runtime.lastError === "string"
              ? chrome.runtime.lastError
              : (chrome.runtime.lastError.message ?? "sendMessage failed");
          log.error("cstool", `${name} 消息发送失败(tab ${tabId})`, { error: e });
          reject(new Error(humanizeTabError(tabId, e)));
          return;
        }
        const msg = raw as ContentToolResultMsg | undefined;
        if (!msg || msg.type !== CONTENT_TOOL_RESULT || msg.callId !== callId) {
          reject(new Error("invalid content tool response"));
          return;
        }
        if (msg.error) reject(new Error(msg.error));
        else resolve(msg.result);
      });
    });

  // 先直接发;若因 content script 未注入失败,动态注入后重试一次
  return sendOnce().catch(async (err) => {
    if (!isNoReceiverError(err)) throw err;
    log.info("cstool", `content script 未注入,兜底注入后重试(tab ${tabId})`);
    try {
      await injectContentScript(tabId);
    } catch {
      throw new Error(
        `目标页面(tabId=${tabId})无法注入内容脚本,可能是浏览器内置页(chrome://)或受限页面`,
      );
    }
    return sendOnce();
  });
}

/** 把 sendMessage 的底层错误转成语义化中文(供模型理解,别甩英文) */
function humanizeTabError(tabId: number, raw: string): string {
  if (raw.includes("No tab with id")) {
    return `目标 tab(${tabId})不存在或已关闭,<context> 清单可能已过期;用 get_tabs 获取最新清单重新选择`;
  }
  return raw;
}

/** "Receiving end does not exist" = 目标 tab 没有 content script 接收者(旧 tab / 特殊页),值得注入兜底 */
function isNoReceiverError(err: unknown): boolean {
  return (
    err instanceof Error && err.message.includes("Receiving end does not exist")
  );
}

/** 动态注入 content.js 到目标 tab(兜底旧 tab 未注入 content script) */
async function injectContentScript(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
  });
}
