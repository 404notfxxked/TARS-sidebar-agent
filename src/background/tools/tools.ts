// 工具注册表 - agent loop 可调用的工具

import { callContentTool, getActiveTabId } from "../../shared/contentTools";
import { callOffscreenTool, ensureOffscreenDocument } from "../../shared/docBridge";
import {
  getToolExecutionContext,
  pickTargetTabId,
} from "./toolContext";
import { runWebSearch, type WebSearchArgs, type WebSearchResult } from "../web/webSearch";
import { runWebFetch, type WebFetchArgs, type WebFetchResult } from "../web/webFetch";
import { runPageScreenshot } from "./screenshot";
import {
  addMemory,
  deleteMemoriesByMatch,
  loadMemories,
} from "../memory/memoryStore";
import { MEMORY_TAGS, type MemoryTag } from "../../shared/memory";
import type { ToolSchema } from "../../shared/toolTypes";
import { getMcpTool } from "../mcp/mcpManager";

/** 工具定义:注册表条目 = 共享的 ToolSchema(纯 schema)+ 可执行的 execute */
export interface Tool<P = unknown, R = unknown> extends ToolSchema {
  /** 面板展示名;只在注册表条目上,不进 ToolSchema(那是给 LLM 的 wire 契约) */
  displayName?: string;
  execute: (args: P) => Promise<R>;
}

const registry: Tool[] = [];

function registerTool<P, R>(tool: Tool<P, R>): void {
  registry.push(tool as unknown as Tool);
}

export function getTool(name: string): Tool | undefined {
  const builtin = registry.find((t) => t.name === name);
  if (builtin) return builtin;
  // MCP 动态工具:注册表是 per-run 刷新的内存 registry,查不到 = 幻觉工具名
  return getMcpTool(name);
}

// 导出为 provider 需要的 function calling schema
// Tool 继承了 ToolSchema,直接返回即可(多余的 execute 字段对消费方无影响)
export function toProviderToolSchemas(): ToolSchema[] {
  return registry;
}

/** 解析目标 tabId:参数指定 > 本 run 最近操作的 tab > 提交时捕获 > 实时激活;
 *  命中的 tab 记为「最近操作」,同页连续操作省掉重复传 tabId */
async function resolveTargetTabId(args?: { tabId?: number }): Promise<number> {
  const ctx = getToolExecutionContext();
  const tabId = pickTargetTabId(
    args?.tabId,
    ctx?.lastOperatedTabId,
    ctx?.tabId,
    await getActiveTabId(),
  );
  if (tabId === null) throw new Error("no active tab");
  if (ctx) ctx.lastOperatedTabId = tabId;
  return tabId;
}

// 标签页清单:<context> 里的 tab 列表是提交时快照,运行中会过期;
// 工具报「tab 不存在 / 无法注入」时,LLM 靠它拿最新清单重新选 tabId
registerTool<
  Record<string, never>,
  {
    defaultTabId: number | null;
    tabs: { tabId: number; title?: string; url?: string; active: boolean; default: boolean }[];
  }
>({
  type: "function",
  name: "get_tabs",
  description:
    "List all tabs in the current window (tabId, title, URL), marking each tab as the default target for page tools when tabId is omitted (default: the page at submit time) or the currently active tab (active). The tab list in <context> is a submit-time snapshot and goes stale as tabs open / close / switch during the run; when a tool reports \"tab not found\" or \"failed to inject content script\", call this tool first for a fresh list, then retry with the right tabId.",
  parameters: { type: "object", properties: {} },
  execute: async () => {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const ctx = getToolExecutionContext();
    const defaultTabId = ctx?.tabId ?? null;
    return {
      defaultTabId,
      tabs: tabs.map((t) => ({
        tabId: t.id ?? -1,
        title: t.title,
        url: t.url,
        active: t.active,
        default: t.id === defaultTabId,
      })),
    };
  },
});

