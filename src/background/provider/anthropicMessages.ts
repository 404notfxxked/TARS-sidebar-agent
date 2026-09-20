// Anthropic Messages 协议适配器:api.anthropic.com 及一切兼容端点(中转/网关)
// 只做「内部格式 ⇄ anthropic-messages wire 格式」的双向转换;SSE 流式解析在共享层 sse.ts
// 与 chatCompletions.ts 的结构对称:同样只发 stream:true,流中无重试(硬规则 9)

import { apiFetch } from "./client";
import { readSSE } from "./sse";
import { bytesToBase64 } from "../../shared/imageCodec";
import { createLogger } from "../../shared/logger";
import type {
  ChatProvider,
  ChatRequest,
  ChatResult,
  InternalMsg,
  MessageImage,
  ToolSchema,
  ToolCall,
  WireBlock,
  WireTextBlock,
} from "./types";

const log = createLogger({ ctx: "bg" });

/** Base URL 缺省时的官方地址(约定含 /v1,路径拼 /messages、/models) */
export const DEFAULT_ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1";

/** anthropic-version 请求头:稳定版本,兼容端点均认 */
const ANTHROPIC_VERSION = "2023-06-01";

// ---- 端点类别:历史回传口径的唯一分叉点 ----
// 官方 Anthropic 与「兼容端点」(bridge:DeepSeek /anthropic、Kimi /coding、
// 各类中转)对**历史回传**的要求相反,必须按端点分派,不能一套形状打天下:
//  - native(官方):签名思考块只有官方能校验,也只有它要求 / 接受服务端工具块
//    原样回传(web_search_tool_result 的 encrypted_content 不可再造)。
//  - bridge(兼容端点):Anthropic 签名在桥接侧无法校验;服务端工具块在
//    Messages **输入**侧没有对应类型,原样回传会让端点的历史校验失败 ——
//    DeepSeek 把它报成「thinking 未回传」的 400(2026-09-20 实测,同口径见
//    NousResearch/hermes-agent#17510、esengine/DeepSeek-Reasonix#8924)。
//    桥接口径 = 服务端工具块转文本载体 + 用 reasoning_content 合成 unsigned
//    思考块补「思考连续性」(DeepSeek 文档:请求带 tools 时,历轮 reasoning
//    必须回传,含未调用工具的轮次)。
type ReplayPolicy = { native: boolean };

const isAnthropicHost = (host: string) =>
  host === "anthropic.com" || host.endsWith(".anthropic.com");

/** baseUrl 主机名 → 端点类别。baseUrl 必填(设置页与 run 预检都前置拦截空值,
 *  不再有「留空 = 官方地址」的承诺);这里对空值仍回落官方常量,只作防御。
 *  解析不出主机名(用户手填了裸域名等)按兼容端点保守处理 —— 桥接口径对官方
 *  也安全(官方只是少拿到服务端块载荷),反过来则不成立 */
function isNativeAnthropicEndpoint(baseUrl: string | undefined): boolean {
  const raw = baseUrl?.trim() ? baseUrl : DEFAULT_ANTHROPIC_MESSAGES_URL;
  try {
    return isAnthropicHost(new URL(raw).hostname);
  } catch {
    return false;
  }
}

// ---- 服务端搜索(实验开关 serverWebSearch,仅 anthropic-messages) ----
// Anthropic server tool:声明即由服务商在服务端执行,结果以 server_tool_use /
// web_search_tool_result 块内联进本轮响应,客户端零往返、无本地 tool 消息。
// 本地同名 web_search 客户端工具必须从请求剔除 —— 同名声明会 400,且「服务端
// 版替代本地版」正是本开关的语义;剔除后若模型仍吐 web_search 的普通 tool_use
// (假服务端,只是格式兼容),会走本地注册表而失败,恰好成为可查证的信号。
const SERVER_WEB_SEARCH_TOOL = {
  type: "web_search_20250305",
  name: "web_search",
  max_uses: 3,
};

