// Anthropic 适配器:内部扁平格式 → Anthropic 块格式(tool_use / tool_result)
// TODO: M1 第二阶段实现
// 要点:Anthropic 的工具调用是 content 块,不是顶层 tool_calls 字段;
//       工具结果以 tool_result 块挂在 user 消息里;system 是独立顶层字段。

import type { ChatProvider, ChatRequest, ChatResult } from './types'

export class AnthropicAdapter implements ChatProvider {
  constructor(_cfg: { apiKey: string; model: string; baseUrl?: string }) {}

  async chat(_req: ChatRequest): Promise<ChatResult> {
    throw new Error('AnthropicAdapter not implemented yet')
  }
}
