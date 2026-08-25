// OpenAI-compatible 适配器:OpenAI / DeepSeek / Groq / vLLM / Ollama 都走这
// 只做「内部格式 ⇄ OpenAI wire 格式」的双向转换 + SSE 流式解析
// 类型用本地 SSEChunk / ToolSchema 即可,暂不引入第三方类型包(@open-schemas/types)

import { apiFetch } from "./client";
import type {
  ChatProvider,
  ChatRequest,
  ChatResult,
  InternalMsg,
  ToolSchema,
  ToolCall,
} from "./types";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

// SSE 流式事件的局部类型(只取我们关心的字段)
type SSEChunk = {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: "stop" | "tool_calls" | "length";
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

export class OpenAIAdapter implements ChatProvider {
  constructor(
    private cfg: { apiKey: string; model: string; baseUrl?: string },
  ) {}

  async chat(req: ChatRequest): Promise<ChatResult> {
    const res = await apiFetch({
      baseUrl: this.cfg.baseUrl ?? DEFAULT_BASE_URL,
      apiKey: this.cfg.apiKey,
      path: "/chat/completions",
      body: {
        model: this.cfg.model,
        messages: toWireMessages(req.messages),
        ...(req.tools?.length ? { tools: req.tools.map(toWireTool) } : {}),
        stream: true,
        stream_options: { include_usage: true },
      },
      signal: req.signal,
    });

    let content = "";
    let reasoning = "";
    let hasReasoning = false; // 区分「没收到字段」和「收到了但为空」——DeepSeek 要求后者也必须回传
    // 流式工具调用按 index 累加(arguments 是分片拼接的 JSON)
    const toolAcc: Record<number, { id: string; name: string; args: string }> =
      {};
    let finishReason: ChatResult["finishReason"];
    let lastUsage: ChatResult["usage"];

    for await (const event of readSSE<SSEChunk>(res)) {
      const choice = event.choices?.[0];
      if (event.usage) {
        lastUsage = {
          promptTokens: event.usage.prompt_tokens,
          completionTokens: event.usage.completion_tokens,
          totalTokens: event.usage.total_tokens,
        };
      }
      if (!choice) continue;

      const delta = choice.delta ?? {};
      if (typeof delta.content === "string") {
        content += delta.content;
        req.onDelta(delta.content);
      }
      if (typeof delta.reasoning_content === "string") {
        reasoning += delta.reasoning_content;
        hasReasoning = true;
        req.onReasoningDelta?.(delta.reasoning_content);
      }
      for (const tc of delta.tool_calls ?? []) {
        toolAcc[tc.index] ??= { id: "", name: "", args: "" };
        if (tc.id) toolAcc[tc.index].id = tc.id;
        if (tc.function?.name) toolAcc[tc.index].name += tc.function.name;
        if (tc.function?.arguments)
          toolAcc[tc.index].args += tc.function.arguments;
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }

    const toolCalls: ToolCall[] = Object.values(toolAcc)
      .filter((tool) => tool.name) // 忽略只有 index 没有 name 的空壳
      .map((tool) => ({
        id: tool.id,
        name: tool.name,
        args: safeParse(tool.args),
      }));

    return { content, toolCalls, ...(hasReasoning ? { reasoning_content: reasoning } : {}), finishReason, ...(lastUsage ? { usage: lastUsage } : {}) };
  }
}

// ---- 内部格式 → OpenAI wire ----

function toWireMessages(msgs: InternalMsg[]): unknown[] {
  return msgs.map((message) => {
    switch (message.role) {
      case "system":
      case "user":
        return { role: message.role, content: message.content };
      case "assistant":
        return {
          role: "assistant",
          content: message.content,
          ...(message.reasoning_content !== undefined
            ? { reasoning_content: message.reasoning_content }
            : {}),
          ...(message.toolCalls?.length
            ? { tool_calls: message.toolCalls.map(toWireToolCall) }
            : {}),
        };
      case "tool":
        return {
          role: "tool",
          tool_call_id: message.toolCallId,
          content: message.content,
        };
    }
  });
}

function toWireToolCall(toolCall: ToolCall) {
  return {
    id: toolCall.id,
    type: "function",
    function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args) },
  };
}

function toWireTool(tool: ToolSchema) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

// ---- SSE 解析(流式) ----

/**
 * 流式读取 SSE(Server-Sent Events)。
 *
 * 为什么流式:LLM 的回复是一点一点生成的,服务端把内容切成一串「事件」
 * 推送过来(每行以 `data:` 开头),客户端逐块读、边读边渲染 → 打字机效果。
 * 相比一次性等完整 JSON,流式能让用户立刻看到文字在输出。
 *
 * SSE 帧格式(每个事件之间用空行 `\n\n` 分隔):
 *   data: {"id":"...","choices":[{"delta":{"content":"你"}}]}
 *   data: {"id":"...","choices":[{"delta":{"content":"好"}}]}
 *   <空行>
 *   data: {"choices":[{"finish_reason":"stop"}]}
 *   data: [DONE]   ← 结束标记
 *
 * 注意:一次网络 read() 可能同时包含多个帧,也可能只包含半个帧,
 * 所以要用 buffer 攒着,按空行切出完整帧再解析,切剩下的留到下次。
 */
async function* readSSE<T>(res: Response): AsyncGenerator<T> {
  const reader = res.body!.getReader(); // 拿到响应体的可读流
  const decoder = new TextDecoder(); // 把二进制 Uint8Array 解码成字符串
  let buffer = ""; // 攒着还没凑成完整帧的残留数据

  while (true) {
    // 从流里读一段(可能很短,也可能很大);done=true 表示流结束了
    const { done, value } = await reader.read();
    if (done) break;
    // stream:true 表示流式解码,多字节字符跨块时会正确衔接
    buffer += decoder.decode(value, { stream: true });

    // 按空行切出「完整帧」;最后一段可能还不完整,pop 出来留到下次
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      for (const line of part.split("\n")) {
        if (!line.startsWith("data:")) continue; // 忽略注释行等
        const data = line.slice(5).trim(); // 去掉 "data:" 前缀
        if (data === "[DONE]") return; // 结束标记,整个生成器到此结束
        if (data) yield JSON.parse(data) as T; // 解析成 JSON 交给调用方
      }
    }
  }
}