/** max_tokens 缺省:Anthropic 必填该字段;取与全仓窗口口径一致的下限
 *  (compaction/裁剪公式里的 maxTokens 默认假设就是 4096) */
const DEFAULT_MAX_TOKENS = 4096;

// ---- 思考程度 → wire 参数 ----
// Anthropic 是显式预算制(budget_tokens),不是档位直传:已知档位映射固定预算;
// off/undefined/未知档位一律不发参数 —— Claude 思考默认关,跟随默认永远安全
// (与 chatCompletions.ts thinkingParam 的「识别不出不发参数」同一判据)。
// 硬约束:max_tokens 必须 > budget_tokens,配置不足时抬高 max_tokens。

const THINKING_BUDGETS: Record<string, number> = {
  low: 4096,
  medium: 10240,
  high: 24576,
};
/** 开思考时输出预算至少要比思考预算多出的量(模型总得有地方写答案) */
const MIN_OUTPUT_BEYOND_BUDGET = 4096;

function resolveThinking(
  effort: string | undefined,
  configuredMaxTokens: number | undefined,
): { maxTokens: number; budgetTokens?: number } {
  const budget = effort === undefined ? undefined : THINKING_BUDGETS[effort];
  const maxTokens = Math.max(
    configuredMaxTokens ?? DEFAULT_MAX_TOKENS,
    budget !== undefined ? budget + MIN_OUTPUT_BEYOND_BUDGET : 0,
  );
  return { maxTokens, ...(budget !== undefined ? { budgetTokens: budget } : {}) };
}

// SSEChunk 局部类型:Anthropic 的每个 data 帧都是带 type 的事件
type SSEEvent = {
  type?: string;
  message?: { usage?: { input_tokens?: number } };
  index?: number;
  content_block?: {
    type?: string;
    id?: string;
    name?: string;
    data?: string;
    // 桥接端点(如 DeepSeek)可能不发 delta,把思考明文/签名整体放在 start 帧里
    thinking?: string;
    signature?: string;
    tool_use_id?: string;
    content?: unknown;
    /** start 帧自带的工具入参(桥接端点可能不发 input_json_delta 而整体给) */
    input?: unknown;
    [k: string]: unknown;
  };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    signature?: string;
    partial_json?: string;
    stop_reason?: string;
    /** citation_delta:服务端搜索的来源引用,随文本块一起回传 */
    citation?: unknown;
  };
  usage?: { output_tokens?: number };
  error?: { message?: string };
};

// 内容块聚合状态(按 wire 下标):text / thinking / redacted_thinking /
// tool_use / 服务端工具块。思考明文与签名各有 start 帧与 delta 两个来源,
// 两者都留到收流时再定(见 resolveThinkingText/resolveSignature):
// 桥接端点可能只给其中一路,同时给时以 delta 为准(避免拼接成双倍值)
type OpenBlock =
  | { kind: "text"; text: string; raw: Record<string, unknown>; citations: unknown[] }
  | { kind: "thinking"; startText: string; startSig: string; deltaText: string; deltaSig: string }
  | { kind: "redacted"; data: string }
  | { kind: "tool_use"; id: string; name: string; json: string; startInput?: unknown }
  | { kind: "server_tool_use"; id: string; name: string; json: string; startInput?: unknown }
  | { kind: "server_tool_result"; toolUseId: string; content: unknown };

type ToolBlock = Extract<OpenBlock, { kind: "tool_use" }>;
const isToolBlock = (b: OpenBlock): b is ToolBlock => b.kind === "tool_use";

/** 思考明文:有 delta 用 delta(正常流式),否则取 start 帧整体值(桥接形态) */
const resolveThinkingText = (b: Extract<OpenBlock, { kind: "thinking" }>) =>
  b.deltaText || b.startText;
