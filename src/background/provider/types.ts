// provider 层共享类型:配置、内部消息格式、ChatProvider 接口
// 这是 agent core 与 provider 之间的「内部契约」——core 只认识这些类型,不认识任何 provider

import type { ToolSchema } from "../../shared/toolTypes";

export interface ProviderConfig {
  // provider 是「厂商」(openai/anthropic),决定走哪个 adapter;
  // 与 protocol(wire 格式)是两回事,但当前阶段厂商与协议一一对应,合并成一个字段即可。
  // 若未来出现「厂商与协议错位」(如 OpenAI key 走 Anthropic 协议的代理)再拆成 protocol。
  provider: "openai" | "anthropic";
  apiKey: string;
  model: string;
  baseUrl?: string; // 测试用覆盖,如 DeepSeek 用 https://api.deepseek.com/v1
}

// ToolSchema 已在 shared/toolTypes.ts 定义,这里再导出供 provider 层消费
export type { ToolSchema };

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

/** 内部消息格式 —— OpenAI 扁平形状(见记忆 agent-loop-byok-design) */
export type InternalMsg =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: ToolCall[]; reasoning_content?: string }
  | { role: "tool"; toolCallId: string; content: string };

export interface ChatRequest {
  messages: InternalMsg[];
  tools?: ToolSchema[];
  /** 流式文本增量,逐块回调给 UI */
  onDelta: (text: string) => void;
  /** 外部取消:agent 终止时中止网络请求 */
  signal?: AbortSignal;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  reasoning_content?: string;
  finishReason?: "stop" | "tool_calls" | "length";
}

/** 每个 provider 适配器都要实现的统一接口 */
export interface ChatProvider {
  chat(req: ChatRequest): Promise<ChatResult>;
}