// ---- 页面读取工具(page_outline / page_find / page_read)----
// 整页 HTML 采样后由 offscreen document 解析成虚拟文档快照(离开目标页面主
// 线程),读/找/大纲全是内存操作。三个工具的偏移体系互通:page_find 的 pos、
// page_outline 的 offset 都是 page_read 的续读参数。快照失效:
// 导航/tab 关闭由 SW 的 tabs 事件自动清理,SPA 换路由由模型传 refresh 显式重建。
/** page_* 工具公共执行体:解析 tabId → 确保 offscreen 就绪 → 转发调用 */
async function runPageTool<R>(
  name: "page_read" | "page_find" | "page_outline",
  args: { refresh?: boolean; tabId?: number },
): Promise<R> {
  const tabId = await resolveTargetTabId(args);
  await ensureOffscreenDocument();
  return (await callOffscreenTool(name, args, tabId, args?.refresh === true)) as R;
}

registerTool<
  { offset?: number; chars?: number; refresh?: boolean; tabId?: number },
  {
    title?: string;
    url?: string;
    offset?: number;
    end?: number;
    total_chars?: number;
    next_offset?: number | null;
    done?: boolean;
    truncated_total?: boolean;
    headings?: { level: number; title: string }[];
    text?: string;
  }
>({
  type: "function",
  name: "page_read",
  description:
    "Read a window of page content by character offset (preserves the markdown structure of headings / lists / code blocks). Usage: offset comes from a page_outline outline item or a page_find match's pos; omit it to read from the top. A non-null next_offset in the result means more content follows — feed it back as offset to keep paging; done=true means you reached the end. headings is the chain of ancestor headings for this window. offset / pos are internal character offsets for tool positioning; when citing content to the user, refer to headings or original text, never numeric values.\nWhen to use: reading a specific section in context after surveying a long document; right after a page_find hit, read around pos; short pages can be read from the top in one call.\nWhen NOT to use: just checking whether a topic exists → page_find first; want the section list → page_outline.",
  parameters: {
    type: "object",
    properties: {
      offset: {
        type: "number",
        description:
          "Start character offset; from page_outline's offset / page_find's pos / this tool's previous next_offset; omit to read from the document start",
      },
      chars: { type: "number", description: "Window size in characters; default 6000, max 20000" },
      refresh: {
        type: "boolean",
        description: "Force re-extract the page snapshot; use only when you suspect the page changed (SPA route switch, post-click refresh)",
      },
      tabId: { type: "number", description: "Target tab id; omit to keep operating on the last tab these tools acted on in this run (initially the page at submit time)" },
    },
  },
  execute: (args) =>
    runPageTool<{
      title?: string;
      url?: string;
      offset?: number;
      end?: number;
      total_chars?: number;
      next_offset?: number | null;
      done?: boolean;
      truncated_total?: boolean;
      headings?: { level: number; title: string }[];
      text?: string;
    }>("page_read", args),
});

registerTool<
  { query: string; limit?: number; refresh?: boolean; tabId?: number },
  {
    query?: string;
    total_matches?: number;
    matches?: {
      pos: number;
      snippet: string;
      headings?: { level: number; title: string }[];
      score: number;
    }[];
  }
>({
  type: "function",
  name: "page_find",
  description:
    "Locate content regions relevant to the query across the full page, returning top-N results by relevance. Each item has pos (character offset in the page content), snippet (hit fragment) and headings (chain of ancestor headings). Queries get automatic bigram fuzzy matching for CJK, so paraphrases match even without an exact substring from the page. As soon as you get results, call page_read(offset=pos) for the full context; compare multiple dispersed hits by reading a small window at each.\nWhen to use: long-document questions like \"what about xx\" / \"where does it mention xx\"; confirming whether a topic exists on the page.\nWhen NOT to use: tiny pages → page_read from the top; want the section list → page_outline. pos is an internal offset; do not repeat it to the user.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search terms: core nouns / keywords or a short phrase from the question" },
      limit: { type: "number", description: "Max regions returned; default 5, cap 10" },
      refresh: {
        type: "boolean",
        description: "Force re-extract the page snapshot; use only when you suspect the page changed",
      },
      tabId: { type: "number", description: "Target tab id; omit to keep operating on the last tab these tools acted on in this run (initially the page at submit time)" },
    },
    required: ["query"],
  },
  execute: (args) =>
    runPageTool<{
      query?: string;
      total_matches?: number;
      matches?: {
        pos: number;
        snippet: string;
        headings?: { level: number; title: string }[];
        score: number;
      }[];
    }>("page_find", args),
});