/** 思考签名:同上。两路都给时 delta 是权威 —— 直接相加会拼出双倍签名 */
const resolveSignature = (b: Extract<OpenBlock, { kind: "thinking" }>) =>
  b.deltaSig || b.startSig;

export class AnthropicMessagesAdapter implements ChatProvider {
  constructor(
    private cfg: {
      apiKey: string;
      model: string;
      /** Anthropic 兼容端点,约定含 /v1;缺省用官方地址 */
      baseUrl?: string;
      /** 单次回复上限;Anthropic 必填 max_tokens,缺省 4096 */
      maxTokens?: number;
      /** 思考程度(undefined/"off" = 不发参数,跟随模型默认;low/medium/high =
       *  固定思考预算,见 THINKING_BUDGETS) */
      reasoningEffort?: string;
      /** 实验开关:注入服务端 web_search 声明,搜索由服务商在服务端执行;
       *  同名本地 web_search 客户端工具从请求剔除(见 SERVER_WEB_SEARCH_TOOL) */
      serverWebSearch?: boolean;
    },
  ) {}

  async chat(req: ChatRequest): Promise<ChatResult> {
    const { maxTokens, budgetTokens } = resolveThinking(
      this.cfg.reasoningEffort,
      this.cfg.maxTokens,
    );
    const body = {
      model: this.cfg.model,
      max_tokens: maxTokens,
      ...(budgetTokens !== undefined
        ? { thinking: { type: "enabled", budget_tokens: budgetTokens } }
        : {}),
      ...toWireSystem(req.messages),
      ...toWireTools(req.tools, this.cfg.serverWebSearch === true),
      stream: true,
    };
    // 回传口径按端点类别一次判定(见 isNativeAnthropicEndpoint):官方端点原样
    // 回传签名思考块与服务端工具块;兼容端点降形状。不做「先送、撞 400、再剥」
    // 的补救 —— 那条路每轮都要重付一次必然失败的请求,且报错文案是「thinking
    // 未回传」,会把归因指向错误的方向(2026-09 修正;硬规则 9 也禁止已开始的流
    // 重放,这里连补救的余地都不留)
    const policy: ReplayPolicy = {
      native: isNativeAnthropicEndpoint(this.cfg.baseUrl),
    };
    // 回传材料形状入日志:只记块类型与签名长度,不记正文(硬规则 12)——
    // 验证端点行为时导出诊断即可看到实际送出去的块
    const shape = assistantEchoShape(req.messages, policy);
    if (shape) {
      log.debug("provider", "assistant wire blocks", {
        blocks: shape,
        endpoint: policy.native ? "native" : "bridge",
      });
    }
    const res = await apiFetch({
      baseUrl: this.cfg.baseUrl ?? DEFAULT_ANTHROPIC_MESSAGES_URL,
      apiKey: this.cfg.apiKey,
      path: "/messages",
      auth: "custom",
      headers: {
        "x-api-key": this.cfg.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: { ...body, messages: toWireMessages(req.messages, policy) },
      signal: req.signal,
    });

    let content = "";
    const blocks = new Map<number, OpenBlock>();
    let stopReason: string | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    for await (const event of readSSE<SSEEvent>(res)) {
      switch (event.type) {
        case "message_start":
          if (typeof event.message?.usage?.input_tokens === "number") {
            inputTokens = event.message.usage.input_tokens;
          }
          break;
        case "content_block_start": {
          const b = event.content_block;
          if (!b?.type) break;
          const idx = event.index ?? 0;
          if (b.type === "text")
            // start 帧原样留底(附加字段如 citations 可能在帧里就给全),
            // 回传时展开它 + 聚合出的正文
            blocks.set(idx, { kind: "text", text: "", raw: { ...b }, citations: [] });
          else if (b.type === "thinking")
            blocks.set(idx, {
              kind: "thinking",
              startText: typeof b.thinking === "string" ? b.thinking : "",
              startSig: typeof b.signature === "string" ? b.signature : "",
              deltaText: "",
              deltaSig: "",
            });
          else if (b.type === "redacted_thinking")
            // 不可解密的加密思考块:data 在 start 帧就给全,没有 delta
            blocks.set(idx, { kind: "redacted", data: b.data ?? "" });
          else if (b.type === "tool_use")
            blocks.set(idx, {
              kind: "tool_use",
              id: b.id ?? "",
              name: b.name ?? "",
              json: "",
              startInput: b.input,
            });
          else if (b.type === "server_tool_use")
            blocks.set(idx, {
              kind: "server_tool_use",
              id: b.id ?? "",
              name: b.name ?? "",
              json: "",
              startInput: b.input,
            });
          else if (b.type === "web_search_tool_result")
            // 结果在 start 帧整体到达(含 encrypted_index 等不可再造字段):
            // 原样捕获,回传时禁止重组
            blocks.set(idx, {
              kind: "server_tool_result",
              toolUseId: b.tool_use_id ?? "",
              content: b.content,
            });
          break;
        }
        case "content_block_delta": {
          const b = blocks.get(event.index ?? 0);
          const d = event.delta;
          if (!b || !d) break;
          if (d.type === "text_delta" && typeof d.text === "string" && b.kind === "text") {
            b.text += d.text;
            req.onDelta(d.text);
          } else if (
            d.type === "citation_delta" &&
            d.citation !== undefined &&
            b.kind === "text"
          ) {
            // 服务端搜索的来源引用:正文外的附加字段,回传时随块一起带上
            b.citations.push(d.citation);
          } else if (
            d.type === "thinking_delta" &&
            typeof d.thinking === "string" &&
            b.kind === "thinking"
          ) {
            b.deltaText += d.thinking;
            req.onReasoningDelta?.(d.thinking);
          } else if (
            d.type === "signature_delta" &&
            typeof d.signature === "string" &&
            b.kind === "thinking"
          ) {
            b.deltaSig += d.signature;
          } else if (
            d.type === "input_json_delta" &&
            typeof d.partial_json === "string" &&
            (b.kind === "tool_use" || b.kind === "server_tool_use")
          ) {
            b.json += d.partial_json;
          }
          break;
        }
        case "message_delta":
          if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
          if (typeof event.usage?.output_tokens === "number") {
            outputTokens = event.usage.output_tokens;
          }
          break;
        case "error":
          // 流中途错误帧:流已开始没有重试余地,但必须把服务端的话抛出去
          throw new Error(
            `LLM stream error: ${event.error?.message ?? JSON.stringify(event.error)}`,
          );
        default:
          break; // message_stop / ping / 未知事件:对聚合无贡献
      }
    }

    // 按 wire 下标还原块顺序:文本拼 content,wire 块保序进 wireBlocks(见下),
    // tool_use 聚合
    const ordered = [...blocks.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, b]) => b);
    for (const b of ordered) {
      if (b.kind === "text") content += b.text;
    }
    const thinkingTexts = ordered
      .filter((b): b is Extract<OpenBlock, { kind: "thinking" }> => b.kind === "thinking")
      .map(resolveThinkingText);
    const hasThinking = thinkingTexts.some((t) => t.length > 0);

