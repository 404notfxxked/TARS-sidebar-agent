// OpenAI-compatible 适配器:OpenAI / DeepSeek / Groq / vLLM / Ollama 都走这
// 只做「内部格式 ⇄ OpenAI wire 格式」的双向转换 + SSE 流式解析
// 类型用本地 SSEChunk / ToolSchema 即可,暂不引入第三方类型包(@open-schemas/types)

import { apiFetch } from "./client";
import { createLogger } from "../../shared/logger";
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

const log = createLogger({ ctx: "bg" });

/** Base URL 缺省时的官方地址(设置页与 agent 预检共用同一兜底口径) */
export const DEFAULT_BASE_URL = "https://api.openai.com/v1";

// 流中 inactivity watchdog:client 层超时只护到响应头,流中途断流
// (代理静默吞连接/端点挂起)会让 read() 永久悬挂。窗口取 120s ——
// 思考型模型两 delta 之间可以很久,但不会久到两分钟无任何字节
// (连心跳注释帧都算字节,正常端点撑不满这个窗口)
const STREAM_IDLE_TIMEOUT_MS = 120_000;

// SSE 流式事件的局部类型(只取我们关心的字段)
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

export class OpenAIAdapter implements ChatProvider {
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
    },
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
        ...(this.cfg.maxTokens
          ? {
              [this.cfg.maxTokensField ?? "max_tokens"]:
                this.cfg.maxTokens,
            }
          : {}),
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

// ---- SSE 解析(流式) ----

/**
 * 流式读取 SSE(Server-Sent Events)。
 *
 * 为什么流式:LLM 的回复是一点一点生成的,服务端把内容切成一串「事件」
 * 推送过来(每行以 `data:` 开头),客户端逐块读、边读边渲染 → 打字机效果。
 * 相比一次性等完整 JSON,流式能让用户立刻看到文字在输出。
 *
 * SSE 帧格式(每个事件之间用空行分隔):
 *   data: {"id":"...","choices":[{"delta":{"content":"你"}}]}
 *   data: {"id":"...","choices":[{"delta":{"content":"好"}}]}
 *   <空行>
 *   data: {"choices":[{"finish_reason":"stop"}]}
 *   data: [DONE]   ← 结束标记
 *
 * 注意:一次网络 read() 可能同时包含多个帧,也可能只包含半个帧,
 * 所以要用 buffer 攒着,按空行切出完整帧再解析,切剩下的留到下次。
 *
 * 兼容端点的三种脏形态都在这里消化:
 * - CRLF 行尾(规范允许 \r\n,某些代理/网关会改写):buffer 统一归一成 \n
 *   再切帧;孤立 \r 留在 buffer 里等下一个块的 \n 到齐,不会劈开帧
 * - 多行 data:(SSE 规范:一个事件可拆多行,按 \n 拼接成一整条载荷)
 * - 单帧 JSON 解析失败:跳过该帧 + warn 日志,不炸整个流 —— 流已开始,
 *   一帧脏数据没有重试的余地,丢弃远好于整轮失败
 */
/** 导出仅供单测:脏帧形态与看门狗的回归覆盖(idleTimeoutMs 注入短窗口) */
export async function* readSSE<T>(
  res: Response,
  idleTimeoutMs = STREAM_IDLE_TIMEOUT_MS,
): AsyncGenerator<T> {
  const reader = res.body!.getReader(); // 拿到响应体的可读流
  const decoder = new TextDecoder(); // 把二进制 Uint8Array 解码成字符串
  let buffer = ""; // 攒着还没凑成完整帧的残留数据
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  // 读一块字节,同时挂 120s 看门狗:窗口内没有任何字节到达(连注释
  // 心跳帧都算)即 abort。为什么不自动重试:流已开始,重放会重复
  // 已经发出去的 delta(UI 打字机与落库都接不上),只能报错交给人
  const readOrIdle = () =>
    Promise.race([
      reader.read().then((r) => {
        clearTimeout(idleTimer);
        return r;
      }),
      new Promise<never>((_, reject) => {
        idleTimer = setTimeout(
          () =>
            reject(
              new Error(
                `stream stalled: no bytes for ${idleTimeoutMs}ms (endpoint or proxy may have dropped the stream)`,
              ),
            ),
          idleTimeoutMs,
        );
      }),
    ]);

  try {
    while (true) {
      // 从流里读一段(可能很短,也可能很大);done=true 表示流结束了
      const { done, value } = await readOrIdle();
      if (done) break;
      // stream:true 表示流式解码,多字节字符跨块时会正确衔接
      buffer += decoder.decode(value, { stream: true });
      // CRLF 归一:必须在切帧前做,否则 "\r\n\r\n" 切不出 "\n\n" 帧边界。
      // 块尾孤立的 \r 先留着,下一个块的 \n 到齐后自然被这行归一吸收
      buffer = buffer.replace(/\r\n/g, "\n");

      // 按空行切出「完整帧」;最后一段可能还不完整,pop 出来留到下次
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        // 多行 data: 按规范拼成一整条载荷(事件可跨行写)
        const data = part
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (data === "[DONE]") return; // 结束标记,整个生成器到此结束
        if (!data) continue; // 纯注释/心跳帧
        let event: T;
        try {
          event = JSON.parse(data) as T;
        } catch {
          log.warn("sse", "跳过无法解析的 SSE 帧", {
            head: data.slice(0, 120),
          });
          continue;
        }
        yield event;
      }
    }
  } finally {
    clearTimeout(idleTimer);
    // 看门狗超时路径:挂起的 read() 不会自己醒,cancel 掉以释放底层连接;
    // 正常结束/[DONE] 早退路径 cancel 一个已关闭的流是无害 no-op
    reader.cancel().catch(() => {});
  }
}
