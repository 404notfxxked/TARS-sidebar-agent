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
    // ---- 虚拟文档三件套:整页提取一次成为快照,窗口读/定位/大纲全是内存操作 ----
    case "page_read": {
      const a = args as { offset?: unknown; chars?: unknown; refresh?: unknown };
      if (
        a.offset !== undefined &&
        (typeof a.offset !== "number" || !Number.isInteger(a.offset) || a.offset < 0)
      ) {
        throw new Error(
          "page_read: offset 必须是非负整数(取自上次响应的 next_offset 或 page_find 的 pos)",
        );
      }
      if (
        a.chars !== undefined &&
        (typeof a.chars !== "number" || !Number.isInteger(a.chars) || a.chars <= 0)
      ) {
        throw new Error("page_read: chars 必须是正整数(建议 6000 内,上限 20000)");
      }
      return pageRead(
        getVirtualDoc(a.refresh === true),
        typeof a.offset === "number" ? a.offset : 0,
        typeof a.chars === "number" ? a.chars : READ_WINDOW_DEFAULT,
      );
    }

    case "page_find": {
      const a = args as { query?: unknown; limit?: unknown; refresh?: unknown };
      if (typeof a.query !== "string" || a.query.trim().length === 0) {
        throw new Error("page_find requires a non-empty query string");
      }
      const limit =
        typeof a.limit === "number" && Number.isFinite(a.limit)
          ? Math.min(Math.max(1, Math.floor(a.limit)), SEARCH_LIMIT_MAX)
          : SEARCH_LIMIT_DEFAULT;
      return pageFind(getVirtualDoc(a.refresh === true), a.query, limit);
    }

    case "page_outline": {
      const a = args as { refresh?: unknown };
      return pageOutline(getVirtualDoc(a.refresh === true));
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
// 虚拟文档快照(buildVirtualDoc)的分节基础:
// 页面按「内容锚点」切节——有标题结构时锚点 = 标题,节 = 「标题 → 下一个标题」;
// 无标题时锚点 = 承载正文的块级元素(含不规则页面的自定义容器兜底)。
// 各节拼成规范 markdown 后,统一由 page_read / page_find / page_outline 消费。

/** 分节单元:el 是锚点元素(标题或块元素);kind 决定节内容怎么取 */
interface SectionUnit {
  el: HTMLElement;
  title: string;
  level: number;
  kind: "heading" | "block";
}

/** 统一分节入口:有标题 → 按标题分节;无标题 → 按正文块分节 */
function collectSections(): SectionUnit[] {
  const heads = collectHeadings();
  if (heads.length > 0) {
    return heads.map((el) => ({
      el,
      title: headingTitle(el),
      level: headingLevel(el),
      kind: "heading",
    }));
  }
  return collectBlocks();
}

/** 页面上所有可用标题(文档序,限定 main/article 范围排除导航噪音,过滤空标题/纯编号) */
function collectHeadings(): HTMLElement[] {
  const root = document.querySelector("main, article") ?? document.body;
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      "h1,h2,h3,h4,h5,h6,[role=heading],[aria-level]",
    ),
  ).filter((el) => (el.textContent ?? "").trim().length > 1);
}

/** 常规块级标签:直接承载正文的元素 */
const BLOCK_SELECTOR =
  "p, li, pre, blockquote, table, dt, dd, figcaption, [role=paragraph]";
/** 正文总量低于该值时不值得做覆盖率检查 */
const BLOCK_COVERAGE_CHECK_MIN_CHARS = 200;
/** 常规块收集到的文字占正文总量比例低于它 → 视为不规范结构,触发宽松补扫 */
const BLOCK_COVERAGE_RATIO = 0.6;
/** 补扫时容器的直接文本(不含子孙元素的)至少这么多才算独立内容块 */
const BLOCK_DIRECT_TEXT_MIN_CHARS = 32;
/** 兜底块数硬上限:病态页面(几千个碎块)到此为止,别把主线程算穿 */
const MAX_BLOCK_SECTIONS = 800;