    // 回传材料:非 tool_use 块**按 wire 原序**收进 wireBlocks(本地 tool_use 由
    // agent 侧从 toolCalls 重建,不在此列)。顺序必须保真 —— 服务端工具轮里思考
    // 块会在搜索结果之后再次出现,回传形状由 toEchoBlock 按端点类别决定
    // (native 原序原样;bridge 保序降形状,见 ReplayPolicy)。
    // 纯文本轮不产 wireBlocks:正文已由 content 承载,回传侧按 content 重建单个
    // 文本块(零额外存储);有思考/服务端块时才把文本块一并纳入,连 citations
    // 这类附加字段与它的相对位置一起保住。
    const hasOpaque = ordered.some(
      (b) => b.kind !== "text" && b.kind !== "tool_use",
    );
    const wireBlocks: WireBlock[] = [];
    if (hasOpaque) {
      for (const b of ordered) {
        if (b.kind === "thinking") {
          const signature = resolveSignature(b);
          wireBlocks.push({
            type: "thinking",
            thinking: resolveThinkingText(b),
            // 签名缺发(桥接端点无签名机制)时整个省略字段 —— 发空字符串会被
            // 端点判为「thinking 未回传」(2026-09-20 DeepSeek 400 实测);
            // Claude Code 口径:API 发了什么就回传什么,没发就不带
            ...(signature ? { signature } : {}),
          });
        } else if (b.kind === "redacted") {
          wireBlocks.push({ type: "redacted_thinking", data: b.data });
        } else if (b.kind === "server_tool_use") {
          wireBlocks.push({
            type: "server_tool_use",
            id: b.id,
            name: b.name,
            input: toolArgs(b),
          });
        } else if (b.kind === "server_tool_result") {
          wireBlocks.push({
            type: "web_search_tool_result",
            tool_use_id: b.toolUseId,
            content: b.content,
          });
        } else if (b.kind === "text" && b.text) {
          // 空文本块不进 wire:Anthropic 拒收空 text 块(只可能来自「起了 text
          // 块却没有 delta」的畸形流)
          wireBlocks.push(toWireText(b));
        }
      }
    }
    const toolCalls: ToolCall[] = ordered
      .filter(isToolBlock)
      .filter((b) => b.name) // 忽略无 name 空壳
      .map((b) => ({ id: b.id, name: b.name, args: toolArgs(b) }));

