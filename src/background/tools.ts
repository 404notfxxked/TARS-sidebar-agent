// 工具注册表 - agent loop 可调用的工具

import { callContentTool, getActiveTabId } from "../shared/contentTools";
import { callOffscreenTool, ensureOffscreenDocument } from "../shared/docBridge";
import { getToolExecutionContext } from "./toolContext";
import type { ToolSchema } from "../shared/toolTypes";

/** 工具定义:注册表条目 = 共享的 ToolSchema(纯 schema)+ 可执行的 execute */
export interface Tool<P = unknown, R = unknown> extends ToolSchema {
  /** 面板展示名;只在注册表条目上,不进 ToolSchema(那是给 LLM 的 wire 契约) */
  displayName?: string;
  execute: (args: P) => Promise<R>;
}

const registry: Tool[] = [];

export function registerTool<P, R>(tool: Tool<P, R>): void {
  registry.push(tool as unknown as Tool);
}

export function getTool(name: string): Tool | undefined {
  return registry.find((t) => t.name === name);
}

// 导出为 provider 需要的 function calling schema
// Tool 继承了 ToolSchema,直接返回即可(多余的 execute 字段对消费方无影响)
export function toProviderToolSchemas(): ToolSchema[] {
  return registry;
}

/** 解析目标 tabId:参数指定 > run 作用域(提交时捕获) > 实时激活 tab */
async function resolveTargetTabId(args?: { tabId?: number }): Promise<number> {
  const ctx = getToolExecutionContext();
  const tabId = args?.tabId ?? ctx?.tabId ?? (await getActiveTabId());
  if (tabId === null) throw new Error("no active tab");
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
  displayName: "列出标签页",
  description:
    "列出当前窗口所有 tab(tabId、标题、URL),并标记每个 tab 是否为页面工具省略 tabId 时的默认作用页(default,即提交时的页面)与当前激活页(active)。<context> 里的 tab 清单是提交时的快照,运行中可能已变化(新开/关闭/切换);当工具报「tab 不存在」或「无法注入内容脚本」时,先调用本工具获取最新清单,再选正确的 tabId 重试。",
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
  displayName: "窗口读取",
  description:
    "按字符偏移读取页面内容的一个窗口(保持标题/列表/代码块的 markdown 结构)。用法:offset 来自 page_outline 大纲项或 page_find 命中项,省略则从头读;返回里 next_offset 非 null 说明后面还有内容,把它再传进 offset 即可顺序往下翻页,done=true 表示已到结尾。headings 是当前窗口所属的上层标题链。offset/pos 是工具内部定位用的字符偏移,回复用户时用标题或原文指代,不要输出数字。\n何时用:长文档读完整体结构后精确阅读某节上下文;page_find 命中后立即带 pos 读前后文;短小页面直接从头读一次即可。\n何时别用:只是想知道有没有某主题 → 先 page_find;只想看章节列表 → page_outline。",
  parameters: {
    type: "object",
    properties: {
      offset: {
        type: "number",
        description:
          "起始字符偏移;来自 page_outline 的 offset / page_find 的 pos / 上次本工具返回的 next_offset;省略则从文档开头读",
      },
      chars: { type: "number", description: "本窗口大小(字符),默认 6000,最大 20000" },
      refresh: {
        type: "boolean",
        description: "强制重新提取页面快照;仅当怀疑页面已更新(SPA 切换路由、点击后刷新)时使用",
      },
      tabId: { type: "number", description: "目标 tab 的 id;省略则用当前激活 tab" },
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
  displayName: "定位内容",
  description:
    "在页面全文中定位关键词相关的内容区域,按相关度返回 Top-N 结果,每项含:pos(在页面内容中的字符偏移)、snippet(命中片段)、headings(所在位置的上层标题链)。中文查询会自动做二字组模糊匹配,换一种说法的表述也能找到,不必是页面原文逐字串。拿到结果后立刻用 page_read(offset=pos) 读该处完整上下文;多个分散命中可以分别各读一小窗对比。\n何时用:长文档里问「关于 xx」「哪里讲了 xx」;需要确认某个主题在不在页面里。\n何时别用:页面很小直接 page_read 从头读;要章节列表用 page_outline。pos 是内部定位偏移,不要向用户复述。",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "检索词:关键词、短语或问题里的核心名词组合" },
      limit: { type: "number", description: "最多返回命中区域数,默认 5,上限 10" },
      refresh: {
        type: "boolean",
        description: "强制重新提取页面快照;仅在怀疑页面已变化时使用",
      },
      tabId: { type: "number", description: "目标 tab 的 id;省略则用当前激活 tab" },
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
  displayName: "页面大纲",
  description:
    "读取页面的标题大纲,每项含 offset(可直接作为 page_read 的 offset 跳到该节开头)、层级和标题;超长文档自动折叠深层小节,保留项带 descendant_headings 计数。同时给出 total_chars 帮你判断文档体量。先看它再决定怎么读,能显著减少来回试探。\n何时用:回答「这文档有哪些章节/讲什么结构」,或开始精读前的第一步地图。\n何时别用:无标题结构的页面 items 会为空(hint 有提示),改用 page_find 定位;很短的页面不必看大纲,直接 page_read 全读。",
  parameters: {
    type: "object",
    properties: {
      refresh: {
        type: "boolean",
        description: "强制重新提取页面快照;仅在怀疑页面已变化时使用",
      },
      tabId: { type: "number", description: "目标 tab 的 id;省略则用当前激活 tab" },
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


// ---- 页面交互工具(观察 + 动作)----
// 观察/动作分离:find_elements 定位(返回绝对 selector),click/fill 执行。
// selector 来自最近一次 find_elements;页面重渲染后失效 → 重新 find_elements,不要原样重试。

// 观察:定位可交互元素(selector 供 click_element / fill_input 使用)
registerTool<
  { text?: string; role?: string; limit?: number; tabId?: number },
  { count?: number; returned?: number; truncated?: boolean; elements?: unknown[] }
>({
  type: "function",
  name: "find_elements",
  displayName: "查找元素",
  description:
    "在当前页面查找可交互元素(按钮/链接/输入框/下拉框/复选框/单选/开关/可编辑区),返回每个元素的 selector(CSS 绝对路径)、tag、role、label、state 和可见性,以及 count/returned/truncated 计数。\n何时用:需要在页面上点击、填写、勾选某个控件之前,先调用它定位目标元素;返回的 selector 直接传给 click_element / fill_input。尽量带 text(按文字模糊匹配)或 role(按类型)缩小范围,不要空手调用——truncated=true 说明还有 count-returned 个未列出,可用 text/role 进一步收窄再查。\n何时别用:不要用它读文档正文(用 page_read / page_find);不要一次拉全页控件。返回的 selector 只是当前页面快照,页面异步加载或重渲染后可能失效;若后续 click/fill 报「元素未找到」,重新调用本工具取最新 selector。",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "按文字/标签/当前值做模糊匹配(子串,忽略大小写),用于缩小范围" },
      role: {
        type: "string",
        enum: ["button", "link", "input", "checkbox", "radio", "switch", "select", "textarea", "contenteditable"],
        description: "按元素类型过滤",
      },
      limit: { type: "number", description: "最多返回条数,默认 20,上限 50" },
      tabId: { type: "number", description: "目标 tab 的 id;省略则用当前激活 tab" },
    },
  },
  execute: async (args) => {
    const tabId = await resolveTargetTabId(args);
    return (await callContentTool(tabId, "find_elements", args)) as {
      count?: number;
      returned?: number;
      truncated?: boolean;
      elements?: unknown[];
    };
  },
});

// 动作:点击(完整指针事件序列,等价真实鼠标点击)
registerTool<{ selector: string; tabId?: number }, { clicked?: string }>({
  type: "function",
  name: "click_element",
  displayName: "点击元素",
  description:
    "点击页面上的一个元素,触发完整指针/鼠标事件序列(pointerover→pointerdown→mousedown→pointerup→mouseup→click),等价真实鼠标点击,React 等框架能正确感知。\n何时用:打开链接、展开折叠、切换 tab/开关、提交/取消按钮等需要模拟用户点击的操作。selector 必须来自最近一次 find_elements 的返回。\n何时别用:不要用它读内容;不要凭猜测拼 selector(页面重渲染后旧 selector 会失效)。若报「元素未找到」或「被遮挡」,重新 find_elements 定位,不要原样重试。",
  parameters: {
    type: "object",
    properties: {
      selector: { type: "string", description: "目标元素的 CSS 绝对路径,来自 find_elements 的返回" },
      tabId: { type: "number", description: "目标 tab 的 id;省略则用当前激活 tab" },
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
  displayName: "填写输入",
  description:
    "向输入控件写入文本并触发 input/change 事件(React 受控组件能正确感知)。支持 input、textarea、select(选中某选项)、contenteditable(富文本);pressEnterAfter=true 时写入后追加一次 Enter 按键(keyCode=13),省去单独回车。\n何时用:填写搜索框、表单、评论框,或选择下拉选项。selector 来自 find_elements 的返回。\n何时别用:只用于可输入控件,不要对普通 div/button 调用;不要猜 selector。若报错,重新 find_elements 定位。",
  parameters: {
    type: "object",
    properties: {
      selector: { type: "string", description: "输入控件的 CSS 绝对路径,来自 find_elements 的返回" },
      text: { type: "string", description: "要写入的文本;对 select 表示要选中的 option 的 value 或可见文字" },
      pressEnterAfter: { type: "boolean", description: "写入后追加一次 Enter(keyCode=13),搜索框提交用;省略默认 false" },
      tabId: { type: "number", description: "目标 tab 的 id;省略则用当前激活 tab" },
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
