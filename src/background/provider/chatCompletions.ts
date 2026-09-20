// Chat Completions 协议适配器(原 openai.ts,按协议更名):OpenAI / DeepSeek /
// Groq / vLLM / Ollama 等一切兼容端点都走这;Anthropic Messages 见 anthropicMessages.ts
// 只做「内部格式 ⇄ chat-completions wire 格式」的双向转换;SSE 流式解析在共享层 sse.ts
// 类型用本地 SSEChunk / ToolSchema 即可,暂不引入第三方类型包(@open-schemas/types)

import { apiFetch } from "./client";
import { readSSE } from "./sse";
import { bytesToBase64 } from "../../shared/imageCodec";
import type {
  ChatProvider,
  ChatRequest,
  ChatResult,
  InternalMsg,
  MessageImage,
  ToolSchema,
  ToolCall,
} from "./types";

// SSE 解析在共享层(与 MCP 响应同一套准绳);此处按原路径再导出,
// chatCompletions.test.ts 的脏形态回归(硬规则 9 准绳)继续从这里取
export { readSSE } from "./sse";

/** Base URL 缺省时的官方地址(设置页与 agent 预检共用同一兜底口径) */
export const DEFAULT_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1";

// SSEChunk 局部类型
type SSEChunk = {
  error?: { message?: string };
  choices?: Array<{
    delta?: {
      content?: string | null;
      // 思考内容的两种方言:DeepSeek 系(DeepSeek/Qwen/GLM/SiliconFlow…)用
      // reasoning_content;OpenRouter / 新版 vLLM / Together 用扁平的 reasoning
      reasoning_content?: string;
      reasoning?: string;
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

// ---- 思考程度 → wire 参数 ----
// 档位值(low/medium/high/max/xhigh/minimal)各家 OpenAI 兼容层已事实收敛
// 到 reasoning_effort,直传;「关」没有统一参数,按模型 id 家族分派。
// 家族识别不出时不发任何参数——猜错参数会 400,跟随模型默认永远安全。
// 例外如实标注:o 系/gpt-5 无法真正关思考,off 降级为 minimal(最低档)。

function thinkingFamily(model: string): string {
  if (/(^|\/)deepseek/i.test(model)) return "deepseek";
  if (/(^|\/)glm/i.test(model)) return "glm";
  if (/qwen|qwq/i.test(model)) return "qwen";
  if (/(^|\/)gemini/i.test(model)) return "gemini";
  if (/(^|\/)(o[1345](-|$)|gpt-5)/i.test(model)) return "openai";
  return "unknown";
}

function thinkingParam(
  effort: string | undefined,
  model: string,
): Record<string, unknown> {
  if (!effort) return {};
  if (effort === "off") {
    switch (thinkingFamily(model)) {
      case "deepseek":
      case "gemini":
        return { reasoning_effort: "none" };
      case "glm":
        return { thinking: { type: "disabled" } };
      case "qwen":
        return { enable_thinking: false };
      case "openai":
        return { reasoning_effort: "minimal" };
      default:
        return {};
    }
  }
  if (effort === "on") {
    // 纯开关模型的「开」:只有 glm/qwen 需要显式发,其余家族开就是默认,
    // 不发参数(发了未知字段反而可能 400)
    switch (thinkingFamily(model)) {
      case "glm":
        return { thinking: { type: "enabled" } };
      case "qwen":
        return { enable_thinking: true };
      default:
        return {};
    }
  }
  return { reasoning_effort: effort };
}

export class ChatCompletionsAdapter implements ChatProvider {
  constructor(
    private cfg: {
      apiKey: string;
      model: string;
      // OpenAI 兼容端点,约定含 /v1(如 DeepSeek 用 https://api.deepseek.com/v1);缺省用官方地址
      baseUrl?: string;
      maxTokens?: number;
      /** OpenAI 推理模型(o 系列/gpt-5)只认 max_completion_tokens,发旧的
       *  max_tokens 会直接 400;兼容端点一律 max_tokens(缺省) */
      maxTokensField?: "max_tokens" | "max_completion_tokens";
      /** 思考程度(undefined = 跟随模型默认,不发任何参数):"off" = 请求关
       *  思考,其余为档位 token,经 thinkingParam 映射为 wire 参数 */
      reasoningEffort?: string;
    },
  ) {}

  async chat(req: ChatRequest): Promise<ChatResult> {
    const res = await apiFetch({
      baseUrl: this.cfg.baseUrl ?? DEFAULT_CHAT_COMPLETIONS_URL,
      apiKey: this.cfg.apiKey,
      path: "/chat/completions",
      body: {
        model: this.cfg.model,
        messages: toWireMessages(req.messages),
        ...(req.tools?.length ? { tools: req.tools.map(toWireTool) } : {}),
        ...(this.cfg.maxTokens
          ? {
              [this.cfg.maxTokensField ?? "max_tokens"]:
                this.cfg.maxTokens,
            }
          : {}),
        ...thinkingParam(this.cfg.reasoningEffort, this.cfg.model),
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
      if (!choice) {
        // 流中途错误帧(OpenAI 形状 {"error":{message,...}},无 choices):
        // 流已开始没有重试余地,但必须把服务端的话抛出去,不能静默吞成空回答
        if (event.error) {
          throw new Error(
            `LLM stream error: ${event.error.message ?? JSON.stringify(event.error)}`,
          );
        }
        continue;
      }

      const delta = choice.delta ?? {};
      if (typeof delta.content === "string") {
        content += delta.content;
        req.onDelta(delta.content);
      }
      // 两种方言都可能有(实际一家只会用其一),归并进同一缓冲
      if (typeof delta.reasoning_content === "string") {
        reasoning += delta.reasoning_content;
        hasReasoning = true;
        req.onReasoningDelta?.(delta.reasoning_content);
      }
      if (typeof delta.reasoning === "string") {
        reasoning += delta.reasoning;
        hasReasoning = true;
        req.onReasoningDelta?.(delta.reasoning);
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
  // biome-ignore lint/suspicious/useIterableCallbackReturn: InternalMsg 的 role 已穷尽,switch 不存在漏 return
  return msgs.map((message) => {
    switch (message.role) {
      case "system":
        return { role: message.role, content: message.content };
      case "user":
        return toWireUserMessage(message);
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

/** user 消息 → wire。带图片时 content 变 parts 数组:文本在前、图片在后,
 *  data URL + detail auto(OpenAI 视觉形状,vLLM/OpenRouter/DeepSeek 等同形)。
 *  只有无 bytes 的图片(没被水合/被预算裁掉)直接跳过 —— tool/assistant 角色
 *  不能携带 image_url,所以图片只经 user 消息发(见 provider/types 注释) */
function toWireUserMessage(message: Extract<InternalMsg, { role: "user" }>) {
  const images = (message.images ?? []).filter((im) => im.bytes);
  if (images.length === 0) return { role: "user", content: message.content };
  return {
    role: "user",
    content: [
      { type: "text", text: message.content },
      ...images.map((im) => toWireImage(im)),
    ],
  };
}

function toWireImage(im: MessageImage) {
  return {
    type: "image_url",
    image_url: {
      url: `data:${im.mime};base64,${bytesToBase64(im.bytes!)}`,
      detail: "auto",
    },
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