    // 验证日志(实验开关的查证面):调用记查询(40 字符,与 web_search 工具
    // 的日志判据一致),结果记条数与前 3 条 URL —— 足以判定「服务端真的搜了」,
    // 不记结果正文
    for (const b of wireBlocks) {
      if (b.type === "server_tool_use") {
        const query = (b.input as { query?: unknown } | null)?.query;
        log.info("provider", "server tool use", {
          name: b.name,
          query: typeof query === "string" ? query.slice(0, 40) : "",
        });
      } else if (b.type === "web_search_tool_result") {
        const results = Array.isArray(b.content) ? b.content : [];
        log.info("provider", "server tool result", {
          toolUseId: b.tool_use_id,
          count: results.length,
          urls: results
            .slice(0, 3)
            .map((r) => (r as { url?: unknown }).url)
            .filter((u): u is string => typeof u === "string"),
        });
      }
    }

    const reasoning_content = hasThinking ? thinkingTexts.join("") : undefined;

    const usage =
      inputTokens === undefined && outputTokens === undefined
        ? undefined
        : {
            promptTokens: inputTokens ?? 0,
            completionTokens: outputTokens ?? 0,
            totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0),
          };

    return {
      content,
      toolCalls,
      ...(reasoning_content !== undefined ? { reasoning_content } : {}),
      ...(wireBlocks.length ? { wireBlocks } : {}),
      finishReason: mapStopReason(stopReason),
      ...(usage ? { usage } : {}),
    };
  }
}

// ---- 内部格式 → Anthropic wire ----

/** system 消息不进 messages 数组,提为顶层 system 参数(多段空行拼接) */
function toWireSystem(msgs: InternalMsg[]): { system?: string } {
  const parts = msgs
    .filter((m) => m.role === "system")
    .map((m) => m.content);
  return parts.length ? { system: parts.join("\n\n") } : {};
}

type WireMessage = { role: "user" | "assistant"; content: unknown };