/**
 * 无标题结构时的兜底分节:
 * 第一轮按常规块级标签收集——候选元素沿祖先链上爬判断覆盖(O(n·深度),
 * 替代旧版对全部已收块 some(contains) 的 O(n²) 扫描),顺带剔除显式隐藏
 * (hidden / aria-hidden / 内联 display:none)的不可见内容,否则 page_find
 * 会命中用户根本看不到的文字。
 * 第二轮仅在第一轮吃不下大部分正文时运行:内容装在 div/span 等自定义容器里的
 * 「不规范」页面,按"直接文本量"识别真正的叶子容器补进分节。
 *
 * 已知边角:同时有 ≥32 字直接文本、又包着常规块的容器可能与内部块重复收录,
 * 覆盖率阈值让这种结构很少见,不再为它做子树反查。
 */
function collectBlocks(): SectionUnit[] {
  const root = (document.querySelector("main, article") ?? document.body) as HTMLElement;
  const collected = new Set<HTMLElement>();
  const blocks: HTMLElement[] = [];

  // 从 el 自己往上爬到 root:命中已收集祖先 → 该元素已被覆盖;
  // 沿途任一节点带显式隐藏信号 → 内容不可见。覆盖与隐藏在同一次上爬里判定。
  const candidateStatus = (el: HTMLElement): "covered" | "hidden" | "ok" => {
    for (let n: HTMLElement | null = el; n && n !== root; n = n.parentElement) {
      if (collected.has(n)) return "covered";
      if (n.hasAttribute("hidden") || n.getAttribute("aria-hidden") === "true") {
        return "hidden";
      }
      const st = n.getAttribute("style");
      if (
        st &&
        (/display\s*:\s*none/i.test(st) || /visibility\s*:\s*hidden/i.test(st))
      ) {
        return "hidden";
      }
    }
    return "ok";
  };

  const tryPush = (el: HTMLElement): void => {
    if (blocks.length >= MAX_BLOCK_SECTIONS) return;
    if ((el.textContent ?? "").trim().length < 2) return;
    if (candidateStatus(el) !== "ok") return;
    collected.add(el);
    blocks.push(el);
  };

  for (const el of root.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)) {
    tryPush(el);
  }

  // 覆盖率检查:常规块吃到不到六成正文 → 页面结构不常规,用宽松规则补一轮
  const rootTextLen = (root.textContent ?? "").length;
  if (rootTextLen >= BLOCK_COVERAGE_CHECK_MIN_CHARS) {
    let coveredLen = 0;
    for (const b of blocks) coveredLen += (b.textContent ?? "").length;
    if (coveredLen < rootTextLen * BLOCK_COVERAGE_RATIO) {
      // 直接文本 = 只算挂在该元素自己的 Text 子节点(不含子孙元素)。
      // 纯容器包着已收集块时直接文本为零,自然落选,不会和内部块重复。
      const directTextLen = (el: HTMLElement): number => {
        let len = 0;
        for (const c of el.childNodes) {
          if (c.nodeType === Node.TEXT_NODE) {
            len += (c.nodeValue ?? "").trim().length;
          }
        }
        return len;
      };
      for (const el of root.querySelectorAll<HTMLElement>("*")) {
        if (blocks.length >= MAX_BLOCK_SECTIONS) break;
        if (collected.has(el)) continue;
        if (directTextLen(el) < BLOCK_DIRECT_TEXT_MIN_CHARS) continue;
        tryPush(el);
      }
    }
  }

  // 两轮结果合并回文档序:补扫的块要插到正确位置,
  // page_read 顺序翻页时的内容顺序才能和页面视觉顺序一致
  blocks.sort((a, b) =>
    a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
  );

  return blocks.map((el) => ({
    el,
    title: (el.textContent ?? "").trim().slice(0, 40),
    level: 2,
    kind: "block",
  }));
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
 * 某一节的内容:
 * - 标题节 = 从标题元素末尾到下一个锚点开头(标题文字由调用方拼成 markdown 头,不重复)
 * - 块节   = 块自身内容(块间互不嵌套,selectNodeContents 取整块)
 * 用 Turndown 转成 markdown(保留标题/列表/代码块/换行结构),不再压平成一段字。
 * maxChars 默认 4000 兜底单节,避免病态大节撑爆快照。
 */
