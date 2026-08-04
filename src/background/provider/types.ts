// provider 层共享类型:配置、内部消息格式、ChatProvider 接口
// 这是 agent core 与 provider 之间的「内部契约」——core 只认识这些类型,不认识任何 provider

import type { ToolSchema } from "../../shared/toolTypes";

export interface ProviderConfig {
  provider: "openai" | "anthropic"; // ? 这里把 provider 改成 protocol 是否更合理？或者说 provider 和 protocol 其实是两个东西？
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
  | { role: "assistant"; content: string | null; toolCalls?: ToolCall[] }
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
  finishReason?: "stop" | "tool_calls" | "length";
}

/** 每个 provider 适配器都要实现的统一接口 */
export interface ChatProvider {
  chat(req: ChatRequest): Promise<ChatResult>;
}
