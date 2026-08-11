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
    case "get_page_content": {
      // 有标题结构 → 按节输出(带层级);无结构 → 兜底 flat 截断(优先 main/article 区域,别从导航开头截)
      const heads = collectHeadings();
      let text: string;
      if (heads.length > 0) {
        const parts: string[] = [];
        for (const [i, el] of heads.entries()) {
          if (i >= OUTLINE_MAX) break;
          parts.push(
            `${"#".repeat(headingLevel(el))} ${headingTitle(el)}\n${sectionText(el, heads[i + 1] ?? null)}`,
          );
        }
        text = parts.join("\n\n").slice(0, 8000);
      } else {
        const root = (document.querySelector("main, article") ?? document.body) as HTMLElement;
        text = root.innerText.slice(0, 8000);
      }
      return {
        title: document.title,
        url: location.href,
        text,
        hasStructure: heads.length > 0,
        htmlLength: document.documentElement.outerHTML.length,
      };
    }

    // 结构化读页(第二级):先拿大纲,再按 index 读具体某节,长文档不再整页 8000 截断
    case "get_page_structure":
      return {
        url: location.href,
        title: document.title,
        hasStructure: collectHeadings().length > 0,
        sections: buildOutline(),
      };

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
 * 某一节 = 从标题开头到下一个标题开头之间的文本;最后一节到 main/article/body 末尾。
 * maxChars 传 Infinity 表示整节返回(连续读取用,不中途截断);默认 4000 兜底单节。
 */
function sectionText(
  from: HTMLElement,
  to: HTMLElement | null,
  maxChars = 4000,
): string {
  const root = document.querySelector("main, article") ?? document.body;
  const range = document.createRange();
  range.setStart(from, 0);
  if (to) range.setEnd(to, 0);
  else range.setEndAfter(root);
  return range.toString().replace(/\s+/g, " ").trim().slice(0, maxChars);
}

/** 大纲上限:超长文档只列前 N 节,read_section 仍可用更大的 index(仅大纲不列) */
const OUTLINE_MAX = 30;

/** 连续读取单次最多覆盖的节数(整节不截断,靠节数上限兜底防超长) */
const MAX_RANGE_SPAN = 20;

/** 大纲:标题列表的位置即节 index */
function buildOutline(): {
  index: number;
  level: number;
  title: string;
  preview: string;
}[] {
  const heads = collectHeadings();
  return heads.slice(0, OUTLINE_MAX).map((el, i) => ({
    index: i,
    level: headingLevel(el),
    title: headingTitle(el),
    preview: sectionText(el, heads[i + 1] ?? null).slice(0, 120),
  }));
}

