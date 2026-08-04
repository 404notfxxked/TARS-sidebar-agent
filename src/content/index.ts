// 内容脚本：注入到每个页面，响应 background / side panel 的工具调用
// 用 chrome.runtime.onMessage 替代 port，request/response 模式

import type {
  ContentToolCall,
  ContentToolResultMsg,
} from "../shared/contentTools";

chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
  const msg = raw as ContentToolCall;
  if (msg?.type !== "execute_tool") return false;

  const { callId, name, args } = msg;

  // 异步执行工具后 sendResponse
  runTool(name, args)
    .then((result) => {
      const response: ContentToolResultMsg = {
        type: "tool_result",
        callId,
        result,
      };
      sendResponse(response);
    })
    .catch((err: unknown) => {
      const error = err instanceof Error ? err.message : String(err);
      const response: ContentToolResultMsg = {
        type: "tool_result",
        callId,
        error,
      };
      sendResponse(response);
    });

  // 返回 true 表示会异步调用 sendResponse
  return true;
});

async function runTool(name: string, args: unknown): Promise<unknown> {
  switch (name) {
    case "get_page_content":
      return {
        title: document.title,
        url: location.href,
        text: document.body.innerText.slice(0, 8000),
        htmlLength: document.documentElement.outerHTML.length,
      };

    case "extract_text": {
      const sel = (args as { selector?: string })?.selector ?? "body";
      const el = document.querySelector(sel);
      return { text: el?.textContent?.slice(0, 8000) ?? "" };
    }

    case "click_element": {
      const sel = (args as { selector?: string })?.selector;
      if (!sel) throw new Error("selector required");
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) throw new Error(`element not found: ${sel}`);
      el.click();
      return { clicked: sel };
    }

    case "query_selector": {
      const sel = (args as { selector?: string })?.selector;
      if (!sel) throw new Error("selector required");
      const el = document.querySelector(sel);
      return {
        found: !!el,
        tag: el?.tagName,
        text: el?.textContent?.slice(0, 500),
      };
    }

    case "get_page_meta":
      return {
        title: document.title,
        url: location.href,
        referrer: document.referrer,
        lang: document.documentElement.lang,
        description:
          document
            .querySelector('meta[name="description"]')
            ?.getAttribute("content") ?? null,
      };

    default:
      throw new Error(`unknown content tool: ${name}`);
  }
}