registerTool<
  { refresh?: boolean; tabId?: number },
  {
    title?: string;
    url?: string;
    total_chars?: number;
    total_headings?: number;
    truncated_total?: boolean;
    collapsed?: boolean;
    cutoff_level?: number;
    items?: { offset: number; level: number; title: string; descendant_headings?: number }[];
    hint?: string;
  }
>({
  type: "function",
  name: "page_outline",
  description:
    "Read the page's heading outline. Each item has offset (usable directly as page_read's offset to jump to that section), level and title; very long documents auto-collapse deep subsections, and kept items carry a descendant_headings count. Also returns total_chars so you can gauge document size. Reading this first markedly cuts trial-and-error.\nWhen to use: answering \"what sections does this document have / how is it structured\", or as the opening map before close reading.\nWhen NOT to use: pages without heading structure return empty items (the hint says so) → use page_find; very short pages do not need an outline — page_read in full.",
  parameters: {
    type: "object",
    properties: {
      refresh: {
        type: "boolean",
        description: "Force re-extract the page snapshot; use only when you suspect the page changed",
      },
      tabId: { type: "number", description: "Target tab id; omit to keep operating on the last tab these tools acted on in this run (initially the page at submit time)" },
    },
  },
  execute: (args) =>
    runPageTool<{
      title?: string;
      url?: string;
      total_chars?: number;
      total_headings?: number;
      truncated_total?: boolean;
      collapsed?: boolean;
      cutoff_level?: number;
      items?: { offset: number; level: number; title: string; descendant_headings?: number }[];
      hint?: string;
    }>("page_outline", args),
});

// ---- 联网搜索 ----
// 免 Key 方案:后台新开真实搜索引擎标签页(tabSearch.ts)→ 完整渲染后取
// 整页 HTML → offscreen DOMParser 解析。引擎编排与兜底在 background/webSearch.ts,
// 此处只做注册。描述按「少搜、搜准」纪律写:每次搜索都是一次真实页面访问,
// 引导模型先宽后窄、引句逐字复制(凭记忆重打易错一字 → 精确匹配归零)、
// 优先读结果而非重搜、每题至多三次。
registerTool<WebSearchArgs, WebSearchResult>({
  type: "function",
  name: "web_search",
  description:
    "Search the public web, returning results ranked by relevance (title, URL, snippet).\nMechanics: a real browser tab is opened on a search engine (DuckDuckGo / Bing / Google / Baidu, auto-selected), the rendered results page is read, and the tab is closed. Every search is a real page view — keep the total number of searches small.\nWhen to use: fresh information is needed (news, releases, prices, weather), the open page is not enough, or the user explicitly asks to search.\nWhen NOT to use: the current page or your own knowledge suffices; locating content inside an open page → page_find.\nDiscipline:\n1) Default query: 2-4 core keywords, no quotes, no operators, not the user's whole sentence.\n2) Tracing where a quote / lyric / proverb / error message comes from: wrap the phrase in double quotes and reproduce it character-for-character from the user's message or the page it appeared on — never retype it from memory, never fix or normalize anything (one wrong character makes the exact match return zero and the engine silently falls back to fuzzy keyword matching, which surfaces unrelated pages). If the source text is no longer in view, do not reconstruct a quoted phrase — fall back to unquoted keywords.\n3) If any result looks promising, web_fetch that URL instead of searching again — snippets are short by design.\n4) Refine, don't repeat: empty or off-topic results usually mean the query was too narrow — drop quotes, change keywords, or try the other language (Chinese ↔ English) once. At most three searches per question; if all three miss, stop and answer from your own knowledge, honestly noting it was not web-verified. Never force unrelated results into an answer; cite source URLs.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Space-separated core keywords (default), or a double-quoted phrase copied character-for-character from the source when tracing where a quote comes from — not a long conversational sentence",
      },
      max_results: { type: "number", description: "Max results; default 6, max 10" },
      market: {
        type: "string",
        description:
          "Result language market, as \"language-REGION\": zh-CN / zh-TW / ja-JP / en-US / ko-KR etc. Match the query's language (Chinese query → zh-CN, Japanese content → ja-JP); only effective with a configured search provider (Brave maps it to a locale param, others ignore it); the default tab channel ignores it",
      },
      recency: {
        type: "string",
        enum: ["day", "week", "month", "year"],
        description: "Time filter: restrict to the last day / week / month / year; use for time-sensitive queries (news, releases), omit otherwise. Only effective with a configured search provider; the default tab channel ignores it",
      },
      allowed_domains: {
        type: "array",
        items: { type: "string" },
        description: "Domain allowlist (subdomains included), e.g. [\"react.dev\"]; search only within these sites. Mutually exclusive with blocked_domains; the allowlist wins if both are given",
      },
      blocked_domains: {
        type: "array",
        items: { type: "string" },
        description: "Domain blocklist (subdomains included): drop results from these sites",
      },
    },
    required: ["query"],
  },
  execute: (args) => runWebSearch(args),
});

