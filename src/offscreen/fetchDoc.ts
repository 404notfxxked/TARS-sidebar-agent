// 网页虚拟文档缓存(运行在 offscreen document):
// web_fetch 工具的解析端 —— 接收 SW 抓好的 HTML → buildVirtualDoc 转规范
// markdown → 按 URL 缓存(LRU)→ 复用 page_read 的窗口协议切片。
// 抓取在 SW(background/webFetch.ts):与 web_search 的「SW 抓取、offscreen
// 解析」分工一致;这里只做纯 DOM/文本运算,不做网络。

import { buildVirtualDoc, runPageRead, type VirtualDoc } from "./pipeline";
import { createLogger } from "../shared/logger";

const log = createLogger({ ctx: "off" });

/** URL 缓存份数上限(LRU,超出淘汰最久未用) */
const FETCH_CACHE_MAX = 6;

const cache = new Map<string, { doc: VirtualDoc; at: number }>();

function lruEvict(): void {
  while (cache.size > FETCH_CACHE_MAX) {
    let oldestUrl = "";
    let oldestAt = Infinity;
    for (const [url, entry] of cache) {
      if (entry.at < oldestAt) {
        oldestAt = entry.at;
        oldestUrl = url;
      }
    }
    if (!oldestUrl) break;
    cache.delete(oldestUrl);
  }
}

/** offscreen → SW 的稳定协议前缀:缓存里没有这个 URL(SW 据此走抓取路径) */
const NOT_CACHED_PREFIX = "NOT_CACHED:";

/** 用 SW 抓到的 HTML 构建虚拟文档并入缓存 */
export function fetchBuild(args: { url: string; html: string; base: string }): void {
  if (!args.url || typeof args.html !== "string") {
    throw new Error("fetch_build 参数不完整(url/html)");
  }
  const startedAt = Date.now();
  // 标题用正则从原文提取,避免为取 <title> 把大 HTML 再 parse 一遍
  const title = (/<title[^>]*>([^<]*)<\/title>/i.exec(args.html)?.[1] ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const doc = buildVirtualDoc({ html: args.html, baseURI: args.base, url: args.base, title });
  cache.set(args.url, { doc, at: Date.now() });
  lruEvict();
  log.info("fetch", "网页已解析入库", {
    ms: Date.now() - startedAt,
    htmlBytes: args.html.length,
    totalChars: doc.totalChars,
    url: args.base,
  });
}

/** 按窗口切片(协议同 page_read);未缓存抛 NOT_CACHED 前缀错误,由 SW 决定重建 */
export function fetchRead(args: { url: string; offset?: unknown; chars?: unknown }) {
  const hit = cache.get(args.url);
  if (!hit) {
    throw new Error(`${NOT_CACHED_PREFIX}${args.url}`);
  }
  hit.at = Date.now();
  return runPageRead(hit.doc, args.offset, args.chars);
}