function sectionText(
  unit: SectionUnit,
  next: SectionUnit | null,
  maxChars = 4000,
): string {
  const root = document.querySelector("main, article") ?? document.body;
  const range = document.createRange();
  if (unit.kind === "block") {
    range.selectNodeContents(unit.el);
  } else {
    range.setStartAfter(unit.el);
    if (next) range.setEnd(next.el, 0);
    else range.setEndAfter(root);
  }
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

/** page_find 单次最多返回命中区域数 */
const SEARCH_LIMIT_MAX = 10;
const SEARCH_LIMIT_DEFAULT = 5;

/** 检索词切分:空白/标点切,去空;英文小写,中文连续串保留不逐字拆 */
function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,.;:!?()'"\[\]{}<>|~`@#$%^&*+=/\\，。；：！？、《》「」【】]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/** 首个命中点附近 ±100 字的片段,收拢到行边界,首尾加省略号 */
function buildSnippet(raw: string, pos: number): string {
  const radius = 100;
  let start = Math.max(0, pos - radius);
  let end = Math.min(raw.length, pos + radius);
  const nlStart = raw.lastIndexOf("\n", start);
  if (nlStart >= 0 && start - nlStart <= radius) start = nlStart + 1;
  const nlEnd = raw.indexOf("\n", end);
  if (nlEnd >= 0 && nlEnd - end <= radius) end = nlEnd;
  let out = raw.slice(start, end);
  if (start > 0) out = `…${out}`;
  if (end < raw.length) out = `${out}…`;
  return out;
}

// ---- 虚拟文档快照层(page_read / page_find / page_outline 共用) ----
// 设计:整页规范 markdown 一次性提取成快照,之后的窗口读/定位/大纲全部退化为
// 内存字符串操作。三个工具基于同一份快照工作,page_find 的 pos 与
// page_outline 的 offset 就是 page_read 的续读参数,偏移体系完全互通。
// 快照随 content script 生命周期自然失效(导航重建实例);SPA 换路由后内容由
// 模型用 refresh=true 显式决定何时重新提取。

/** 单个快照的正文硬上限(字符):病态大页面(信息流/超大列表)到此为止 */
const DOC_MAX_CHARS = 160_000;
/** page_read 默认窗口(字符) */
const READ_WINDOW_DEFAULT = 6000;
/** page_read 单窗上限(字符) */
const READ_WINDOW_MAX = 20000;
/** 大纲条数不超过该值时全量返回 */
const OUTLINE_FULL_MAX = 60;
/** 折叠模式下最多返回的大纲条数 */
const OUTLINE_RETURN_MAX = 80;

interface HeadingAnchor {
  /** 标题行("#" 字符)在 md 里的起始偏移,天然行对齐,可直接作 page_read 的 offset */
  offset: number;
  level: number;
  title: string;
}

interface VirtualDoc {
  /** 唯一真源:规范整页 markdown,标题行本身包含在内 */
  md: string;
  /** 检索用小写副本,首次 page_find 时才生成 */
  lower: string | null;
  headings: HeadingAnchor[];
  totalChars: number;
  /** 正文超出 DOC_MAX_CHARS 被截(信息流类页面会遇到) */
  truncatedTotal: boolean;
}

let vdoc: VirtualDoc | null = null;

function getVirtualDoc(refresh?: boolean): VirtualDoc {
  if (!vdoc || refresh) vdoc = buildVirtualDoc();
  return vdoc;
}

/**
 * 构建虚拟文档:复用统一分节(collectSections,含无标题页的块级兜底),
 * 拼成一份完整 markdown。标题锚点不再单独记录——拼完之后按行扫描 md 本身
 * 收集标题行,包括节内嵌套子标题(turndown 原样输出),保证寻址与内容零漂移。
 * 构建是同步一次性的,DOC_MAX_CHARS 封顶防病态页面卡住主线程(也是消息通道
 * 10s 超时的保险);未来量大再演进为「先建索引、分块惰性转换」。
 */
function buildVirtualDoc(): VirtualDoc {
  const sections = collectSections();
  const parts: string[] = [];
  let total = 0;
  let truncatedTotal = false;
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    const unit =
      s.kind === "heading"
        ? `${"#".repeat(s.level)} ${s.title}\n${sectionText(s, sections[i + 1] ?? null)}`
        : sectionText(s, sections[i + 1] ?? null);
    // total > 0 保证至少放下一节
    if (total > 0 && total + unit.length > DOC_MAX_CHARS) {
      truncatedTotal = true;
      break;
    }
    parts.push(unit);
    total += unit.length;
  }
  if (parts.length === 0) {
    // 一节都凑不出(内容全隐藏/未渲染),退回整页转换兜底
    const root = (document.querySelector("main, article") ?? document.body) as HTMLElement;
    const full = turndown.turndown(root);
    parts.push(truncateMarkdown(full, DOC_MAX_CHARS));
    truncatedTotal = full.length > DOC_MAX_CHARS;
  }

  const md = parts.join("\n\n");

  // 按行扫描收集标题锚点;跳过 ``` / ~~~ 围栏内部,避免 shell 注释这类 "# 开头" 的代码行被当成标题
  const headings: HeadingAnchor[] = [];
  let inFence = false;
  let lineStart = 0;
  for (const rawLine of md.split("\n")) {
    if (/^(```|~~~)/.test(rawLine)) {
      inFence = !inFence;
    } else if (!inFence) {
      const m = /^(#{1,6}) (.+)$/.exec(rawLine);
      if (m) {
        headings.push({
          offset: lineStart,
          level: m[1].length,
          title: m[2].trim().slice(0, 80),
        });
      }
    }
    lineStart += rawLine.length + 1; // +1 是换行符本身
  }

  return { md, lower: null, headings, totalChars: md.length, truncatedTotal };
}

/** pos 所在位置的上层标题链(从 h1 到最近的上级标题),判断上下文归属用 */
function headingChainAt(doc: VirtualDoc, pos: number): { level: number; title: string }[] {
  const chain: HeadingAnchor[] = [];
  for (const h of doc.headings) {
    if (h.offset > pos) break;
    while (chain.length > 0 && chain[chain.length - 1].level >= h.level) chain.pop();
    chain.push(h);
  }
  return chain.map(({ level, title }) => ({ level, title }));
}

/**
 * 窗口读取:[offset, offset+chars) 原样切片,不做行边界回吸——
 * 无状态的窗口协议必须保证 offset 单调推进;若向后吸附,遇到超长单行
 * 内容(压缩代码、巨型表格行)时 next_offset 会反复掉回同一个新行,
 * 翻页停滞。断词开头的瑕疵由 page_outline / page_find 提供的行对齐
 * offset(pos 天然指向标题行或片段起点)来规避。
 * 返回 next_offset/done 组成显式翻页协议,不存在静默截断。
 */
function pageRead(doc: VirtualDoc, offset: number, chars: number) {
  if (offset >= doc.totalChars) {
    throw new Error(
      `page_read: offset ${offset} 已超出文档总长(${doc.totalChars} 字符)。文档已读完,` +
        `要用其它主题请调用 page_find 定位新的 pos;若页面内容已更新(SPA 切页),传 refresh=true 重新提取`,
    );
  }
  const size = Math.min(Math.max(chars, 500), READ_WINDOW_MAX);
  const end = Math.min(offset + size, doc.totalChars);
  const done = end >= doc.totalChars;
  return {
    title: document.title,
    url: location.href,
    offset,
    end,
    total_chars: doc.totalChars,
    next_offset: done ? null : end,
    done,
    ...(doc.truncatedTotal ? { truncated_total: true } : {}),
    headings: headingChainAt(doc, offset),
    text: doc.md.slice(offset, end),
  };
}

// ---- page_find:虚拟文档上的全文定位 ----

/** page_find 单个 term 在一份文档里最多统计的命中数(常见词防刷屏) */
const FIND_HITS_PER_TERM_CAP = 150;
/** 命中聚簇的距离阈值(字符):小于它视为同一处上下文 */
const FIND_CLUSTER_GAP = 260;

const CJK_CHAR_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/**
 * 查询词展开:英文/数字 token 整串保留;连续中文串拆成重叠二字组。
 * 「性能优化方法」→ 性能/能优/优化/化方/方法,改写语序的中文表述也能召回
 * (传统必须整串连续命中才能匹配的问题在这里解决)。混合 token 各自拆段。
 */
function expandQueryTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const tok of tokenize(query)) {
    let buf = "";
    let bufIsCjk: boolean | null = null;
    const flush = () => {
      if (!buf) return;
      if (bufIsCjk && buf.length >= 2) {
        for (let i = 0; i <= buf.length - 2; i++) terms.add(buf.slice(i, i + 2));
      } else {
        terms.add(buf);
      }
      buf = "";
    };
    for (const ch of tok) {
      const cjk = CJK_CHAR_RE.test(ch);
      if (bufIsCjk !== null && cjk !== bufIsCjk) flush();
      bufIsCjk = cjk;
      buf += ch;
    }
    flush();
  }
  return Array.from(terms);
}

/** 子串全部出现位置(小写副本上做),超过 cap 提前收手 */
function collectPositions(haystack: string, needle: string, cap: number): number[] {
  const out: number[] = [];
  let from = 0;
  while (out.length < cap) {
    const i = haystack.indexOf(needle, from);
    if (i < 0) break;
    out.push(i);
    from = i + needle.length;
  }
  return out;
}

/**
 * 全文定位:所有词位合并、按距离聚成「命中区域」,区域内不同词种越多、
 * 出现越密、整句短语命中与否决定得分。返回 Top-N 区域及其在 md 里的精确
 * 偏移 —— 该偏移就是 page_read 的续读参数,不需要任何编号翻译。
 */
function pageFind(doc: VirtualDoc, query: string, limit: number) {
  const lower = (doc.lower ??= doc.md.toLowerCase());
  const phrase = query.trim().toLowerCase();
  const terms = expandQueryTerms(query);

  type Hit = { pos: number; term: string };
  const hits: Hit[] = [];
  for (const t of terms) {
    for (const pos of collectPositions(lower, t, FIND_HITS_PER_TERM_CAP)) hits.push({ pos, term: t });
  }
  const phraseSet = new Set<number>();
  if (phrase) {
    for (const pos of collectPositions(lower, phrase, 40)) {
      phraseSet.add(pos);
      hits.push({ pos, term: "\u0000phrase" });
    }
  }
  if (hits.length === 0) {
    return { query, total_matches: 0, matches: [] };
  }
  hits.sort((a, b) => a.pos - b.pos);

  // 距离小于阈值归为同一处上下文
  type Cluster = { minPos: number; maxPos: number; count: number; terms: Set<string>; phraseHit: boolean };
  const clusters: Cluster[] = [];
  for (const hit of hits) {
    const last = clusters[clusters.length - 1];
    const isPhrase = hit.term.startsWith("\u0000");
    const term = isPhrase ? hit.term.slice(1) : hit.term;
    if (last && hit.pos - last.maxPos <= FIND_CLUSTER_GAP) {
      last.maxPos = Math.max(last.maxPos, hit.pos);
      last.count++;
      if (!isPhrase) last.terms.add(term);
      if (isPhrase || phraseSet.has(hit.pos)) last.phraseHit = true;
    } else {
      clusters.push({
        minPos: hit.pos,
        maxPos: hit.pos,
        count: 1,
        terms: new Set(isPhrase ? [] : [term]),
        phraseHit: isPhrase || phraseSet.has(hit.pos),
      });
    }
  }

  const scored = clusters.map((c) => ({
    minPos: c.minPos,
    score:
      c.terms.size * 2 + // 命中的不同词种数是最强信号(多词共现=真正相关)
      Math.min(c.count, 8) * 0.5 +
      (c.phraseHit ? 4 : 0),
  }));
  scored.sort((a, b) => b.score - a.score || a.minPos - b.minPos);

  return {
    query,
    total_matches: clusters.length,
    matches: scored.slice(0, limit).map(({ minPos, score }) => ({
      pos: minPos,
      snippet: buildSnippet(doc.md, minPos),
      headings: headingChainAt(doc, minPos),
      score: Number(score.toFixed(1)),
    })),
  };
}

// ---- page_outline:标题大纲(offset 直接可寻址) ----

/** 大纲项的正文预览:取标题行之后的开头内容,≤60 字符,空则不带该字段 */
function outlinePreview(md: string, offset: number): { preview?: string } {
  const nl = md.indexOf("\n", offset);
  if (nl < 0) return {};
  const rest = md.slice(nl + 1).trimStart();
  if (!rest) return {};
  return { preview: rest.slice(0, 60) };
}

/**
 * 标题大纲。少标题全量返回;大文档把深层折叠掉(每个保留项带
 * descendant_headings 计数,模型想看再下钻),控制长文档的 token 开销。
 */
function pageOutline(doc: VirtualDoc) {
  const base = () => ({
    title: document.title,
    url: location.href,
    total_chars: doc.totalChars,
    total_headings: doc.headings.length,
    ...(doc.truncatedTotal ? { truncated_total: true } : {}),
  });

  if (doc.headings.length === 0) {
    return {
      ...base(),
      collapsed: false,
      items: [],
      hint: "页面没有标题结构,用 page_find 关键词定位内容,或 page_read 从头读",
    };
  }

  if (doc.headings.length <= OUTLINE_FULL_MAX) {
    return {
      ...base(),
      collapsed: false,
      // 全量模式才带 preview;折叠模式条目已经很多,省掉控制 token 开销
      items: doc.headings
        .map(({ offset, level, title }) => ({
          offset,
          level,
          title,
          ...outlinePreview(doc.md, offset),
        })),
    };
  }

  // 折叠:选最小的层级 L,使 ≤L 级标题数量落在返回上限内
  let cutoff = 6;
  for (let lv = 1; lv <= 6; lv++) {
    const n = doc.headings.filter((h) => h.level <= lv).length;
    if (n >= 2 && n <= OUTLINE_RETURN_MAX) {
      cutoff = lv;
      break;
    }
  }
  const kept = doc.headings.filter((h) => h.level <= cutoff).slice(0, OUTLINE_RETURN_MAX);
  // descendant_headings = 本项 offset 到下一个保留项 offset 之间的其余标题数
  const items = kept.map((h, i) => {
    const nextOffset = kept[i + 1]?.offset ?? Infinity;
    const descendants = doc.headings.filter(
      (x) => x.offset > h.offset && x.offset < nextOffset,
    ).length;
    return {
      offset: h.offset,
      level: h.level,
      title: h.title,
      ...(descendants > 0 ? { descendant_headings: descendants } : {}),
    };
  });

  return { ...base(), collapsed: true, cutoff_level: cutoff, items };
}

