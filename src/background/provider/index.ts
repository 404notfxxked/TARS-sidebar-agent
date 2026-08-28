// 出口:只支持 OpenAI 兼容协议(DeepSeek/Kimi/OpenRouter/vLLM/Ollama 等通用),
// 内部契约(InternalMsg)本就是 OpenAI 扁平形状,无需多适配器工厂

export { OpenAIAdapter } from "./openai";
export { fetchModels } from "./models";
export type {
  ProviderConfig,
  ChatProvider,
  ChatRequest,
  ChatResult,
  InternalMsg,
  ToolSchema,
  ToolCall,
} from "./types";
