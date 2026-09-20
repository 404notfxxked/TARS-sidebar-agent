// provider 层共享类型:配置、内部消息格式、ChatProvider 接口
// 这是 agent core 与 provider 之间的「内部契约」——core 只认识这些类型,不认识任何 provider

import type { ToolSchema } from "../../shared/toolTypes";

// ToolSchema 已在 shared/toolTypes.ts 定义,这里再导出供 provider 层消费
export type { ToolSchema };

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

/**
 * 服务端工具块(Anthropic server tool,如 web_search_20250305):服务商在
 * 服务端执行搜索并把结果块内联进本轮响应,客户端零往返。web_search_tool_result
 * 里可能有 encrypted_index 等不可再造字段。
 *
 * **回传形状按端点类别分叉(见 anthropicMessages.ts 的 ReplayPolicy)**:官方
 * Anthropic 要求原样回传;兼容端点(bridge)的 Messages 输入侧没有这两个类型,
 * 原样送回会被端点的历史校验判成「thinking 未回传」的 400,只能降成文本载体。
 * 所以这里保存**响应原文**(不重组、不裁剪),由适配器在回传时决定形状。
 */
export type ServerToolBlock =
  | { type: "server_tool_use"; id: string; name: string; input: unknown }
  | {
      type: "web_search_tool_result";
      tool_use_id: string;
      content: unknown;
    };

/** 带签名的思考块:签名是纯 wire 往返材料(缺失/篡改即 400),原文展示走
 *  assistant.reasoning_content。签名只有官方 Anthropic 能校验 —— 桥接端点上
 *  回传形状同样由适配器按 ReplayPolicy 决定 */
export type ThinkingWireBlock = {
  type: "thinking";
  thinking: string;
  signature?: string;
};

/** 不可解密的加密思考块:官方端点必须原样回传;桥接端点不接受(DeepSeek 兼容
 *  矩阵标 Not Supported),回传时降成占位文本 */
export type RedactedThinkingWireBlock = { type: "redacted_thinking"; data: string };

/** 文本块:正文之外的附加字段(citations 等,citations 由流中 citation_delta
 *  累积)收在 raw 里,回传时原样展开 —— 服务端搜索轮引用的来源信息在正文外 */
export type WireTextBlock = {
  type: "text";
  text: string;
  raw?: Record<string, unknown>;
};

/**
 * assistant 消息上需要回传的 wire 块(不含本地 tool_use —— 它由 agent 侧从
 * toolCalls 重建)。适配器产出、适配器消费,agent core 只透传不解读;同构通道
 * 也为二期 Responses 的 reasoning+encrypted_content 预留。
 *
 * **数组顺序即 wire 顺序**:服务端工具轮里思考块会在搜索结果之后再次出现
 * (thinking → server_tool_use → web_search_tool_result → thinking → text,
 * Claude Code 的 WebSearch 同此形态),保存与回传都不得按类型分组重排。
 *
 * **思考连续性才是这类 400 的根因**:DeepSeek 文档要求「请求带 tools 时,历轮
 * reasoning 必须回传,含未调用工具的轮次」,缺失即 400 —— 报错文案是
 * 「content[].thinking must be passed back」,容易被误读成「服务端块被拒」。
 * 因此**每一条** assistant 回放行都要能拿到思考:wireBlocks 缺失时由适配器用
 * reasoning_content 合成 unsigned 思考块(见 composeAssistantBlocks)。
 *
 * 随消息行原样落盘(persistableMsg 只剥图片字节),跨 run 的历史轮因此仍带着
 * 自己的 wire 块;回放投影不读此字段(展示走 reasoning_content)。
 */
export type WireBlock =
  | ThinkingWireBlock
  | RedactedThinkingWireBlock
  | ServerToolBlock
  | WireTextBlock;

/** 用户消息携带的图片。bytes 只在内存中存在(本 run 发送用);落盘/从历史
 *  加载的只有元数据,发送前由 agent 从 images store 按需水合 */
export interface MessageImage {
  id: string;
  mime: string;
  w: number;
  h: number;
  bytes?: Uint8Array;
}

/** 内部消息格式 —— OpenAI 扁平形状(见记忆 agent-loop-byok-design) */
export type InternalMsg =
  | { role: "system"; content: string }
  | { role: "user"; content: string; images?: MessageImage[] }
  | {
      role: "assistant";
      content: string | null;
      toolCalls?: ToolCall[];
      /** 思考内容(DeepSeek 系 reasoning_content / OpenRouter 系 reasoning 归并)。
       *  全量落盘(回放过程卡展示的元数据),回灌 prompt 时**不剥** —— DeepSeek
       *  官方契约:请求带 tools 时历轮 reasoning 必须回传(含未调用工具的轮次),
       *  缺失 400;chatCompletions 直接发该字段,anthropicMessages 在桥接端点上
       *  据此合成 unsigned 思考块(见 WireBlock 注释) */
      reasoning_content?: string;
      /** 响应里的 wire 块(Anthropic 思考/服务端工具/带附加字段的文本),保序
       *  见 WireBlock 注释。agent 只在工具轮附上(最终回答行没有);跨 run 的
       *  思考连续性由 reasoning_content 兜底 */
      wireBlocks?: WireBlock[];
      /** 产出该消息的模型 id(仅内部记录/排查用,永不发给 API) */
      model?: string;
      /** 运行失败占位行:content 即错误文本。全量落盘供回放渲染错误气泡;
       *  组装 prompt 时整行滤除(loadTranscript)—— 错误文本不是模型说过的话,
       *  回灌会污染上下文 */
      error?: true;
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
  /** 原样回传的 wire 块,由 agent 附到 assistant 消息上供工具循环回传(见 WireBlock) */
  wireBlocks?: WireBlock[];
  finishReason?: "stop" | "tool_calls" | "length";
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

/** 每个 provider 适配器都要实现的统一接口 */
export interface ChatProvider {
  chat(req: ChatRequest): Promise<ChatResult>;
}