// ---- 网页读取 ----
// 与 web_search 配套:搜索摘要不够时读正文。抓取/解码/缓存/解析在 offscreen
// (background/webFetch.ts 校验转发,offscreen/fetchDoc.ts 实现)。
registerTool<WebFetchArgs, WebFetchResult>({
  type: "function",
  name: "web_fetch",
  description:
    "Read the main content of a URL (navigation / scripts and other noise removed; markdown structure of headings / lists / code blocks preserved), paginated by character offset with the same protocol as page_read: omit offset to read from the top, feed next_offset back as offset to continue, done=true means finished.\nWhen to use: web_search snippets are insufficient, the user gave a specific link, a full page needs reading. Intranet http pages work too.\nWhen NOT to use: for pages already open in the browser use page_read (with tabId); do not web_fetch a page that is already open.\nNote: the URL is fetched and parsed statically — JavaScript is never executed, so client-rendered (SPA) or e-commerce shell pages may come back near-empty (for those, open the page in a tab and use page_read instead); http/https text pages only (PDF / images error out); read the first window and paginate only if needed — do not mechanically page to the end.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "The link to read (http/https), from web_search results or provided by the user" },
      offset: {
        type: "number",
        description: "Start character offset; from this tool's previous next_offset; omit to read from the top",
      },
      chars: { type: "number", description: "Window size in characters; default 6000, max 20000" },
      refresh: {
        type: "boolean",
        description: "Force re-fetch; use only when you suspect the page changed",
      },
    },
    required: ["url"],
  },
  execute: (args) => runWebFetch(args),
});


// ---- 页面交互工具(观察 + 动作)----
// 观察/动作分离:find_elements 定位(返回绝对 selector),click/fill 执行。
// selector 来自最近一次 find_elements;页面重渲染后失效 → 重新 find_elements,不要原样重试。

// 观察:定位可交互元素(selector 供 click_element / fill_input 使用)
registerTool<
  { text?: string; role?: string; limit?: number; tabId?: number },
  {
    count?: number;
    returned?: number;
    truncated?: boolean;
    elements?: unknown[];
    page?: {
      scroll_y: number;
      scroll_height: number;
      viewport_height: number;
      at_bottom: boolean;
    };
  }
>({
  type: "function",
  name: "find_elements",
  description:
    "Find interactive elements on the page (buttons / links / inputs / selects / checkboxes / radios / switches / contenteditable), returning each element's selector (absolute CSS path), tag, role, label, state and visibility, plus count / returned / truncated counters.\nWhen to use: before clicking, filling or toggling any control — call this first to locate the target, then pass its selector to click_element / fill_input. Narrow with text (fuzzy match on visible text) or role (by type) rather than calling bare — truncated=true means count-returned more exist; refine with text / role and query again.\nWhen NOT to use: never for reading document content (page_read / page_find); do not pull every control on the page at once. Selectors are a snapshot of the current page and go stale after async loads or re-renders; if a later click / fill reports \"element not found\", run find_elements again for a fresh selector.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "Fuzzy match on text / label / current value (substring, case-insensitive) to narrow results" },
      role: {
        type: "string",
        enum: ["button", "link", "input", "checkbox", "radio", "switch", "select", "textarea", "contenteditable"],
        description: "Filter by element type",
      },
      limit: { type: "number", description: "Max elements returned; default 20, cap 50" },
      tabId: { type: "number", description: "Target tab id; omit to keep operating on the last tab these tools acted on in this run (initially the page at submit time)" },
    },
  },
  execute: async (args) => {
    const tabId = await resolveTargetTabId(args);
    return (await callContentTool(tabId, "find_elements", args)) as {
      count?: number;
      returned?: number;
      truncated?: boolean;
      elements?: unknown[];
      page?: {
        scroll_y: number;
        scroll_height: number;
        viewport_height: number;
        at_bottom: boolean;
      };
    };
  },
});

