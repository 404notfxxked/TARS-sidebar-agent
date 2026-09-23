// 出口:内部契约(InternalMsg)是 chat-completions 扁平形状,chat-completions 与
// anthropic-messages 两种协议各由一个适配器实现,经 createChatProvider 按 kind 分派

import type { ProviderKind } from "../../shared/configStore";
import { ChatCompletionsAdapter } from "./chatCompletions";
import { AnthropicMessagesAdapter } from "./anthropicMessages";
import type { ChatProvider } from "./types";

export { ChatCompletionsAdapter, DEFAULT_CHAT_COMPLETIONS_URL } from "./chatCompletions";
export { AnthropicMessagesAdapter, DEFAULT_ANTHROPIC_MESSAGES_URL } from "./anthropicMessages";
export { fetchModels, ModelsFetchError } from "./models";
export type { FetchModelsResult, ModelsErrorCode } from "./models";
export type {
  ChatProvider,
  ChatResult,
  InternalMsg,
  MessageImage,
} from "./types";

/** 适配器共用配置超集:各适配器只取自己认识的字段(maxTokensField 仅
 *  chat-completions 有意义;serverWebSearch 仅 anthropic-messages 有意义;
 *  kind 分派见 createChatProvider) */
export interface ChatProviderConfig {
  kind?: ProviderKind;
  apiKey: string;
  model: string;
  baseUrl?: string;
  maxTokens?: number;
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  reasoningEffort?: string;
  /** 实验开关:服务端 web_search(见 anthropicMessages SERVER_WEB_SEARCH_TOOL) */
  serverWebSearch?: boolean;
}

/** 按供应商协议分派适配器:缺省(旧配置无 kind 字段)一律 chat-completions,
 *  历史配置零迁移;responses 仅预留枚举,适配器二期实现 */
export function createChatProvider(cfg: ChatProviderConfig): ChatProvider {
  if (cfg.kind === "anthropic-messages") return new AnthropicMessagesAdapter(cfg);
  if (cfg.kind === "responses") {
    throw new Error(
      "OpenAI Responses 协议暂未支持,请在 设置 → 模型服务 把 API 格式切换为 Chat Completions",
    );
  }
  return new ChatCompletionsAdapter(cfg);
}
