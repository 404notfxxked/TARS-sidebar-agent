// 工厂:按配置返回对应的 provider 适配器

import { OpenAIAdapter } from './openai'
import { AnthropicAdapter } from './anthropic'
import type { ProviderConfig, ChatProvider } from './types'

export function getChatProvider(config: ProviderConfig): ChatProvider {
  switch (config.provider) {
    case 'openai':
      return new OpenAIAdapter(config)
    case 'anthropic':
      return new AnthropicAdapter(config)
  }
}

export type { ProviderConfig, ChatProvider, ChatRequest, ChatResult, InternalMsg, ToolSchema, ToolCall } from './types'
