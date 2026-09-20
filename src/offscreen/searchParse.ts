// 搜索结果页解析(运行在 offscreen document 的扩展私有 DOM 环境):
// 仅服务免 Key 的 tab 搜索通道(tabSearch.ts 开真实标签页取整页 HTML)。
// 选择器只负责「定位条目」,文本清洗、URL 还原(DDG 跳转包装 / Bing 点击
// 包装)、去重与裁剪在这里统一收口。注意:DOMParser 解析出的文档 URL 是
// about:blank,相对链接必须用调用方传入的最终响应 URL(base)手工还原,
// 不能依赖 a.href 自动解析。百度的 /link?url= 是加密跳转,无法本地还原,
// 保留包装 URL(SW fetch 读取时会跟随重定向到真实 URL)。

import { oneLine } from "../shared/text";

export interface ParsedSearchResult {
  title: string;
  url: string;
  snippet: string;
}

type ResultParser = (doc: Document, base: string) => ParsedSearchResult[];

const PARSERS: Record<string, ResultParser> = {
  bing: parseBing,
  ddg: parseDdg,
  google: parseGoogle,
  baidu: parseBaidu,
};

/** 结果条数裁剪上限(单次解析最多保留多少条,超出直接丢弃) */
const PARSE_LIMIT_MAX = 20;
/** 字段长度上限:限制工具结果的 token 体量 */
const TITLE_MAX_CHARS = 200;
const SNIPPET_MAX_CHARS = 500;

export function parseSearchResults(
  kind: string,
  html: string,
  base: string,
  limit: number,
): ParsedSearchResult[] {
  const parser = PARSERS[kind];
  if (!parser) throw new Error(`unknown search parser: ${kind}`);
  const doc = new DOMParser().parseFromString(html, "text/html");
  const capped = Math.min(Math.max(1, Math.floor(limit) || 10), PARSE_LIMIT_MAX);

  const seen = new Set<string>();
  const out: ParsedSearchResult[] = [];
  for (const raw of parser(doc, base)) {
    const r = clean(raw);
    if (!r.title || !r.url || seen.has(r.url)) continue;
    seen.add(r.url);
    out.push(r);
    if (out.length >= capped) break;
  }
  return out;
}

// ---- 引擎解析器 ----

/** Bing:li.b_algo > h2 a(标题+链接),摘要在 p.b_lineclamp* / .b_caption p */
function parseBing(doc: Document, base: string): ParsedSearchResult[] {
  const out: ParsedSearchResult[] = [];
  for (const li of doc.querySelectorAll("li.b_algo")) {
    const a = li.querySelector("h2 a[href]");
    if (!a) continue;
    out.push({
      title: a.textContent ?? "",
      url: unwrapBingClick(resolveHref(a.getAttribute("href"), base)),
      snippet: textOf(
        li.querySelector("p[class*='b_lineclamp'], .b_caption p"),
      ),
    });
  }
  return out;
}

/** DuckDuckGo HTML 版:a.result__a(标题),摘要在同结果块内 a.result__snippet;
 *  链接常是 //duckduckgo.com/l/?uddg=<原URL编码> 的跳转包装,需还原 */
function parseDdg(doc: Document, base: string): ParsedSearchResult[] {
  const out: ParsedSearchResult[] = [];
  for (const a of doc.querySelectorAll("a.result__a")) {
    const root = a.closest(".result");
    out.push({
      title: a.textContent ?? "",
      url: unwrapDdgRedirect(resolveHref(a.getAttribute("href"), base)),
      snippet: textOf(root?.querySelector(".result__snippet") ?? null),
    });
  }
  return out;
}

/** Google:#rso 下的 div.g(或顶层结果块),标题在 a > h3,摘要在 .VwiC3b /
 *  [data-sncf];非 http(s) 的链接(Google 内部跳转/聚合块)直接丢弃 */
function parseGoogle(doc: Document, base: string): ParsedSearchResult[] {
  const out: ParsedSearchResult[] = [];
  for (const g of doc.querySelectorAll("#rso div.g, #rso > div")) {
    const a = g.querySelector("a[href]");
    const h3 = a?.querySelector("h3") ?? g.querySelector("h3");
    if (!a || !h3) continue;
    const href = a.getAttribute("href") ?? "";
    if (!/^https?:/i.test(href)) continue;
    out.push({
      title: h3.textContent ?? "",
      url: resolveHref(href, base),
      snippet: textOf(g.querySelector(".VwiC3b, [data-sncf], .IsZvec")),
    });
  }
  return out;
}

/** 百度:#content_left 的 .result/.c-container,标题在 h3 a;
 *  链接是 baidu.com/link?url=<加密串> 跳转包装,保留原样(无法本地还原) */
function parseBaidu(doc: Document, base: string): ParsedSearchResult[] {
  const out: ParsedSearchResult[] = [];
  for (const c of doc.querySelectorAll(
    "#content_left .result, #content_left .c-container",
  )) {
    const a = c.querySelector("h3 a[href]");
    if (!a) continue;
    out.push({
      title: a.textContent ?? "",
      url: resolveHref(a.getAttribute("href"), base),
      snippet: textOf(
        c.querySelector(
          "[class*='content-right'], .c-abstract, [class*='abstract']",
        ),
      ),
    });
  }
  return out;
}

// ---- 清洗与 URL 还原 ----

/** 原始 href 按最终响应 URL 还原为绝对地址;解析不了返回空串(条目会被丢弃) */
function resolveHref(raw: string | null, base: string): string {
  if (!raw) return "";
  try {
    return new URL(raw, base || undefined).href;
  } catch {
    return "";
  }
}

/** Bing 点击包装(/ck/a?...&u=a1<base64url>)还原为真实目标 URL。
 *  host 校验与 DDG 同款用「域边界 + 结尾」:裸后缀匹配会把 notbing.com
 *  之类蹭域也放进来 */
function unwrapBingClick(url: string): string {
  try {
    const u = new URL(url);
    if (/(^|\.)bing\.com$/.test(u.hostname) && u.pathname === "/ck/a") {
      const enc = u.searchParams.get("u") ?? "";
      if (enc.startsWith("a1")) {
        const b64 = enc.slice(2).replace(/-/g, "+").replace(/_/g, "/");
        const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
        const decoded = atob(pad);
        if (/^https?:\/\//i.test(decoded)) return decoded;
      }
    }
  } catch {
    /* 非 /ck/a 或解码失败,原样返回 */
  }
  return url;
}

/** DuckDuckGo 跳转包装(…/l/?uddg=<原URL编码>&rut=…)还原为真实目标 URL */
function unwrapDdgRedirect(url: string): string {
  try {
    const u = new URL(url);
    const uddg = u.searchParams.get("uddg");
    if (uddg && /(^|\.)duckduckgo\.com$/.test(u.hostname)) return uddg;
  } catch {
    /* 保底原样返回 */
  }
  return url;
}

function clean(r: ParsedSearchResult): ParsedSearchResult {
  return {
    title: oneLine(r.title, TITLE_MAX_CHARS),
    url: r.url,
    snippet: oneLine(r.snippet, SNIPPET_MAX_CHARS),
  };
}

function textOf(el: Element | null): string {
  return el?.textContent ?? "";
}
