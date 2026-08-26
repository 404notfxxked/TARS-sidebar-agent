// 内容脚本：注入到每个页面，响应 background / side panel 的工具调用
// 用 chrome.runtime.onMessage 替代 port，request/response 模式

import type {
  ContentToolCall,
  ContentToolResultMsg,
} from "../shared/contentTools";

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
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

// ---- 文本提取:Turndown(HTML → markdown) ----
// 替代旧的 range.toString() + 空白折叠:保留标题/列表/代码块/换行结构,
// 给 LLM 的正文不再是一整段压平的字。
const turndown = new TurndownService({
  headingStyle: "atx",      // ## 标题,与分节输出的 # 层级风格一致
  codeBlockStyle: "fenced", // 代码块用 ``` 围栏,比缩进对 LLM 更清晰
  bulletListMarker: "-",
  linkStyle: "inlined",     // [文字](链接),保留链接目标
});

// GFM 扩展:表格 / 删除线 / 任务列表 —— 文档页最常被丢的结构
turndown.use(gfm);
// gfm 插件把删除线转成单 ~(非标准 GFM),而下游 react-markdown 的 remark-gfm 只认 ~~;
// 用同名规则覆盖(addRule 后加优先),输出标准双 ~~
turndown.addRule("strikethrough", {
  filter: (node) => ["DEL", "S", "STRIKE"].includes(node.tagName),
  replacement: (content) => `~~${content}~~`,
});

// turndown 默认不滤 script/style/隐藏内容 —— 补一条最高优先级规则整块丢弃。
// 注意:turndown 内部会 clone 节点,克隆树上 getComputedStyle 取不到值,
// 只能认内联 style + hidden / aria-hidden 属性。
turndown.addRule("noise", {
  filter: (node) => {
    const tag = node.tagName?.toLowerCase() ?? "";
    if (
      tag === "script" ||
      tag === "style" ||
      tag === "noscript" ||
      tag === "template" ||
      tag === "head" ||
      tag === "title" ||
      tag === "meta"
    ) {
      return true;
    }
    if (node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true") {
      return true;
    }
    const inline = node.getAttribute("style") ?? "";
    return (
      /display\s*:\s*none/i.test(inline) ||
      /visibility\s*:\s*hidden/i.test(inline)
    );
  },
  replacement: () => "",
});

// 空链接:文字为空的 <a>(纯空白/图标/svg 链接)会被 turndown 渲染成 [](url),
// 对回答毫无信息量,整条丢掉;有 <img> 子元素的会渲染成 [![](src)](url),不算空,保留。
turndown.addRule("emptyLink", {
  filter: (node) => {
    if (node.nodeName !== "A" || !node.getAttribute("href")) return false;
    return (
      (node.textContent ?? "").trim() === "" && !node.querySelector("img")
    );
  },
  replacement: () => "",
});

chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
  const msg = raw as ContentToolCall;
  if (msg?.type !== CONTENT_TOOL_MESSAGE) return false;

  const { callId, name, args } = msg;

  // 异步执行工具后 sendResponse
  runTool(name, args)
    .then((result) => {
      const response: ContentToolResultMsg = {
        type: CONTENT_TOOL_RESULT,
        callId,
        result,
      };
      sendResponse(response);
    })
    .catch((err: unknown) => {
      const error = err instanceof Error ? err.message : String(err);
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

async function runTool(name: string, args: unknown): Promise<unknown> {
  switch (name) {
    case "get_page_content": {
      // 有标题结构 → 按节输出(带层级);无结构 → 整页 markdown 兜底(优先 main/article 区域,别从导航开头截)
      const heads = collectHeadings();
      let text: string;
      if (heads.length > 0) {
        const parts: string[] = [];
        let total = 0;
        for (const [i, el] of heads.entries()) {
          if (i >= OUTLINE_MAX) break;
          const section =
            `${"#".repeat(headingLevel(el))} ${headingTitle(el)}\n` +
            sectionText(el, heads[i + 1] ?? null);
          // 按节累计预算,到 PAGE_CONTENT_MAX 就停,不切碎某一节(markdown 结构不拦腰断);
          // total > 0 保证至少返回一节,避免极端情况下返回空
          if (total > 0 && total + section.length > PAGE_CONTENT_MAX) break;
          parts.push(section);
          total += section.length;
        }
        text = parts.join("\n\n");
      } else {
        const root = (document.querySelector("main, article") ?? document.body) as HTMLElement;
        text = truncateMarkdown(turndown.turndown(root), PAGE_CONTENT_MAX);
      }
      return {
        title: document.title,
        url: location.href,
        text,
        hasStructure: heads.length > 0,
        htmlLength: document.documentElement.outerHTML.length,
      };
    }

    // 结构化读页(第二级):先拿大纲,再按 index 读具体某节,长文档不再整页截断
    case "get_page_structure": {
      const heads = collectHeadings();
      return {
        url: location.href,
        title: document.title,
        hasStructure: heads.length > 0,
        total: heads.length,
        sections: buildOutline(heads),
      };
    }

    case "read_section": {
      const a = args as { index?: unknown; until?: unknown };
      const index = a.index;
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
        throw new Error("read_section requires a non-negative integer index");
      }
      const heads = collectHeadings();
      const el = heads[index];
      if (!el) throw new Error(`section not found: index ${index}`);

      // 连续读取:index..until(含)。整节返回不中途截断,只按节数上限保护
      const isRange =
        typeof a.until === "number" &&
        Number.isInteger(a.until) &&
        a.until >= index;
      const end = isRange
        ? Math.min(a.until as number, heads.length - 1, index + MAX_RANGE_SPAN - 1)
        : index;

      const parts: string[] = [];
      for (let i = index; i <= end; i++) {
        const h = heads[i];
        parts.push(
          `${"#".repeat(headingLevel(h))} ${headingTitle(h)}\n${sectionText(
            h,
            heads[i + 1] ?? null,
            isRange ? Infinity : undefined,
          )}`,
        );
      }
      return {
        from: index,
        to: end,
        level: headingLevel(el),
        title: headingTitle(el),
        text: parts.join("\n\n"),
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


    default:
      throw new Error(`unknown content tool: ${name}`);
  }
}

// ---- 页面分节核心 ----
// get_page_structure / read_section / get_page_content 共用:
// 页面按「标题 → 下一个标题」分节,节 index 与 get_page_structure 返回的大纲一致。

/** 页面上所有可用标题(文档序,限定 main/article 范围排除导航噪音,过滤空标题/纯编号) */
function collectHeadings(): HTMLElement[] {
  const root = document.querySelector("main, article") ?? document.body;
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      "h1,h2,h3,h4,h5,h6,[role=heading],[aria-level]",
    ),
  ).filter((el) => (el.textContent ?? "").trim().length > 1);
}

function headingLevel(el: HTMLElement): number {
  const m = /^h([1-6])$/i.exec(el.tagName);
  if (m) return Number(m[1]);
  const lv = el.getAttribute("aria-level");
  return lv ? Number(lv) || 2 : 2;
}

function headingTitle(el: HTMLElement): string {
  return (el.textContent ?? "").trim().slice(0, 80);
}

/**
 * 某一节 = 从标题开头到下一个标题开头之间的内容;最后一节到 main/article/body 末尾。
 * 用 Turndown 转成 markdown(保留标题/列表/代码块/换行结构),不再压平成一段字。
 * maxChars 传 Infinity 表示整节返回(连续读取用,不中途截断);默认 4000 兜底单节。
 */
function sectionText(
  from: HTMLElement,
  to: HTMLElement | null,
  maxChars = 4000,
): string {
  const root = document.querySelector("main, article") ?? document.body;
  const range = document.createRange();
  // setStartAfter 跳过标题元素本身:标题由调用方拼成 markdown 头,
  // 避免标题文字在正文里重复出现。
  range.setStartAfter(from);
  if (to) range.setEnd(to, 0);
  else range.setEndAfter(root);
  // cloneContents 得到独立片段,再交给 turndown(它内部还会 clone,
  // 不会改动页面真实 DOM)。
  const container = document.createElement("div");
  container.appendChild(range.cloneContents());
  return truncateMarkdown(turndown.turndown(container), maxChars);
}

/** 截断到 maxChars,尽量在行边界断开,避免把 ``` 或 [text]( 链接语法拦腰切断 */
function truncateMarkdown(md: string, maxChars: number): string {
  if (md.length <= maxChars) return md;
  const cut = md.slice(0, maxChars);
  // 切点附近有换行就回退到行首;整段单行文本则不回退,避免截得太短
  const nl = cut.lastIndexOf("\n");
  return nl > maxChars * 0.8 ? cut.slice(0, nl) : cut;
}

/** 单次 get_page_content 返回的总预算(字符):按节累计,到预算停,不切碎某一节 */
const PAGE_CONTENT_MAX = 12000;

/** 大纲上限:超长文档只列前 N 节,read_section 仍可用更大的 index(仅大纲不列) */
const OUTLINE_MAX = 30;

/** 连续读取单次最多覆盖的节数(整节不截断,靠节数上限兜底防超长) */
const MAX_RANGE_SPAN = 20;

/** 大纲:标题列表的位置即节 index;heads 由调用方传入,避免重复遍历 */
function buildOutline(heads: HTMLElement[]): {
  index: number;
  level: number;
  title: string;
  preview: string;
}[] {
  return heads.slice(0, OUTLINE_MAX).map((el, i) => ({
    index: i,
    level: headingLevel(el),
    title: headingTitle(el),
    preview: sectionText(el, heads[i + 1] ?? null).slice(0, 120),
  }));
}

