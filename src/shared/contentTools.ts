// 跨 context 共享：直接调用 content script 的工具
// background（agent loop 用）和 side panel（UI 直接调用）都通过这里

export const CONTENT_TOOL_MESSAGE = "execute_tool";
export const CONTENT_TOOL_RESULT = "tool_result";

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
 */
export function callContentTool(
  tabId: number,
  name: string,
  args?: unknown,
  timeoutMs = 10_000,
): Promise<unknown> {
  console.log("[content tool] - 接收调用", tabId, name, args);
  const callId = nextCallId();
  const message: ContentToolCall = {
    type: CONTENT_TOOL_MESSAGE,
    callId,
    name,
    args,
  };

  return new Promise((resolve, reject) => {
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
        console.error("[content tool] - 发送消息失败", e);
        reject(new Error(e));
        return;
      }
      const msg = raw as ContentToolResultMsg | undefined;
      if (!msg || msg.callId !== callId) {
        reject(new Error("invalid content tool response"));
        return;
      }
      if (msg.error) reject(new Error(msg.error));
      else resolve(msg.result);
    });
  });
}