// 观察:视口截图(set-of-marks)。定位 = 升级通道而非并列通道:文本工具便宜、
// 精确、可检索,截图同价一次 page_read 但保真更差(小字误读)、不可检索、
// 仅视口 —— 只有文本读不到(字体反爬/canvas 渲染/图即内容)或问题本身是
// 视觉的(长什么样/什么颜色/图表形状)才值得截。纪律写进描述当教科书
// (「何时截图」三层判断的第 ③ 层:模型自判);第 ② 层管线自报信号在
// offscreen pipeline 的 hint。结果里的 screenshot 字段由 agent 循环剥离,
// 转成紧随工具消息的带图 user 消息 —— tool 消息按协议只走文本
registerTool<
  { tabId?: number },
  {
    url?: string;
    viewport?: { w: number; h: number };
    marks?: { n: number; selector: string; tag: string; role: string | null; label: string | null }[];
    hint?: string;
    screenshot?: unknown;
  }
>({
  type: "function",
  name: "page_screenshot",
  description:
    "Take a screenshot of the target tab's current viewport. Interactive elements in view are outlined and numbered on the image (set-of-marks); the tool result carries the mark table (number → tag / role / label / selector) and the image itself arrives with the immediately following user message.\nActing on what you see: use the mark's selector with click_element / fill_input — the screenshot locates visually, the DOM executes.\nWhen to use: (1) escalation — text tools came back near-empty, garbled (font-obfuscation, canvas/webGL-rendered, image-as-content pages; page_outline / page_read hints point this out); (2) the question is about how the page LOOKS — layout, colors, images, chart shapes, visual state.\nWhen NOT to use: pure text/fact questions — page_read / page_find are cheaper, searchable and more precise. Never screenshot \"just to be safe\": at most once per question, and re-shoot only after the page actually changed (scroll / refresh first if the target is off-screen).\nNote: viewport only (what is on screen now). Requires a vision-capable model and site permission for the page.",
  parameters: {
    type: "object",
    properties: {
      tabId: { type: "number", description: "Target tab id; omit to keep operating on the last tab these tools acted on in this run (initially the page at submit time)" },
    },
  },
  execute: (args) => runPageScreenshot(args),
});

// 观察/导航:滚动。价值 = 喂惰性加载 + 与 screenshot 组成视觉循环(SoM 只标
// 视口内,scroll 后重截);读页不受滚动影响(page_read 读完整文档)——这条
// 反向纪律写在描述里,防止模型「为读而滚」。返回落点几何供模型判断还有没有下文
registerTool<
  { direction?: "up" | "down" | "top" | "bottom"; pages?: number; selector?: string; tabId?: number },
  {
    scroll_y?: number;
    scroll_height?: number;
    viewport_height?: number;
    at_bottom?: boolean;
  }
