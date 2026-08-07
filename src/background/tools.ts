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

// 读取当前页(经 content script)——M1 的读页工具
registerTool<
  Record<string, never>,
  { title?: string; url?: string; text?: string }
>({
  type: "function",
  name: "get_page_content",
  description:
    "读取当前激活网页的标题、URL 和正文文本(截断到 8000 字符),用于总结或答疑",
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
    };
  },
});

// 让 AgentEvent 被显式 import 时不被 tree-shake 误判
export type { AgentEvent };