function toWireMessages(msgs: InternalMsg[], policy: ReplayPolicy): WireMessage[] {
  const out: WireMessage[] = [];
  for (const message of msgs) {
    switch (message.role) {
      case "system":
        break; // 已提为顶层 system(toWireSystem)
      case "user":
        out.push(toWireUserMessage(message));
        break;
      case "assistant": {
        const wire = toWireAssistantMessage(message, policy);
        // 整条空的 assistant 行(空回答、无工具、无思考)不进请求 ——
        // Anthropic 拒收 content 空数组
        if (wire) out.push(wire);
        break;
      }
      case "tool": {
        // Anthropic 语义:tool_result 是 user 消息里的 block,连续 tool 消息
        // 聚成一条 user 消息(恰在 assistant 的 tool_use 轮之后)
        const block = toWireToolResult(message);
        const last = out[out.length - 1];
        if (
          last &&
          last.role === "user" &&
          Array.isArray(last.content) &&
          (last.content[0] as { type?: string } | undefined)?.type === "tool_result"
        ) {
          last.content.push(block);
        } else {
          out.push({ role: "user", content: [block] });
        }
        break;
      }
    }
  }
  return out;
}

/** assistant → content blocks。块序 = wire 原序(native 逐块原样送回);桥接
 *  端点在此先补思考连续性再降形状,见 composeAssistantBlocks。 */
function toWireAssistantMessage(
  message: Extract<InternalMsg, { role: "assistant" }>,
  policy: ReplayPolicy,
): WireMessage | null {
  const blocks = composeAssistantBlocks(message, policy);
  return blocks.length ? { role: "assistant", content: blocks } : null;
}

const isThinkingWireBlock = (b: WireBlock) =>
  b.type === "thinking" || b.type === "redacted_thinking";

/** 组装一条 assistant 消息的请求侧块列表(顺序即 wire 语义,不做按类型分组):
 *  ①桥接端点补「思考连续性」—— DeepSeek 文档:请求带 tools 时,历轮的
 *    reasoning 必须回传(含未调用工具的轮次),缺失即 400。wireBlocks 里没有
 *    思考块的行(最终回答行、旧历史行、别的适配器写的行)用 reasoning_content
 *    合成一条 **unsigned** 思考块,且必须是首块 —— 桥接端点验不了 Anthropic
 *    签名,合成块绝不能带 signature;官方端点不要求历史轮带思考、且拒收无签名
 *    思考块,故只在 bridge 合成。
 *  ②wireBlocks 逐块按端点类别回传(见 toEchoBlock)。
 *  ③正文兜底:wireBlocks 里没有文本块(content 与文本块本应同源,历史行/别的
 *    适配器产的行可能只有 content)时补在工具调用之前 —— 位置未必完美,但不
 *    能把模型说过的话吞掉。
 *  ④tool_use 由 toolCalls 重建,排在最后(Anthropic 的正文在工具调用之前)。 */
function composeAssistantBlocks(
  message: Extract<InternalMsg, { role: "assistant" }>,
  policy: ReplayPolicy,
): Array<Record<string, unknown>> {
  const wire = message.wireBlocks ?? [];
  const blocks: Array<Record<string, unknown>> = [];
  if (!policy.native && !wire.some(isThinkingWireBlock) && message.reasoning_content) {
    blocks.push({ type: "thinking", thinking: message.reasoning_content });
  }
  for (const b of wire) {
    const echoed = toEchoBlock(b, policy);
    if (echoed) blocks.push(echoed);
  }
  if (!wire.some((b) => b.type === "text") && message.content) {
    blocks.push({ type: "text", text: message.content });
  }
  for (const tc of message.toolCalls ?? []) {
    blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args });
  }
  return blocks;
}

/** 单个 wire 块 → 请求侧形态。**两类共同**:thinking 有签名则带、没有则整个
 *  省略该字段(空字符串会被判「thinking 未回传」,2026-09-20 DeepSeek 400 实测;
 *  Claude Code 同款行为);文本块先展开 raw 里的附加字段(citations 等)再覆写
 *  type/text,空文本块丢弃(Anthropic 拒收)。
 *  **native 专属**:签名思考块与服务端工具块原样回传(只有官方能校验/接受)。
 *  **bridge 专属降形状**:
 *  - 服务端工具块:Messages 输入侧没有对应类型,转成文本载体(模型仍知道搜过
 *    什么、拿到哪些来源),原样回传会被判成该轮「缺思考」
 *  - redacted_thinking:桥接端点不接受(DeepSeek 兼容矩阵标 Not Supported),
 *    退化成不可展示的占位文本 */
