// 内容脚本:注入到每个页面。
// 职责一分为二:
//   - 页面读取类工具(page_outline/page_find/page_read)不走这里——采样器
//     capture_doc 序列化 HTML 快照后交给 offscreen document 解析(turndown 等
//     重活离开宿主页面主线程),本文件只做字节搬运;
//   - 页面交互(find_elements/click/fill)必须发生在真实页面上下文,留在这里。
// 用 chrome.runtime.onMessage 替代 port,request/response 模式

import type {
  ContentToolCall,
  ContentToolResultMsg,
} from "../shared/contentTools";
import { log } from "./log";

// 协议消息类型:与 shared/contentTools.ts 的导出保持一致。
// 这里必须用本地字面量而非运行时导入:content 入口一旦与 background 共享运行时模块,
// Rollup 会拆出共享 chunk,content.js 顶部出现 import 语句;
// 而浏览器以经典脚本执行 content script(manifest 注入与 executeScript 皆然),
// 顶层 import 直接 SyntaxError,listener 注册不上。
const CONTENT_TOOL_MESSAGE = "execute_tool";
const CONTENT_TOOL_RESULT = "tool_result";
import {
  clickElement,
  dispatchEnter,
  fillElement,
  findInteractive,
  normalizeRole,
} from "./interact";
import { clearMarks, drawMarks } from "./screenshot";

// 防重复注入:本脚本经 chrome.scripting.executeScript 按需注入(manifest 无
// 静态注入),同一次 run 里多个工具并发首调都会走「发送失败 → 注入 → 重试」,
// 可能对同一文档注入多次;重复注册 listener 会让一次调用产生多份响应。
// ISOLATED world 的 window 按扩展隔离,标记互不污染。
const WIN = window as { __tarsContentReady?: boolean };
if (!WIN.__tarsContentReady) {
  WIN.__tarsContentReady = true;
  chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
    const msg = raw as ContentToolCall;
    if (msg?.type !== CONTENT_TOOL_MESSAGE) return false;

    const { callId, name, args } = msg;

    // 异步执行工具后 sendResponse;耗时与结果摘要进日志(capture_doc 等大对象只记体量)
    const startedAt = Date.now();
    runTool(name, args)
      .then((result) => {
        log.info("tool", `${name} 完成`, {
          ms: Date.now() - startedAt,
          result: summarizeResult(name, result),
        });
        const response: ContentToolResultMsg = {
          type: CONTENT_TOOL_RESULT,
          callId,
          result,
        };
        sendResponse(response);
      })
      .catch((err: unknown) => {
        const error = err instanceof Error ? err.message : String(err);
        log.error("tool", `${name} 失败`, {
          ms: Date.now() - startedAt,
          error,
        });
        const response: ContentToolResultMsg = {
          type: CONTENT_TOOL_RESULT,
          callId,
          error,
        };
        sendResponse(response);
      });

    // 返回 true 表示会异步调用 sendResponse
    return true;
  });
}

// 工具结果进日志前先摘要:capture_doc 的 html、find_elements 的元素数组只记体量,
// 避免把整页快照写进日志缓冲
function summarizeResult(name: string, result: unknown): unknown {
  switch (name) {
    case "capture_doc": {
      const r = result as { html?: string; url?: string; root?: string };
      return { htmlBytes: r.html?.length ?? 0, url: r.url, root: r.root };
    }
    case "find_elements": {
      const r = result as { count?: number; returned?: number };
      return { count: r.count, returned: r.returned };
    }
    case "screenshot_mark": {
      const r = result as { marks?: unknown[] };
      return { marks: r.marks?.length ?? 0 };
    }
    default:
      return result;
  }
}

async function runTool(name: string, args: unknown): Promise<unknown> {
  switch (name) {
    // 采样器:序列化当前页面正文子树,offscreen 端据此构建虚拟文档。
    // 只搬字节不做转换——链接相对性也原样保留,由解析侧按 baseURI 绝对化;
    // 绝不在真实 DOM 上改写属性,避免污染宿主页面。
    case "capture_doc": {
      const root = (document.querySelector("main, article") ?? document.body) as HTMLElement;
      return {
        html: root.outerHTML,
        baseURI: document.baseURI,
        url: location.href,
        title: document.title,
        // 采样根标签(main/article/body)随快照上报:排查「页面有但读不到」时,
        // 先看采样根有没有圈错范围
        root: root.tagName.toLowerCase(),
      };
    }

    // 观察:定位可交互元素,返回绝对 selector 供 click_element / fill_input 使用
    case "find_elements": {
      const a = args as { text?: unknown; role?: unknown; limit?: unknown };
      const text = typeof a.text === "string" ? a.text : undefined;
      const roleRaw = typeof a.role === "string" ? a.role : undefined;
      const role = roleRaw ? (normalizeRole(roleRaw) ?? null) : undefined;
      if (roleRaw && !role) {
        throw new Error(
          `find_elements: 未知 role "${roleRaw}",支持:button/link/input/checkbox/radio/switch/select/textarea/contenteditable`,
        );
      }
      const limit =
        typeof a.limit === "number" && Number.isFinite(a.limit)
          ? a.limit
          : undefined;
      return findInteractive(document, { text, role: role ?? undefined, limit });
    }

    // 动作:点击(完整指针事件序列,等价真实鼠标点击)
    case "click_element": {
      const sel = (args as { selector?: string })?.selector;
      if (!sel) throw new Error("click_element 需要 selector(来自 find_elements 的返回)");
      const el = document.querySelector(sel);
      if (!el) {
        throw new Error(
          `元素未找到:${sel}。页面可能已变化(异步加载/重新渲染/切页),请重新调用 find_elements 定位该元素,取最新的 selector 再操作。`,
        );
      }
      clickElement(el);
      return { clicked: sel };
    }

    // 动作:填写(input/textarea/select/contenteditable),可附带回车
    case "fill_input": {
      const a = args as { selector?: string; text?: unknown; pressEnterAfter?: unknown };
      const sel = a.selector;
      if (!sel) throw new Error("fill_input 需要 selector(来自 find_elements 的返回)");
      if (typeof a.text !== "string") throw new Error("fill_input 需要 text 参数");
      const el = document.querySelector(sel);
      if (!el) {
        throw new Error(
          `元素未找到:${sel}。页面可能已变化,请重新调用 find_elements 定位该元素,取最新的 selector 再操作。`,
        );
      }
      fillElement(el, a.text);
      if (a.pressEnterAfter === true) {
        dispatchEnter(el);
      }
      return { filled: sel, pressEnterAfter: a.pressEnterAfter === true };
    }

    // 截图标记层:画/摘都是纯视觉操作。drawMarks 返回「号 → 元素」映射表,
    // SW 据此组装工具结果;图像捕获发生在 SW(captureVisibleTab),
    // 标记必须在捕获前画上、捕获后立即摘除(SW 侧负责时序)
    case "screenshot_mark":
      return { marks: drawMarks() };

    case "screenshot_cleanup":
      return clearMarks();

    default:
      throw new Error(`unknown content tool: ${name}`);
  }
}
