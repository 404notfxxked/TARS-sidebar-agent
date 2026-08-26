// 工具注册表 - agent loop 可调用的工具

import { callContentTool, getActiveTabId } from "../shared/contentTools";
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

// 读取当前页(经 content script)——M1 的读页工具。
// 现在按标题分节输出(带 # 层级标记),无标题结构时退回纯文本截断。
registerTool<
  { tabId?: number },
  { title?: string; url?: string; text?: string; hasStructure?: boolean }
>({
  type: "function",
  name: "get_page_content",
  displayName: "读取页面",
  description:
    "读取指定网页的结构化正文(按 h1-h6 标题分节,带 # 层级)。适合短页一次读完;长文档内容会被截断,改用 get_page_structure + read_section 按需读节。仅当回答依赖页面具体内容时才调用;能用通用知识回答的问题(概念解释、常识)不要调用。",
  parameters: {
    type: "object",
    properties: {
      tabId: { type: "number", description: "目标 tab 的 id;省略则用当前激活 tab" },
    },
  },
  execute: async (args) => {
    const tabId = await resolveTargetTabId(args);
    return (await callContentTool(tabId, "get_page_content")) as {
      title?: string;
      url?: string;
      text?: string;
      hasStructure?: boolean;
    };
  },
});

// 结构化读页(第二级):先拿大纲,再按 index 读具体某节,长文档按需读取
registerTool<
  { tabId?: number },
  { url?: string; sections?: unknown[]; hasStructure?: boolean; total?: number }
>({
  type: "function",
  name: "get_page_structure",
  displayName: "读取大纲",
  description:
    "读取指定页面的大纲(按 h1-h6 标题分节,含每节开头 preview 和总节数 total;无标题结构时 sections 为空)。先调用它了解文档结构,再按需用 read_section 读具体某节;sections 条数少于 total 说明大纲未列全。",
  parameters: {
    type: "object",
    properties: {
      tabId: { type: "number", description: "目标 tab 的 id;省略则用当前激活 tab" },
    },
  },
  execute: async (args) => {
    const tabId = await resolveTargetTabId(args);
    return (await callContentTool(tabId, "get_page_structure")) as {
      url?: string;
      sections?: unknown[];
      hasStructure?: boolean;
      total?: number;
    };
  },
});

registerTool<
  { index: number; until?: number; tabId?: number },
  { from?: number; to?: number; level?: number; title?: string; text?: string }
>({
  type: "function",
  name: "read_section",
  displayName: "读取章节",
  description:
    "按 get_page_structure 返回的大纲 index 读取一节或连续多节(index 到 until,含)的完整文本。连续片段用 until 一次读取(整节返回,不中途截断);分散片段或单节内容特别长可多次单独调用。",
  parameters: {
    type: "object",
    properties: {
      index: { type: "number", description: "起始节序号,从 0 开始" },
      until: {
        type: "number",
        description: "结束节序号(含),省略则只读 index 一节;连续多节时用它一次读完",
      },
      tabId: { type: "number", description: "目标 tab 的 id;省略则用当前激活 tab" },
    },
    required: ["index"],
  },
  execute: async (args) => {
    const tabId = await resolveTargetTabId(args);
    return (await callContentTool(tabId, "read_section", args)) as {
      from?: number;
      to?: number;
      level?: number;
      title?: string;
      text?: string;
    };
  },
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
    "在当前页面查找可交互元素(按钮/链接/输入框/下拉框/复选框/单选/开关/可编辑区),返回每个元素的 selector(CSS 绝对路径)、tag、role、label、state 和可见性,以及 count/returned/truncated 计数。\n何时用:需要在页面上点击、填写、勾选某个控件之前,先调用它定位目标元素;返回的 selector 直接传给 click_element / fill_input。尽量带 text(按文字模糊匹配)或 role(按类型)缩小范围,不要空手调用——truncated=true 说明还有 count-returned 个未列出,可用 text/role 进一步收窄再查。\n何时别用:不要用它读文档正文(用 get_page_content / get_page_structure / read_section);不要一次拉全页控件。返回的 selector 只是当前页面快照,页面异步加载或重渲染后可能失效;若后续 click/fill 报「元素未找到」,重新调用本工具取最新 selector。",
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
