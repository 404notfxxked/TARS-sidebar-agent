// 页面文档管线(运行在 offscreen document,扩展私有 DOM 环境):
// 接收 content script 采样来的 HTML 快照 → 解析 → 剪枝/链接绝对化 →
// turndown 转换为规范 markdown → 构建"虚拟文档"(含标题锚点与检索索引)。
// 目标页面主线程只承担一次序列化,turndown/字符串重活全部离开宿主页。
//
// 所有 DOM 操作以传入的 Document 为准(不触碰任何全局 document),
// 纯逻辑部分(page_read / page_find / page_outline)对快照直接运算。

import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

// ---- Turndown 实例与规则(自 content script 迁移,行为不变)----
const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  linkStyle: "inlined",
});
turndown.use(gfm);
turndown.addRule("strikethrough", {
  filter: (node) => ["DEL", "S", "STRIKE"].includes(node.tagName),
  replacement: (content) => `~~${content}~~`,
});
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
turndown.addRule("emptyLink", {
  filter: (node) => {
    if (node.nodeName !== "A" || !node.getAttribute("href")) return false;
    return (node.textContent ?? "").trim() === "" && !node.querySelector("img");
  },
  replacement: () => "",
});

// ---- 常量 ----
/** 单个快照的正文硬上限(字符):病态大页面(信息流/超大列表)到此为止 */
const DOC_MAX_CHARS = 160_000;
/** page_read 默认窗口(字符) */
const READ_WINDOW_DEFAULT = 6000;
const READ_WINDOW_MAX = 20000;
/** 大纲条数不超过该值时全量返回 */
const OUTLINE_FULL_MAX = 60;
/** 折叠模式下最多返回的大纲条数 */
const OUTLINE_RETURN_MAX = 80;
/** page_find 单次最多返回命中区域数 */
const SEARCH_LIMIT_MAX = 10;
const SEARCH_LIMIT_DEFAULT = 5;

interface HeadingAnchor {
  /** 标题行("#" 字符)在 md 里的起始偏移,可直接作 page_read 的 offset */
  offset: number;
  level: number;
  title: string;
}

export interface VirtualDoc {
  url: string;
  title: string;
  md: string;
  /** 检索用小写副本,首次 page_find 时才生成 */
  lower: string | null;
  headings: HeadingAnchor[];
  totalChars: number;
  /** 正文超出 DOC_MAX_CHARS 被截(信息流类页面会遇到) */
  truncatedTotal: boolean;
}

/** content script capture_doc 的采样结果 */
export interface CaptureMeta {
  html: string;
  baseURI: string;
  url: string;
  title: string;
  /** 采样根标签(main/article/body);诊断用,解析侧自行重新选取、不消费此字段 */
  root?: string;
}

// ---- 提取解析 ----

/**
 * 从 HTML 快照构建虚拟文档。
 * 剪枝规则是既有 turndown noise 规则的超集(script/style/svg/canvas/iframe 等),
 * 在分节之前物理移除——分节范围不会落在不可见内容里。
 * 分节策略按结构二分:有标题走「前置节 + 标题节」;无标题页直接全文转换——
 * 常规块收集只认 p/li 等语义标签,React/Vue 渲染的 div/span 汤(电商详情页的
 * 价格/SKU 区是典型)会整体漏掉(淘宝商品页事故:整页只读出纯导航 3296 字符,
 * 价格静默蒸发),turndown 不挑标签,文本节点一视同仁。
 */
export function buildVirtualDoc(meta: CaptureMeta): VirtualDoc {
  const parsed = new DOMParser().parseFromString(meta.html, "text/html");
  const root = (parsed.querySelector("main, article") ?? parsed.body) as HTMLElement;
  absolutizeLinks(root, meta.baseURI);
  pruneNoise(root);

  const heads = collectHeadings(root);
  const parts: string[] = [];
  let total = 0;
  let truncatedTotal = false;
  // total > 0 保证至少放下一节
  const pushPart = (unit: string): boolean => {
    if (total > 0 && total + unit.length > DOC_MAX_CHARS) {
      truncatedTotal = true;
      return false;
    }
    parts.push(unit);
    total += unit.length;
    return true;
  };

  if (heads.length === 0) {
    const full = turndown.turndown(root);
    pushPart(truncateMarkdown(full, DOC_MAX_CHARS));
    truncatedTotal = full.length > DOC_MAX_CHARS;
  } else {
    // 前置节:首个标题之前的内容不属于任何标题节,单独补一段,
    // 否则页面头部信息(常是标题/价格/核心区)静默丢失
    const preamble = preambleText(parsed, root, heads[0]);
    if (preamble.trim() !== "") pushPart(preamble);
    for (let i = 0; i < heads.length; i++) {
      const h = heads[i];
      const unit =
        `${"#".repeat(headingLevel(h))} ${headingTitle(h)}\n` +
        sectionText(parsed, root, h, heads[i + 1] ?? null);
      if (!pushPart(unit)) break;
    }
  }

  const md = parts.join("\n\n");
  const headings = scanHeadings(md);

  return {
    url: meta.url,
    title: meta.title,
    md,
    lower: null,
    headings,
    totalChars: md.length,
    truncatedTotal,
  };
}