function toEchoBlock(
  b: WireBlock,
  policy: ReplayPolicy,
): Record<string, unknown> | null {
  switch (b.type) {
    case "thinking":
      return {
        type: "thinking",
        thinking: b.thinking,
        ...(b.signature ? { signature: b.signature } : {}),
      };
    case "redacted_thinking":
      return policy.native
        ? { type: "redacted_thinking", data: b.data }
        : { type: "text", text: REDACTED_THINKING_CARRIER };
    case "server_tool_use":
      return policy.native
        ? { type: "server_tool_use", id: b.id, name: b.name, input: b.input }
        : { type: "text", text: serverToolUseCarrier(b) };
    case "web_search_tool_result":
      return policy.native
        ? {
            type: "web_search_tool_result",
            tool_use_id: b.tool_use_id,
            content: b.content,
          }
        : serverToolResultCarrier(b);
    default:
      return b.text ? { ...(b.raw ?? {}), type: "text", text: b.text } : null;
  }
}

/** 不可解密的思考块在桥接端点上的占位文本(不展示任何原文) */
const REDACTED_THINKING_CARRIER = "[encrypted thinking omitted]";

/** server_tool_use → 文本载体。带上查询词:模型仍知道「自己搜过什么」,
 *  来源明细由结果载体带(桥接端点没有对应的输入块类型,载荷只能以文本表达) */
function serverToolUseCarrier(
  b: Extract<WireBlock, { type: "server_tool_use" }>,
): string {
  const query = (b.input as { query?: unknown } | null)?.query;
  const suffix = typeof query === "string" && query ? `: ${query}` : "";
  return `[server tool: ${b.name}${suffix}]`;
}

/** web_search_tool_result → 文本载体:逐条渲染「url — title」与结果里夹带的
 *  可读 text 片段,保留原顺序;失败结果(error 形态)渲染成一行错误码。没有
 *  任何可用行返回 null —— 不留空文本块(Anthropic 拒收) */
function serverToolResultCarrier(
  b: Extract<WireBlock, { type: "web_search_tool_result" }>,
): Record<string, unknown> | null {
  // 失败形态:content 是单个对象而非结果数组
  if (b.content && !Array.isArray(b.content)) {
    const code = (b.content as { error_code?: unknown }).error_code;
    return {
      type: "text",
      text: `[web search failed${typeof code === "string" ? `: ${code}` : ""}]`,
    };
  }
  const lines: string[] = [];
  for (const part of Array.isArray(b.content) ? b.content : []) {
    if (!part || typeof part !== "object") continue;
    const row = part as { type?: unknown; url?: unknown; title?: unknown; text?: unknown };
    if (row.type === "text") {
      if (typeof row.text === "string" && row.text.trim()) lines.push(row.text);
    } else if (row.type === "web_search_result") {
      if (typeof row.url !== "string" || !row.url.trim()) continue;
      const title = typeof row.title === "string" ? row.title.trim() : "";
      lines.push(title ? `${row.url} — ${title}` : row.url);
    }
  }
  return lines.length ? { type: "text", text: lines.join("\n") } : null;
}

/** 工具入参:优先分片累加出的 JSON(官方流式形态);没有分片时回落 start 帧
 *  自带的 input(桥接端点可能整体给 —— 与思考明文/签名的两路来源同一考量) */
function toolArgs(
  b: ToolBlock | Extract<OpenBlock, { kind: "server_tool_use" }>,
): unknown {
  return b.json ? safeParse(b.json) : (b.startInput ?? {});
}

