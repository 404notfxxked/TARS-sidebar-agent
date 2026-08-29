// provider 层共享类型:配置、内部消息格式、ChatProvider 接口
// 这是 agent core 与 provider 之间的「内部契约」——core 只认识这些类型,不认识任何 provider

import type { ToolSchema } from "../../shared/toolTypes";

export interface ProviderConfig {
  apiKey: string;
  model: string;
  baseUrl?: string; // OpenAI 兼容端点,约定含 /v1,如 DeepSeek 用 https://api.deepseek.com/v1;缺省用官方地址
  maxTokens?: number; // 单次回复上限;设置才发送,缺省交给服务端默认
  /** maxTokens 用哪个请求字段:OpenAI 推理模型(o 系列/gpt-5)只认 max_completion_tokens,
   *  发旧的 max_tokens 会直接 400;兼容端点一律 max_tokens(缺省) */
  maxTokensField?: "max_tokens" | "max_completion_tokens";
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
  | {
      role: "assistant";
      content: string | null;
      toolCalls?: ToolCall[];
      /** 思考内容(DeepSeek 系 reasoning_content / OpenRouter 系 reasoning 归并)。
       *  只在单次 run 内逐轮回传(部分 vLLM 部署的工具循环要求一致性);
       *  落盘持久化时由 saveHistory 剥离 —— 严格端点对 assistant 消息的未知字段直接 400 */
      reasoning_content?: string;
      /** 产出该消息的模型 id(仅内部记录/排查用,永不发给 API) */
      model?: string;
    }
  | { role: "tool"; toolCallId: string; content: string };

export interface ChatRequest {
  messages: InternalMsg[];
  tools?: ToolSchema[];
  /** 流式文本增量,逐块回调给 UI */
  onDelta: (text: string) => void;
  /** 流式思考过程增量(reasoning_content);可选 —— provider 不支持时不回调 */
  onReasoningDelta?: (text: string) => void;
  /** 外部取消:agent 终止时中止网络请求 */
  signal?: AbortSignal;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  reasoning_content?: string;
  finishReason?: "stop" | "tool_calls" | "length";
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

/** 每个 provider 适配器都要实现的统一接口 */
export interface ChatProvider {
  chat(req: ChatRequest): Promise<ChatResult>;
}