/** 相对链接按真实页面的 baseURI 绝对化(只动解析副本,不碰宿主页面) */
function absolutizeLinks(rootEl: HTMLElement, baseURI: string): void {
  let base: URL | null = null;
  try {
    base = new URL(baseURI);
  } catch {
    return; // baseURI 异常时保留原始属性值
  }
  for (const el of rootEl.querySelectorAll("a[href], img[src]")) {
    const attr = el.tagName === "A" ? "href" : "src";
    const raw = el.getAttribute(attr);
    if (!raw) continue;
    try {
      el.setAttribute(attr, new URL(raw, base).href);
    } catch {
      /* javascript:/data: 等无法按 base 解析的保持原样 */
    }
  }
}

/** 物理移除无正价值的元素(turndown noise 规则的超集,提前到分节之前执行) */
function pruneNoise(rootEl: HTMLElement): void {
  rootEl.querySelectorAll(
    "script, style, noscript, template, svg, canvas, iframe, object, embed",
  ).forEach((el) => {
    el.remove();
  });
  // 显式隐藏子树整段摘除(hidden 属性 / aria-hidden / 内联样式,经典 display 技巧)
  rootEl.querySelectorAll("[hidden], [aria-hidden='true']").forEach((el) => {
    el.remove();
  });
  rootEl.querySelectorAll<HTMLElement>("[style]").forEach((el) => {
    const st = el.getAttribute("style") ?? "";
    if (/display\s*:\s*none/i.test(st) || /visibility\s*:\s*hidden/i.test(st)) {
      el.remove();
    }
  });
}

// ---- 页面分节(前置节 + 标题节;无标题页不走分节,见 buildVirtualDoc)----

function collectHeadings(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6,[role=heading],[aria-level]"),
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
 * 前置节:根起点到首个标题之前的内容。
 * maxChars 默认 4000 兜底,与标题节同规。
 */
function preambleText(
  doc: Document,
  root: HTMLElement,
  firstHeading: HTMLElement,
  maxChars = 4000,
): string {
  const range = doc.createRange();
  range.setStart(root, 0);
  range.setEnd(firstHeading, 0);
  const container = doc.createElement("div");
  container.appendChild(range.cloneContents());
  return truncateMarkdown(turndown.turndown(container), maxChars);
}

/**
 * 某一标题节的内容:标题末尾到下一标题开头;最后一节延伸到根末尾
 * (不是标题自己的父容器——它可能只是个深层包装)。
 * maxChars 默认 4000 兜底单节,避免病态大节撑爆快照。
 */
function sectionText(
  doc: Document,
  root: HTMLElement,
  el: HTMLElement,
  nextEl: HTMLElement | null,
  maxChars = 4000,
): string {
  const range = doc.createRange();
  range.setStartAfter(el);
  if (nextEl) range.setEnd(nextEl, 0);
  else range.setEndAfter(root);
  const container = doc.createElement("div");
  container.appendChild(range.cloneContents());
  return truncateMarkdown(turndown.turndown(container), maxChars);
}

/** 截断到 maxChars,尽量在行边界断开 */
function truncateMarkdown(md: string, maxChars: number): string {
  if (md.length <= maxChars) return md;
  const cut = md.slice(0, maxChars);
  const nl = cut.lastIndexOf("\n");
  return nl > maxChars * 0.8 ? cut.slice(0, nl) : cut;
}

/** 按行扫描收集标题锚点;跳过 ``` / ~~~ 围栏内部,代码里的 "# 注释" 不算标题 */
function scanHeadings(md: string): HeadingAnchor[] {
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
    lineStart += rawLine.length + 1;
  }
  return headings;
}

