// 工具注册表 - agent loop 可调用的工具

import type { AgentEvent } from "../shared/messages";
import { callContentTool, getActiveTabId } from "../shared/contentTools";
import { getToolExecutionContext } from "./toolContext";
import type { ToolSchema } from "../shared/toolTypes";

/** 工具定义:注册表条目 = 共享的 ToolSchema(纯 schema)+ 可执行的 execute */
export interface Tool<P = unknown, R = unknown> extends ToolSchema {
  execute: (args: P) => Promise<R>;
}

const registry: Tool[] = [];

export function registerTool<P, R>(tool: Tool<P, R>): void {
  registry.push(tool as unknown as Tool);
}

export function getTool(name: string): Tool | undefined {
  return registry.find((t) => t.name === name);
}

export function getAllTools(): readonly Tool[] {
  return registry;
}

// 导出为 provider 需要的 function calling schema
// Tool 继承了 ToolSchema,直接返回即可(多余的 execute 字段对消费方无影响)
export function toProviderToolSchemas(): ToolSchema[] {
  return registry;
}

// ---- 示例工具占位 ----
registerTool<Record<string, never>, { url?: string; title?: string }>({
  type: "function",
  name: "get_current_tab",
  description: "获取当前激活 tab 的 URL 和标题",
  parameters: { type: "object", properties: {} },
  execute: async () => {
    // 优先用 run 作用域的 tab(提交时捕获),避免执行时切 tab 读错页面
    const ctx = getToolExecutionContext();
    const tabId = ctx?.tabId;
    if (tabId != null) {
      const tab = await chrome.tabs.get(tabId);
      return { url: tab?.url, title: tab?.title };
    }
    // 无 run 上下文(如 agent loop 外的直接调用)→ 退回实时激活 tab
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    return { url: tab?.url, title: tab?.title };
  },
});

// 读取当前页(经 content script)——M1 的读页工具。
// 现在按标题分节输出(带 # 层级标记),无标题结构时退回纯文本截断。
registerTool<
  Record<string, never>,
  { title?: string; url?: string; text?: string; hasStructure?: boolean }
>({
  type: "function",
  name: "get_page_content",
  description:
    "读取当前激活网页的结构化正文(按 h1-h6 标题分节,带 # 层级)。适合短页一次读完;长文档内容会被截断,改用 get_page_structure + read_section 按需读节。仅当回答依赖当前页面具体内容时才调用;能用通用知识回答的问题(概念解释、常识)不要调用。",
  parameters: { type: "object", properties: {} },
  execute: async () => {
    // 优先用 run 作用域的 tab(提交时捕获),避免执行时切 tab 读错页面
    const ctx = getToolExecutionContext();
    const tabId = ctx?.tabId ?? (await getActiveTabId());
    if (tabId === null) throw new Error("no active tab");
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
  Record<string, never>,
  { url?: string; sections?: unknown[]; hasStructure?: boolean; total?: number }
>({
  type: "function",
  name: "get_page_structure",
  description:
    "读取当前页面的大纲(按 h1-h6 标题分节,含每节开头 preview 和总节数 total;无标题结构时 sections 为空)。先调用它了解文档结构,再按需用 read_section 读具体某节;sections 条数少于 total 说明大纲未列全。",
  parameters: { type: "object", properties: {} },
  execute: async () => {
    const ctx = getToolExecutionContext();
    const tabId = ctx?.tabId ?? (await getActiveTabId());
    if (tabId === null) throw new Error("no active tab");
    return (await callContentTool(tabId, "get_page_structure")) as {
      url?: string;
      sections?: unknown[];
      hasStructure?: boolean;
    };
  },
});

registerTool<
  { index: number; until?: number },
  { from?: number; to?: number; level?: number; title?: string; text?: string }
>({
  type: "function",
  name: "read_section",
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
    },
    required: ["index"],
  },
  execute: async (args) => {
    const ctx = getToolExecutionContext();
    const tabId = ctx?.tabId ?? (await getActiveTabId());
    if (tabId === null) throw new Error("no active tab");
    return (await callContentTool(tabId, "read_section", args)) as {
      from?: number;
      to?: number;
      level?: number;
      title?: string;
      text?: string;
    };
  },
});

// 让 AgentEvent 被显式 import 时不被 tree-shake 误判
export type { AgentEvent };