>({
  type: "function",
  name: "scroll_page",
  description:
    "Scroll the page, or bring an element into view. Without selector: scrolls the window by `pages` viewport-heights in `direction` (down/up, or top/bottom to jump to the very start/end). With `selector`: scrolls that element into view instead.\nWhen to use: (1) triggering lazy-loaded / infinite-feed content, then re-reading or re-shooting; (2) bringing a below-the-fold element into the viewport right before page_screenshot — screenshot marks only cover the visible viewport; (3) checking whether more content remains (at_bottom in the result).\nWhen NOT to use: reading content — page_read / page_find work on the fully extracted document and are NOT affected by scrolling; acting on an off-screen element is also fine — click_element / fill_input scroll it into view automatically. Do not scroll just to \"look around\": page_outline maps the whole page without scrolling.\nReturns the resulting geometry: scroll_y / scroll_height / viewport_height / at_bottom.",
  parameters: {
    type: "object",
    properties: {
      direction: {
        type: "string",
        enum: ["up", "down", "top", "bottom"],
        description: "Scroll direction; default down. top/bottom jump to the very start/end",
      },
      pages: { type: "number", description: "Scroll amount in viewport-heights; default 1, cap 10 (ignored with selector / top / bottom)" },
      selector: { type: "string", description: "Scroll this element into view instead of window scrolling (from find_elements output)" },
      tabId: { type: "number", description: "Target tab id; omit to keep operating on the last tab these tools acted on in this run (initially the page at submit time)" },
    },
  },
  execute: async (args) => {
    const tabId = await resolveTargetTabId(args);
    return (await callContentTool(tabId, "scroll_page", args)) as {
      scroll_y?: number;
      scroll_height?: number;
      viewport_height?: number;
      at_bottom?: boolean;
    };
  },
});

// 动作:点击(完整指针事件序列,等价真实鼠标点击)
registerTool<{ selector: string; tabId?: number }, { clicked?: string }>({
  type: "function",
  name: "click_element",
  description:
    "Click a page element, firing the full pointer / mouse event sequence (pointerover→pointerdown→mousedown→pointerup→mouseup→click) — equivalent to a real click, correctly perceived by React and similar frameworks.\nWhen to use: opening links, expanding collapsibles, switching tabs / switches, submit / cancel buttons — anything that needs a simulated user click. The selector must come from the most recent find_elements result.\nWhen NOT to use: not for reading content; never guess or hand-craft selectors (they go stale after re-renders). If it reports \"element not found\" or \"obscured\", re-run find_elements instead of retrying blind.",
  parameters: {
    type: "object",
    properties: {
      selector: { type: "string", description: "Target element's absolute CSS path, from find_elements output" },
      tabId: { type: "number", description: "Target tab id; omit to keep operating on the last tab these tools acted on in this run (initially the page at submit time)" },
    },
    required: ["selector"],
  },
  execute: async (args) => {
    const tabId = await resolveTargetTabId(args);
    return (await callContentTool(tabId, "click_element", args)) as { clicked?: string };
  },
});

// 动作:填写(含 select 选值、contenteditable、可选回车提交)
registerTool<
  { selector: string; text: string; pressEnterAfter?: boolean; tabId?: number },
  { filled?: string; pressEnterAfter?: boolean }
>({
  type: "function",
  name: "fill_input",
  description:
    "Write text into an input control and fire input / change events (React controlled components perceive it correctly). Supports input, textarea, select (picks an option) and contenteditable (rich text); pressEnterAfter=true appends an Enter keypress (keyCode=13) after writing, saving a separate submit step.\nWhen to use: filling search boxes, forms, comment fields, or selecting dropdown options. Selectors come from find_elements.\nWhen NOT to use: only for input controls — never on plain div / button; do not guess selectors. On error, re-run find_elements.",
  parameters: {
    type: "object",
    properties: {
      selector: { type: "string", description: "Input control's absolute CSS path, from find_elements output" },
      text: { type: "string", description: "Text to write; for select, the option value or visible text to select" },
      pressEnterAfter: { type: "boolean", description: "Append an Enter keypress (keyCode=13) after writing, handy for submitting search boxes; default false" },
      tabId: { type: "number", description: "Target tab id; omit to keep operating on the last tab these tools acted on in this run (initially the page at submit time)" },
    },
    required: ["selector", "text"],
  },
  execute: async (args) => {
    const tabId = await resolveTargetTabId(args);
    return (await callContentTool(tabId, "fill_input", args)) as {
      filled?: string;
      pressEnterAfter?: boolean;
    };
  },
});