/** pos 所在位置的上层标题链(h1 → 最近上级标题) */
function headingChainAt(doc: VirtualDoc, pos: number): { level: number; title: string }[] {
  const chain: HeadingAnchor[] = [];
  for (const h of doc.headings) {
    if (h.offset > pos) break;
    while (chain.length > 0 && chain[chain.length - 1].level >= h.level) chain.pop();
    chain.push(h);
  }
  return chain.map(({ level, title }) => ({ level, title }));
}

// ---- page_read ----

/**
 * 窗口读取:[offset, offset+chars) 原样切片,不做行边界回吸——
 * 无状态协议必须保证 offset 单调推进,回吸会在超长单行内容上翻页停滞。
 */
export function runPageRead(doc: VirtualDoc, offset: unknown, chars: unknown) {
  if (
    offset !== undefined &&
    (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0)
  ) {
    throw new Error(
      "page_read: offset 必须是非负整数(取自上次响应的 next_offset 或 page_find 的 pos)",
    );
  }
  if (
    chars !== undefined &&
    (typeof chars !== "number" || !Number.isInteger(chars) || chars <= 0)
  ) {
    throw new Error("page_read: chars 必须是正整数(建议 6000 内,上限 20000)");
  }
  const off = typeof offset === "number" ? offset : 0;
  if (off >= doc.totalChars) {
    throw new Error(
      `page_read: offset ${off} 已超出文档总长(${doc.totalChars} 字符)。文档已读完,` +
        `要用其它主题请调用 page_find 定位新的 pos;若页面内容已更新(SPA 切页),传 refresh=true 重新提取`,
    );
  }
  const size = Math.min(Math.max(typeof chars === "number" ? chars : READ_WINDOW_DEFAULT, 500), READ_WINDOW_MAX);
  const end = Math.min(off + size, doc.totalChars);
  const done = end >= doc.totalChars;
  return {
    title: doc.title,
    url: doc.url,
    offset: off,
    end,
    total_chars: doc.totalChars,
    next_offset: done ? null : end,
    done,
    ...(doc.truncatedTotal ? { truncated_total: true } : {}),
    headings: headingChainAt(doc, off),
    text: doc.md.slice(off, end),
  };
}

// ---- page_find ----

/** 单个 term 在一份文档里最多统计的命中数(常见词防刷屏) */
const FIND_HITS_PER_TERM_CAP = 150;
/** 命中聚簇的距离阈值(字符) */
const FIND_CLUSTER_GAP = 260;

const CJK_CHAR_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/**
 * 查询词展开:英文/数字 token 整串保留;连续中文串拆成重叠二字组,
 * 「性能优化方法」→ 性能/能优/优化/化方/方法,改写语序也能召回。
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

/** 检索词切分:空白/标点切,去空 */
function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,.;:!?()'"[\]{}<>|~`@#$%^&*+=/\\，。；：！？、《》「」【】]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

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

/** 全文定位:词位合并、按距离聚簇、多词共现加权,返回可寻址偏移 */
export function runPageFind(doc: VirtualDoc, query: unknown, limitRaw: unknown) {
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new Error("page_find requires a non-empty query string");
  }
  const limit =
    typeof limitRaw === "number" && Number.isFinite(limitRaw)
      ? Math.min(Math.max(1, Math.floor(limitRaw)), SEARCH_LIMIT_MAX)
      : SEARCH_LIMIT_DEFAULT;

  const lower = (doc.lower ??= doc.md.toLowerCase());
  const phrase = query.trim().toLowerCase();
  const terms = expandQueryTerms(query);

  type Hit = { pos: number; term: string };
  const hits: Hit[] = [];
  for (const t of terms) {
    for (const pos of collectPositions(lower, t, FIND_HITS_PER_TERM_CAP)) {
      hits.push({ pos, term: t });
    }
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

  type Cluster = {
    minPos: number;
    maxPos: number;
    count: number;
    terms: Set<string>;
    phraseHit: boolean;
  };
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
      c.terms.size * 2 +
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

// ---- page_outline ----

/** 大纲项的正文预览:取标题行之后的开头内容,≤60 字符,空则不带该字段 */
function outlinePreview(md: string, offset: number): { preview?: string } {
  const nl = md.indexOf("\n", offset);
  if (nl < 0) return {};
  const rest = md.slice(nl + 1).trimStart();
  if (!rest) return {};
  return { preview: rest.slice(0, 60) };
}

export function runPageOutline(doc: VirtualDoc) {
  const base = () => ({
    title: doc.title,
    url: doc.url,
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
      items: doc.headings.map(({ offset, level, title }) => ({
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