/** 文本块 → wire 保真形态:start 帧自带的附加字段(去掉已被聚合的 type/text)
 *  与流中累积的 citations 收进 raw */
function toWireText(b: Extract<OpenBlock, { kind: "text" }>): WireTextBlock {
  const raw: Record<string, unknown> = { ...b.raw };
  delete raw.type;
  delete raw.text;
  if (b.citations.length) raw.citations = b.citations;
  return {
    type: "text",
    text: b.text,
    ...(Object.keys(raw).length ? { raw } : {}),
  };
}

function toWireToolResult(message: Extract<InternalMsg, { role: "tool" }>) {
  return {
    type: "tool_result",
    tool_use_id: message.toolCallId,
    content: message.content,
  };
}

/** user 消息 → wire。带图片时 content 变 blocks 数组:文本在前、图片在后,
 *  base64 source 块(官方支持 image/jpeg、png、gif、webp —— 与面板压缩
 *  管线的 WebP/JPEG 产出兼容)。没有 bytes 的图片(没被水合/被预算裁掉)
 *  直接跳过 —— 图片只经 user 消息发,与 chatCompletions 同一管线约束 */
function toWireUserMessage(
  message: Extract<InternalMsg, { role: "user" }>,
): WireMessage {
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
    type: "image",
    source: {
      type: "base64",
      media_type: im.mime,
      data: bytesToBase64(im.bytes!),
    },
  };
}

/** 请求 tools:客户端 schema → wire 扁平形态。服务端搜索开关开时,剔除同名
 *  本地 web_search(同名声明会 400)并把服务端声明追加在末尾 */
function toWireTools(tools: ToolSchema[] | undefined, serverSearch: boolean) {
  const client = (tools ?? []).filter(
    (t) => !(serverSearch && t.name === "web_search"),
  );
  const wire: Array<Record<string, unknown>> = client.map(toWireTool);
  if (serverSearch) wire.push(SERVER_WEB_SEARCH_TOOL);
  return wire.length ? { tools: wire } : {};
}

function toWireTool(tool: ToolSchema) {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  };
}

/** stop_reason → 内部 finishReason:tool_use/max_tokens 语义一一对应,
 *  end_turn/stop_sequence/refusal/未知一律归 stop(与「自然收尾」同义) */
function mapStopReason(reason: string | undefined): ChatResult["finishReason"] {
  if (reason === "tool_use") return "tool_calls";
  if (reason === "max_tokens") return "length";
  return "stop";
}

/** 请求里 assistant 回传块的形状摘要:`thinking(sig=24)|server_tool_use|…`。
 *  按 composeAssistantBlocks 的**实际回传形状**统计(含桥接侧合成的无签名思考
 *  块),仅类型与签名长度、无正文/思考原文(硬规则 12)—— 诊断导出可判「这个
 *  端点收到什么块、什么顺序、思考是原样还是合成」 */
function assistantEchoShape(msgs: InternalMsg[], policy: ReplayPolicy): string {
  const parts: string[] = [];
  for (const m of msgs) {
    if (m.role !== "assistant") continue;
    if (!m.wireBlocks?.length && !m.reasoning_content) continue;
    const wire = m.wireBlocks ?? [];
    // 合成块与「桥接端点本就缺签名」的原生块形状相同,只能从来源判:
    // 没有任何思考块而又合成了,首块就是合成的
    const synthesized =
      !policy.native && !wire.some(isThinkingWireBlock) && !!m.reasoning_content;
    const shape = composeAssistantBlocks(m, policy).map((b, i) =>
      b.type === "thinking"
        ? `thinking(${
            synthesized && i === 0
              ? "synthesized"
              : "signature" in b
                ? `sig=${String(b.signature).length}`
                : "unsigned"
          })`
        : String(b.type),
    );
    if (shape.length) parts.push(shape.join("|"));
  }
  return parts.join(" ; ");
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