// ---- 长期记忆工具(memory_ 前缀;设置页总开关关闭时 agent 侧按前缀滤除) ----
// 保存/删除都即时落库,下个 run 的 <user-memory> 注入块即生效。
// 「少而精」的约束写在 description 里:直注的记忆越多,模型误关联面越大。

registerTool<
  {
    content: string;
    key?: string;
    subject?: string;
    tag?: MemoryTag;
    replaceOf?: string;
  },
  {
    saved: true;
    duplicate: boolean;
    upserted?: boolean;
    replaced?: boolean;
    total: number;
  }
>({
  type: "function",
  name: "memory_save",
  description:
    "Save long-term, stable information about the user to memory; it persists across sessions (preferred name, language and conciseness preferences, dietary restrictions, long-running project context, etc.).\nWhen to use: the user says \"remember…\"; or states a clearly reusable personal preference / fact.\nWhen NOT to use: one-off task details, temporary context and ordinary chit-chat are never saved. Memory should be sparse and high-signal — one self-contained sentence per item; when in doubt, do not save.\nTwo forms:\n- Profile card (pass key): stable, slot-like facts — identity, preferences, health, ongoing projects. Saving again with the same key+subject overwrites the previous value in place, so prefer cards for facts that may change over time (e.g. key \"diet\" for food restrictions).\n- Plain note (no key): one-off contextual facts that fit no slot.\nRules: if <user-memory> already contains the same information, do not save again. If new information contradicts an entry you can SEE in <user-memory>, replace it via replaceOf instead of saving a conflicting second entry — never replace entries you cannot see there. When a value is true only under conditions (time, place, who it is about), state the condition inside the sentence, e.g. \"As of 2026-05, the user works at X\".",
  parameters: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description:
          "The fact to remember, as one self-contained third-person sentence, e.g. \"The user prefers concise answers\"",
      },
      key: {
        type: "string",
        description:
          "Slot name for a profile card, e.g. \"diet\", \"language\", \"home-city\". Same key+subject overwrites the previous value; omit for a plain note",
      },
      subject: {
        type: "string",
        description:
          "Who the card is about when not the user themselves, e.g. \"daughter\", \"Dr. Zhang\". Omit for the user",
      },
      tag: {
        type: "string",
        enum: MEMORY_TAGS,
        description:
          "Coarse category: identity (who they are), preference (likes, dislikes, standing rules), project (ongoing work), health, other",
      },
      replaceOf: {
        type: "string",
        description:
          "Id of an existing entry you can see in <user-memory>; its text is replaced by content. Use for corrections, not for adding new facts",
      },
    },
    required: ["content"],
  },
  execute: async (args) => {
    const { row, duplicate, upserted, replaced } = await addMemory(
      typeof args?.content === "string" ? args.content : "",
      "model",
      {
        key: typeof args?.key === "string" ? args.key : undefined,
        subject: typeof args?.subject === "string" ? args.subject : undefined,
        tag: MEMORY_TAGS.includes(args?.tag as MemoryTag)
          ? (args.tag as MemoryTag)
          : undefined,
        replaceOf:
          typeof args?.replaceOf === "string" ? args.replaceOf : undefined,
      },
    );
    const total = (await loadMemories()).length;
    return { saved: true, duplicate, upserted, replaced, total, text: row.text };
  },
});

registerTool<{ match: string }, { deleted: number; texts: string[] }>({
  type: "function",
  name: "memory_delete",
  description:
    "Delete saved memories by keyword (substring match against memory text, case-insensitive; all matches are deleted together). Use when the user asks to \"forget / delete a memory\"; keep match precise to avoid deleting the wrong entries. The result lists what was actually deleted.",
  parameters: {
    type: "object",
    properties: {
      match: {
        type: "string",
        description: "Match keyword (substring), e.g. \"cilantro\" deletes every memory containing it",
      },
    },
    required: ["match"],
  },
  execute: async (args) => {
    const { count, deleted } = await deleteMemoriesByMatch(
      typeof args?.match === "string" ? args.match : "",
    );
    if (count === 0) {
      throw new Error(
        "No memory matched the keyword; retry with a more precise one, or tell the user to review / delete memories in Settings → Memory",
      );
    }
    return { deleted: count, texts: deleted };
  },
});
