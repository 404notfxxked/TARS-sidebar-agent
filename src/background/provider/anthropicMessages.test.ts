// AnthropicMessagesAdapter 单测:与 chatCompletions.test.ts 对称 ——
// ①请求形态(端点/x-api-key 认证/max_tokens 必填/无 OpenAI 专属字段);
// ②思考程度 → thinking 预算映射与 max_tokens 抬升;③wire 转换(system 提升、
// tool_result 聚合、图片 base64 块)与**端点类别决定的历史回传形状**
// (native 逐块原样 / bridge 降形状 + 合成 unsigned 思考块);④SSE 事件流聚合
// (四类 delta、stop_reason 映射、usage、error 帧)。流式解析层(sse.ts)的
// 脏形态准绳在 chatCompletions.test.ts,此处不重复。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { AnthropicMessagesAdapter, serverToolQuery } from "./anthropicMessages";
import { apiFetch } from "./client";
import { bytesToBase64 } from "../../shared/imageCodec";
import type { ChatRequest, InternalMsg } from "./types";

vi.mock("./client", () => ({ apiFetch: vi.fn() }));

/** 把字符串切块装进一个真 Response(走 ReadableStream,与 wire 一致) */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream);
}

/** 单个 Anthropic SSE 事件帧编码(每个 data 帧都是带 type 的事件) */
const ev = (e: unknown) => `data: ${JSON.stringify(e)}\n\n`;

/** 一轮完整文本回复的事件序列(stop_reason 可替换) */
const textStream = (stopReason = "end_turn") => [
  ev({ type: "message_start", message: { usage: { input_tokens: 100 } } }),
  ev({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
  ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你好" } }),
  ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "!" } }),
  ev({ type: "content_block_stop", index: 0 }),
  ev({ type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 7 } }),
  ev({ type: "message_stop" }),
];

const apiFetchMock = vi.mocked(apiFetch);

function makeReq(overrides: Partial<ChatRequest> = {}) {
  const deltas: string[] = [];
  const reasoningDeltas: string[] = [];
  const req: ChatRequest = {
    messages: [{ role: "user", content: "hi" }],
    onDelta: (t) => deltas.push(t),
    onReasoningDelta: (t) => reasoningDeltas.push(t),
    ...overrides,
  };
  return { req, deltas, reasoningDeltas };
}

const adapter = (
  cfg: Partial<ConstructorParameters<typeof AnthropicMessagesAdapter>[0]> = {},
) =>
  new AnthropicMessagesAdapter({
    apiKey: "sk-ant-test",
    model: "claude-test",
    ...cfg,
  });

beforeEach(() => {
  apiFetchMock.mockReset();
});

/** 以指定 cfg/messages 跑一轮(默认回文本流),返回 wire 侧与结果侧 */
async function runWith(
  cfg: Partial<ConstructorParameters<typeof AnthropicMessagesAdapter>[0]> = {},
  messages?: InternalMsg[],
  events: string[] = textStream(),
) {
  apiFetchMock.mockResolvedValue(sseResponse(events));
  const { req, deltas, reasoningDeltas } = makeReq(messages ? { messages } : {});
  const out = await adapter(cfg).chat(req);
  const opts = apiFetchMock.mock.calls.at(-1)![0];
  return {
    body: opts.body as Record<string, unknown>,
    opts,
    out,
    deltas,
    reasoningDeltas,
  };
}

// ---- 请求形态 ----

describe("请求形态:端点/认证/必填字段", () => {
  it("POST {base}/messages,auth=custom:双认证头(x-api-key + anthropic-version + Bearer)", async () => {
    const { opts } = await runWith();
    expect(opts.path).toBe("/messages");
    expect(opts.auth).toBe("custom");
    expect(opts.headers?.["x-api-key"]).toBe("sk-ant-test");
    expect(opts.headers?.["anthropic-version"]).toBe("2023-06-01");
    // 双头是生态兼容超集:官方认 x-api-key,AUTH_TOKEN 系网关(Baseten 等)只认
    // Bearer;官方 apiKeyHelper 与 new-api 均双认,同发不互斥
    expect(opts.headers?.Authorization).toBe("Bearer sk-ant-test");
  });

  it("baseUrl 缺省官方地址;自定义原样透传", async () => {
    expect((await runWith()).opts.baseUrl).toBe("https://api.anthropic.com/v1"); // i18n-ok:wire 端点常量,与字典占位符同文非 UI 断言
    expect(
      (await runWith({ baseUrl: "https://gate.example.com/v1" })).opts.baseUrl,
    ).toBe("https://gate.example.com/v1");
  });

  it("max_tokens 必填:未配置缺省 4096,配置了用配置值", async () => {
    expect((await runWith()).body.max_tokens).toBe(4096);
    expect((await runWith({ maxTokens: 8192 })).body.max_tokens).toBe(8192);
  });

  it("stream:true;不发 OpenAI 专属字段(stream_options/reasoning_effort/tool 字段形态)", async () => {
    const { body } = await runWith({ reasoningEffort: "medium" });
    expect(body.stream).toBe(true);
    expect(body.stream_options).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.enable_thinking).toBeUndefined();
  });
});

// ---- 思考程度 → thinking 预算 ----

describe("思考程度 → thinking 预算", () => {
  it("low/medium/high 映射固定 budget_tokens;max_tokens 不足时抬到 budget+4096", async () => {
    const low = await runWith({ reasoningEffort: "low" });
    expect(low.body.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
    expect(low.body.max_tokens).toBe(8192); // 4096 + 4096

    const medium = await runWith({ reasoningEffort: "medium" });
    expect(medium.body.thinking).toEqual({ type: "enabled", budget_tokens: 10240 });
    expect(medium.body.max_tokens).toBe(14336);

    const high = await runWith({ reasoningEffort: "high" });
    expect(high.body.thinking).toEqual({ type: "enabled", budget_tokens: 24576 });
    expect(high.body.max_tokens).toBe(28672);
  });

  it("配置的 max_tokens 高于预算要求时保持不动", async () => {
    const { body } = await runWith({ reasoningEffort: "medium", maxTokens: 32_000 });
    expect(body.max_tokens).toBe(32_000);
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 10240 });
  });

  it("off/undefined/未知档位不发 thinking(跟随默认永远安全),max_tokens 不受影响", async () => {
    for (const effort of ["off", undefined, "max", "minimal"] as const) {
      const { body } = await runWith({ reasoningEffort: effort });
      expect(body.thinking).toBeUndefined();
      expect(body.max_tokens).toBe(4096);
    }
  });
});

// ---- wire 转换 ----

describe("wire 转换:内部格式 → anthropic-messages", () => {
  it("system 消息提为顶层 system 参数(多段空行拼接),不进 messages", async () => {
    const { body } = await runWith({}, [
      { role: "system", content: "sys-1" },
      { role: "system", content: "sys-2" },
      { role: "user", content: "hi" },
    ]);
    expect(body.system).toBe("sys-1\n\nsys-2");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("无 system 消息时顶层不带 system 键", async () => {
    const { body } = await runWith({}, [{ role: "user", content: "hi" }]);
    expect(body.system).toBeUndefined();
  });

  it("assistant 工具调用 → tool_use 块;连续 tool 消息聚成单条 user 的 tool_result", async () => {
    const { body } = await runWith({}, [
      { role: "user", content: "查一下" },
      {
        role: "assistant",
        content: null,
        toolCalls: [
          { id: "toolu_1", name: "web_search", args: { query: "tars" } },
          { id: "toolu_2", name: "read_page", args: { url: "https://x" } },
        ],
      },
      { role: "tool", toolCallId: "toolu_1", content: "结果1" },
      { role: "tool", toolCallId: "toolu_2", content: "结果2" },
    ]);
    const msgs = body.messages as Array<Record<string, unknown>>;
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].content).toEqual([
      { type: "tool_use", id: "toolu_1", name: "web_search", input: { query: "tars" } },
      { type: "tool_use", id: "toolu_2", name: "read_page", input: { url: "https://x" } },
    ]);
    // 两条 tool 消息合并在一条 user 消息里(Anthropic 语义)
    expect(msgs[2].role).toBe("user");
    expect(msgs[2].content).toEqual([
      { type: "tool_result", tool_use_id: "toolu_1", content: "结果1" },
      { type: "tool_result", tool_use_id: "toolu_2", content: "结果2" },
    ]);
  });

  it("tool_result 组之后的普通 user 消息独立成条(截图旁路注入形态)", async () => {
    const { body } = await runWith({}, [
      { role: "user", content: "截个图" },
      {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "t1", name: "page_screenshot", args: {} }],
      },
      { role: "tool", toolCallId: "t1", content: "已截图" },
      { role: "user", content: "以上是截图" },
    ]);
    const msgs = body.messages as Array<Record<string, unknown>>;
    expect(msgs[2].content).toEqual([
      { type: "tool_result", tool_use_id: "t1", content: "已截图" },
    ]);
    expect(msgs[3]).toEqual({ role: "user", content: "以上是截图" });
  });

  it("wire 块按原序回传(thinking → redacted → 文本 → tool_use)", async () => {
    const { body } = await runWith({}, [
      { role: "user", content: "查" },
      {
        role: "assistant",
        content: "答案",
        wireBlocks: [
          { type: "thinking", thinking: "想一想", signature: "sig-1" },
          { type: "redacted_thinking", data: "enc-1" },
          { type: "text", text: "答案" },
        ],
        toolCalls: [{ id: "t1", name: "f", args: { a: 1 } }],
      },
      { role: "tool", toolCallId: "t1", content: "obs" },
    ]);
    const msgs = body.messages as Array<Record<string, unknown>>;
    expect(msgs[1].content).toEqual([
      { type: "thinking", thinking: "想一想", signature: "sig-1" },
      { type: "redacted_thinking", data: "enc-1" },
      { type: "text", text: "答案" },
      { type: "tool_use", id: "t1", name: "f", input: { a: 1 } },
    ]);
  });

  it("服务端搜索轮:块序保真(搜索结果之后的思考块不得前移),文本块的 citations 原样带上", async () => {
    // 服务端工具轮的 wire 原序是 thinking → server_tool_use → web_search_tool_result
    // → thinking → text(搜索结果后模型再思考一轮)。默认 baseUrl(官方)走 native
    // 口径:逐块按原序原样回传,块序本身即协议语义
    const results = [
      { type: "web_search_result", url: "https://a", title: "A", encrypted_index: "enc-1" },
    ];
    const { body } = await runWith({}, [
      { role: "user", content: "查" },
      {
        role: "assistant",
        content: "找到一条",
        wireBlocks: [
          { type: "thinking", thinking: "先想", signature: "sig-1" },
          { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "q" } },
          { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: results },
          { type: "thinking", thinking: "看了结果再想", signature: "sig-2" },
          {
            type: "text",
            text: "找到一条",
            raw: { citations: [{ type: "web_search_result_location", url: "https://a" }] },
          },
        ],
        toolCalls: [{ id: "t1", name: "page_read", args: { tabId: 1 } }],
      },
      { role: "tool", toolCallId: "t1", content: "obs" },
    ]);
    const msgs = body.messages as Array<Record<string, unknown>>;
    expect(msgs[1].content).toEqual([
      { type: "thinking", thinking: "先想", signature: "sig-1" },
      { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "q" } },
      { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: results },
      { type: "thinking", thinking: "看了结果再想", signature: "sig-2" },
      {
        type: "text",
        text: "找到一条",
        citations: [{ type: "web_search_result_location", url: "https://a" }],
      },
      { type: "tool_use", id: "t1", name: "page_read", input: { tabId: 1 } },
    ]);
  });

  it("thinking 块无签名(桥接端点缺发 signature)时回传不带 signature 字段", async () => {
    const { body } = await runWith({}, [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "答",
        wireBlocks: [{ type: "thinking", thinking: "想一想" }],
      },
    ]);
    const msgs = body.messages as Array<Record<string, unknown>>;
    // 2026-09-20 DeepSeek 400 实测:发 signature:"" 会被判「thinking 未回传」,
    // 正确口径是整个省略该字段(Claude Code 同款行为)
    expect(msgs[1].content).toEqual([
      { type: "thinking", thinking: "想一想" },
      { type: "text", text: "答" },
    ]);
  });

  it("无 wireBlocks 的行(旧历史行/chat-completions 落的行)按 content 重建单文本块", async () => {
    const { body } = await runWith({}, [
      { role: "user", content: "hi" },
      { role: "assistant", content: "旧答案", toolCalls: [{ id: "t1", name: "f", args: {} }] },
      { role: "tool", toolCallId: "t1", content: "obs" },
    ]);
    const msgs = body.messages as Array<Record<string, unknown>>;
    expect(msgs[1].content).toEqual([
      { type: "text", text: "旧答案" },
      { type: "tool_use", id: "t1", name: "f", input: {} },
    ]);
  });

  it("user 带图 → text + image base64 source 块;未水合(无 bytes)的图片跳过", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const { body } = await runWith({}, [
      {
        role: "user",
        content: "看图",
        images: [
          { id: "i1", mime: "image/webp", w: 10, h: 10, bytes },
          { id: "i2", mime: "image/jpeg", w: 10, h: 10 }, // 被预算裁掉/未水合
        ],
      },
    ]);
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "看图" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/webp",
              data: bytesToBase64(bytes),
            },
          },
        ],
      },
    ]);
  });

  it("工具 schema → name/description/input_schema 扁平形态", async () => {
    apiFetchMock.mockResolvedValue(sseResponse(textStream()));
    const { req } = makeReq({
      tools: [
        {
          type: "function",
          name: "web_search",
          description: "搜索",
          parameters: { type: "object", properties: {} },
        },
      ],
    });
    await adapter().chat(req);
    const body = apiFetchMock.mock.calls.at(-1)![0].body as Record<string, unknown>;
    expect(body.tools).toEqual([
      {
        name: "web_search",
        description: "搜索",
        input_schema: { type: "object", properties: {} },
      },
    ]);
  });
});

// ---- 流式聚合 ----

describe("SSE 事件流聚合", () => {
  it("text_delta 聚合为 content 逐块回调;usage 从 message_start/message_delta 拼全", async () => {
    const { out, deltas } = await runWith();
    expect(deltas).toEqual(["你好", "!"]);
    expect(out.content).toBe("你好!");
    expect(out.finishReason).toBe("stop");
    expect(out.usage).toEqual({
      promptTokens: 100,
      completionTokens: 7,
      totalTokens: 107,
    });
  });

  it("thinking_delta 聚合 reasoning_content 逐块回调;签名随 wireBlocks 产出", async () => {
    const { out, reasoningDeltas } = await runWith({}, undefined, [
      ev({ type: "message_start", message: { usage: { input_tokens: 5 } } }),
      ev({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
      ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "想一想" } }),
      ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "再想想" } }),
      ev({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-9" } }),
      ev({ type: "content_block_stop", index: 0 }),
      ev({ type: "content_block_start", index: 1, content_block: { type: "text" } }),
      ev({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "答案" } }),
      ev({ type: "content_block_stop", index: 1 }),
      ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }),
      ev({ type: "message_stop" }),
    ]);
    expect(reasoningDeltas).toEqual(["想一想", "再想想"]);
    expect(out.reasoning_content).toBe("想一想再想想");
    expect(out.wireBlocks).toEqual([
      { type: "thinking", thinking: "想一想再想想", signature: "sig-9" },
      { type: "text", text: "答案" },
    ]);
    expect(out.content).toBe("答案");
  });

  it("纯文本回复不产出思考字段(区分「没收到」和「收到为空」)", async () => {
    const { out } = await runWith();
    expect(out.reasoning_content).toBeUndefined();
    expect(out.wireBlocks).toBeUndefined(); // 纯文本轮不产 wireBlocks(正文走 content)
  });

  it("redacted_thinking 原样进 wireBlocks,不产 reasoning_content(不可展示)", async () => {
    const { out } = await runWith({}, undefined, [
      ev({ type: "message_start", message: { usage: { input_tokens: 5 } } }),
      ev({ type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "enc-xyz" } }),
      ev({ type: "content_block_stop", index: 0 }),
      ev({ type: "content_block_start", index: 1, content_block: { type: "text" } }),
      ev({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "答" } }),
      ev({ type: "content_block_stop", index: 1 }),
      ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
      ev({ type: "message_stop" }),
    ]);
    expect(out.wireBlocks).toEqual([
      { type: "redacted_thinking", data: "enc-xyz" },
      { type: "text", text: "答" },
    ]);
    expect(out.reasoning_content).toBeUndefined();
    expect(out.content).toBe("答");
  });

  it("签名在 start 帧自带(桥接端点不发 signature_delta 的形态)也能捕获", async () => {
    const { out } = await runWith({}, undefined, [
      ev({ type: "message_start", message: { usage: { input_tokens: 1 } } }),
      ev({ type: "content_block_start", index: 0, content_block: { type: "thinking", signature: "sig-start" } }),
      ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "想一想" } }),
      ev({ type: "content_block_stop", index: 0 }),
      ev({ type: "content_block_start", index: 1, content_block: { type: "text" } }),
      ev({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "答" } }),
      ev({ type: "content_block_stop", index: 1 }),
      ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
      ev({ type: "message_stop" }),
    ]);
    expect(out.wireBlocks).toEqual([
      { type: "thinking", thinking: "想一想", signature: "sig-start" },
      { type: "text", text: "答" },
    ]);
  });

  it("start 帧与 signature_delta 都给签名时以 delta 为准,不拼成双倍", async () => {
    const { out } = await runWith({}, undefined, [
      ev({ type: "message_start", message: { usage: { input_tokens: 1 } } }),
      ev({ type: "content_block_start", index: 0, content_block: { type: "thinking", signature: "sig" } }),
      ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "想" } }),
      ev({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } }),
      ev({ type: "content_block_stop", index: 0 }),
      ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
      ev({ type: "message_stop" }),
    ]);
    expect(out.wireBlocks).toEqual([
      { type: "thinking", thinking: "想", signature: "sig" },
    ]);
  });

  it("思考明文整体在 start 帧(无 thinking_delta)也进 reasoning_content 与 wireBlocks", async () => {
    const { out, reasoningDeltas } = await runWith({}, undefined, [
      ev({ type: "message_start", message: { usage: { input_tokens: 1 } } }),
      ev({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "整段思考", signature: "sig-1" } }),
      ev({ type: "content_block_stop", index: 0 }),
      ev({ type: "content_block_start", index: 1, content_block: { type: "text" } }),
      ev({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "答" } }),
      ev({ type: "content_block_stop", index: 1 }),
      ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
      ev({ type: "message_stop" }),
    ]);
    expect(reasoningDeltas).toEqual([]); // 无 delta 可回调,但正文不丢
    expect(out.reasoning_content).toBe("整段思考");
    expect(out.wireBlocks).toEqual([
      { type: "thinking", thinking: "整段思考", signature: "sig-1" },
      { type: "text", text: "答" },
    ]);
  });

  it("citation_delta 累积进文本块 raw.citations,回传时原样展开", async () => {
    const cite = { type: "web_search_result_location", url: "https://a", title: "A" };
    const { out } = await runWith({}, undefined, [
      ev({ type: "message_start", message: { usage: { input_tokens: 1 } } }),
      ev({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
      ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "答案" } }),
      ev({ type: "content_block_delta", index: 0, delta: { type: "citation_delta", citation: cite } }),
      ev({ type: "content_block_stop", index: 0 }),
      ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
      ev({ type: "message_stop" }),
    ]);
    // 纯文本轮不产 wireBlocks;引用经 wireBlocks 走的是「有思考/服务端块」的轮次
    expect(out.wireBlocks).toBeUndefined();
    const { body } = await runWith({}, [
      { role: "user", content: "查" },
      {
        role: "assistant",
        content: out.content,
        wireBlocks: [
          { type: "thinking", thinking: "想", signature: "sig-1" },
          { type: "text", text: out.content, raw: { citations: [cite] } },
        ],
      },
    ]);
    const msgs = body.messages as Array<Record<string, unknown>>;
    expect(msgs[1].content).toEqual([
      { type: "thinking", thinking: "想", signature: "sig-1" },
      { type: "text", text: "答案", citations: [cite] },
    ]);
  });

  it("tool_use:input_json_delta 分片拼接还原 args;index 交错互不串线", async () => {
    const { out } = await runWith({}, undefined, [
      ev({ type: "message_start", message: { usage: { input_tokens: 9 } } }),
      ev({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
      ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "我来查" } }),
      ev({ type: "content_block_stop", index: 0 }),
      ev({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t-a", name: "web_search" } }),
      ev({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"que' } }),
      ev({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "t-b", name: "read_page" } }),
      ev({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'ry":"t"}' } }),
      ev({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"url":"x"}' } }),
      ev({ type: "content_block_stop", index: 1 }),
      ev({ type: "content_block_stop", index: 2 }),
      ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } }),
      ev({ type: "message_stop" }),
    ]);
    expect(out.content).toBe("我来查");
    expect(out.finishReason).toBe("tool_calls");
    expect(out.toolCalls).toEqual([
      { id: "t-a", name: "web_search", args: { query: "t" } },
      { id: "t-b", name: "read_page", args: { url: "x" } },
    ]);
  });

  it("tool_use 坏 JSON 分片:safeParse 兜底空对象,不炸流", async () => {
    const { out } = await runWith({}, undefined, [
      ev({ type: "message_start", message: { usage: { input_tokens: 1 } } }),
      ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "f" } }),
      ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{broken" } }),
      ev({ type: "content_block_stop", index: 0 }),
      ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } }),
      ev({ type: "message_stop" }),
    ]);
    expect(out.toolCalls).toEqual([{ id: "t1", name: "f", args: {} }]);
  });

  it.each([
    ["end_turn", "stop"],
    ["stop_sequence", "stop"],
    ["refusal", "stop"],
    ["pause_turn", "stop"],
    ["tool_use", "tool_calls"],
    ["max_tokens", "length"],
  ])("stop_reason %s → %s", async (wire, internal) => {
    const { out } = await runWith({}, undefined, textStream(wire));
    expect(out.finishReason).toBe(internal);
  });

  it("error 事件抛 LLM stream error,不静默吞成空回答", async () => {
    await expect(
      runWith({}, undefined, [
        ev({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
      ]),
    ).rejects.toThrow(/LLM stream error: Overloaded/);
  });

  it("ping 与未知事件对聚合无贡献(对齐 readSSE 心跳形态)", async () => {
    const { out } = await runWith({}, undefined, [
      ev({ type: "ping" }),
      ev({ type: "message_start", message: { usage: { input_tokens: 1 } } }),
      ev({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
      ev({ type: "ping" }),
      ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "好" } }),
      ev({ type: "content_block_stop", index: 0 }),
      ev({ type: "some_future_event", payload: { x: 1 } }),
      ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
      ev({ type: "message_stop" }),
    ]);
    expect(out.content).toBe("好");
    expect(out.finishReason).toBe("stop");
  });

  it("usage 缺帧不产出 usage 字段(与 chatCompletions 同口径)", async () => {
    const { out } = await runWith({}, undefined, [
      ev({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
      ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "好" } }),
      ev({ type: "content_block_stop", index: 0 }),
      ev({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
      ev({ type: "message_stop" }),
    ]);
    expect(out.usage).toBeUndefined();
  });
});

// ---- 未知内容块(响应方言守卫) ----
// 官方在持续新增服务端结果块类型(web_fetch_tool_result / code_execution_tool_result
// / mcp_tool_result…),桥接端点也可能塞自家工具块:没有解析路径的块不能静默丢。

describe("未知内容块(方言守卫)", () => {
  it("未知块 + 无正文无工具:抛点名的可行动错误,不落成空回答", async () => {
    await expect(
      runWith({}, undefined, [
        ev({ type: "message_start", message: { usage: { input_tokens: 5 } } }),
        ev({
          type: "content_block_start",
          index: 0,
          content_block: { type: "web_fetch_tool_result", tool_use_id: "t1", content: [] },
        }),
        ev({ type: "content_block_stop", index: 0 }),
        ev({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
        ev({ type: "message_stop" }),
      ]),
    ).rejects.toThrow(/web_fetch_tool_result/);
  });

  it("未知块与正常文本共存:正文照常返回,未知块里夹带的 delta 不当正文", async () => {
    const { out } = await runWith({}, undefined, [
      ev({ type: "message_start", message: { usage: { input_tokens: 5 } } }),
      ev({
        type: "content_block_start",
        index: 0,
        content_block: { type: "code_execution_tool_result", tool_use_id: "t1", content: [] },
      }),
      // 未知块里的 text_delta:没有解析路径只能丢 —— 但不许被当成正文
      ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "不该出现" } }),
      ev({ type: "content_block_stop", index: 0 }),
      ev({ type: "content_block_start", index: 1, content_block: { type: "text" } }),
      ev({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "正常回答" } }),
      ev({ type: "content_block_stop", index: 1 }),
      ev({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
      ev({ type: "message_stop" }),
    ]);
    expect(out.content).toBe("正常回答");
  });
});

// ---- 服务端搜索(serverWebSearch 适配器开关) ----
// 注入由适配器选项控制(配置侧已无独立开关:联网总开关开 = 该协议走服务端搜索,
// 见 agent/runSetup);服务端块的聚合与回传是响应侧兼容性,始终启用。

describe("服务端工具查询词提取(方言字段)", () => {
  it("serverToolQuery:query 优先,缺省回退智谱方言 search_query,两者皆缺为 undefined", () => {
    expect(serverToolQuery({ query: "a", search_query: "b" })).toBe("a");
    expect(serverToolQuery({ search_query: "智谱查询词" })).toBe("智谱查询词");
    expect(serverToolQuery({})).toBeUndefined();
    expect(serverToolQuery(null)).toBeUndefined();
  });
});

describe("服务端搜索注入", () => {
  /** 以指定 req 覆盖 + cfg 跑一轮文本流,返回发给 apiFetch 的 body */
  async function bodyOf(
    reqOverrides: Partial<ChatRequest>,
    cfg: Partial<ConstructorParameters<typeof AnthropicMessagesAdapter>[0]> = {},
  ) {
    apiFetchMock.mockResolvedValue(sseResponse(textStream()));
    const { req } = makeReq(reqOverrides);
    await adapter(cfg).chat(req);
    return apiFetchMock.mock.calls.at(-1)![0].body as Record<string, unknown>;
  }

  it("开关关(缺省):客户端工具原样发,请求无 web_search_20250305 声明", async () => {
    const body = await bodyOf({
      tools: [{ type: "function", name: "web_fetch", description: "d", parameters: { type: "object", properties: {} } }],
    });
    expect(body.tools).toEqual([
      { name: "web_fetch", description: "d", input_schema: { type: "object", properties: {} } },
    ]);
  });

  it("开关开:同名本地 web_search 被剔除,其余工具保留,服务端声明追加在末尾", async () => {
    const body = await bodyOf(
      {
        tools: [
          { type: "function", name: "web_search", description: "本地版", parameters: { type: "object", properties: {} } },
          { type: "function", name: "web_fetch", description: "d", parameters: { type: "object", properties: {} } },
        ],
      },
      { serverWebSearch: true },
    );
    expect(body.tools).toEqual([
      { name: "web_fetch", description: "d", input_schema: { type: "object", properties: {} } },
      { type: "web_search_20250305", name: "web_search", max_uses: 3 },
    ]);
  });

  it("开关开 + 无客户端工具:tools 仅服务端声明;开关关 + 无工具则不带 tools", async () => {
    const on = await bodyOf({}, { serverWebSearch: true });
    expect(on.tools).toEqual([
      { type: "web_search_20250305", name: "web_search", max_uses: 3 },
    ]);
    const off = await bodyOf({});
    expect(off.tools).toBeUndefined();
  });

  it("服务端块聚合:server_tool_use 分片 JSON + 结果块整体捕获,按 wire 顺序产出", async () => {
    const content = [
      { type: "web_search_result", url: "https://a.example/x", title: "A", encrypted_index: "enc-1" },
      { type: "web_search_result", url: "https://b.example/y", title: "B", encrypted_index: "enc-2" },
    ];
    const { out } = await runWith({}, undefined, [
      ev({ type: "message_start", message: { usage: { input_tokens: 12 } } }),
      ev({ type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search" } }),
      ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"que' } }),
      ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'ry":"ai news"}' } }),
      ev({ type: "content_block_stop", index: 0 }),
      ev({ type: "content_block_start", index: 1, content_block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content } }),
      ev({ type: "content_block_stop", index: 1 }),
      ev({ type: "content_block_start", index: 2, content_block: { type: "text" } }),
      ev({ type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "找到两条" } }),
      ev({ type: "content_block_stop", index: 2 }),
      ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } }),
      ev({ type: "message_stop" }),
    ]);
    // 客户端工具三件套全程无感知:不是 toolCalls、不进 content、无思考字段
    expect(out.content).toBe("找到两条");
    expect(out.toolCalls).toEqual([]);
    expect(out.reasoning_content).toBeUndefined();
    // 有服务端块 → 文本块也进 wireBlocks(保 citations 与相对位置)
    expect(out.wireBlocks).toEqual([
      { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "ai news" } },
      { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content },
      { type: "text", text: "找到两条" },
    ]);
  });

  it("回传保真:服务端搜索轮的响应原样进 wireBlocks → 下一轮请求逐块还原(含搜索结果后的第二次思考)", async () => {
    const content = [
      { type: "web_search_result", url: "https://a.example/x", title: "A", encrypted_index: "enc-1" },
    ];
    // 混合轮的 wire 原序:先想 → 服务端搜索 → 结果 → 看了结果再想 → 文本 → 本地工具
    const wireTurn = [
      ev({ type: "message_start", message: { usage: { input_tokens: 12 } } }),
      ev({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
      ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "先搜一下" } }),
      ev({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-1" } }),
      ev({ type: "content_block_stop", index: 0 }),
      ev({ type: "content_block_start", index: 1, content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search" } }),
      ev({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"query":"ai news"}' } }),
      ev({ type: "content_block_stop", index: 1 }),
      ev({ type: "content_block_start", index: 2, content_block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content } }),
      ev({ type: "content_block_stop", index: 2 }),
      ev({ type: "content_block_start", index: 3, content_block: { type: "thinking" } }),
      ev({ type: "content_block_delta", index: 3, delta: { type: "thinking_delta", thinking: "看了结果,再看用量页" } }),
      ev({ type: "content_block_delta", index: 3, delta: { type: "signature_delta", signature: "sig-2" } }),
      ev({ type: "content_block_stop", index: 3 }),
      ev({ type: "content_block_start", index: 4, content_block: { type: "text" } }),
      ev({ type: "content_block_delta", index: 4, delta: { type: "text_delta", text: "找到一条" } }),
      ev({ type: "content_block_stop", index: 4 }),
      ev({ type: "content_block_start", index: 5, content_block: { type: "tool_use", id: "t1", name: "page_read" } }),
      ev({ type: "content_block_delta", index: 5, delta: { type: "input_json_delta", partial_json: '{"tabId":1}' } }),
      ev({ type: "content_block_stop", index: 5 }),
      ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } }),
      ev({ type: "message_stop" }),
    ];
    const first = await runWith({}, undefined, wireTurn);
    expect(first.out.reasoning_content).toBe("先搜一下看了结果,再看用量页");
    expect(first.out.toolCalls).toEqual([{ id: "t1", name: "page_read", args: { tabId: 1 } }]);

    const { body } = await runWith({}, [
      { role: "user", content: "查" },
      {
        role: "assistant",
        content: first.out.content,
        wireBlocks: first.out.wireBlocks,
        toolCalls: first.out.toolCalls,
      },
      { role: "tool", toolCallId: "t1", content: "obs" },
    ]);
    const msgs = body.messages as Array<Record<string, unknown>>;
    // 逐块、逐序还原 wire 原序:第二次思考必须在搜索结果之后,不得前移
    expect(msgs[1].content).toEqual([
      { type: "thinking", thinking: "先搜一下", signature: "sig-1" },
      { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "ai news" } },
      { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content },
      { type: "thinking", thinking: "看了结果,再看用量页", signature: "sig-2" },
      { type: "text", text: "找到一条" },
      { type: "tool_use", id: "t1", name: "page_read", input: { tabId: 1 } },
    ]);
  });
});

// ---- 端点类别决定历史回传形状(2026-09 根因修复) ----
// 兼容端点(DeepSeek /anthropic 等)的 Messages 输入侧没有服务端工具块类型,
// 且要求「请求带 tools 时历轮 reasoning 必须回传」—— 服务端块原样送回会被
// 判成该轮缺思考,得到 `content[].thinking must be passed back` 的 400。
// 适配器按 baseUrl 主机名分派:native(api.anthropic.com)逐块原样;bridge
// 降形状 + 用 reasoning_content 合成 unsigned 思考块。不做「撞 400 再剥」的
// 补救,所以 400 直接上抛。

describe("端点类别决定历史回传形状", () => {
  const BRIDGE = "https://api.deepseek.com/anthropic/v1";

  /** 混合轮消息:思考 + 服务端搜索 + 文本 + 本地工具调用(wire 原序) */
  const mixedTurn: InternalMsg[] = [
    { role: "user", content: "查" },
    {
      role: "assistant",
      content: "找到一条",
      wireBlocks: [
        { type: "thinking", thinking: "先搜", signature: "sig-1" },
        { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "q" } },
        {
          type: "web_search_tool_result",
          tool_use_id: "srvtoolu_1",
          content: [{ type: "web_search_result", url: "https://a" }],
        },
        { type: "text", text: "找到一条" },
      ],
      toolCalls: [{ id: "t1", name: "page_read", args: { tabId: 1 } }],
    },
    { role: "tool", toolCallId: "t1", content: "obs" },
  ];

  it("bridge:服务端工具块降为文本载体(查询词 + 来源 url),块序不变", async () => {
    const { body } = await runWith({ baseUrl: BRIDGE }, mixedTurn);
    const msgs = body.messages as Array<Record<string, unknown>>;
    expect(msgs[1].content).toEqual([
      { type: "thinking", thinking: "先搜", signature: "sig-1" },
      { type: "text", text: "[server tool: web_search: q]" },
      { type: "text", text: "https://a" },
      { type: "text", text: "找到一条" },
      { type: "tool_use", id: "t1", name: "page_read", input: { tabId: 1 } },
    ]);
  });

  it("bridge:search_query 方言(智谱 web_search_prime)的查询词同样进回传载体", async () => {
    const { body } = await runWith({ baseUrl: BRIDGE }, [
      { role: "user", content: "查" },
      {
        role: "assistant",
        content: "找到一条",
        wireBlocks: [
          {
            type: "server_tool_use",
            id: "srvtoolu_1",
            name: "web_search",
            input: { search_query: "智谱查询词" },
          },
          { type: "text", text: "找到一条" },
        ],
      },
    ]);
    expect((body.messages as Array<Record<string, unknown>>)[1].content).toEqual([
      { type: "text", text: "[server tool: web_search: 智谱查询词]" },
      { type: "text", text: "找到一条" },
    ]);
  });

  it("bridge:结果行带 title、夹带的 text 片段保留原序;无可用行不留空文本块", async () => {
    const withTitle = await runWith({ baseUrl: BRIDGE }, [
      { role: "user", content: "查" },
      {
        role: "assistant",
        content: "答",
        wireBlocks: [
          {
            type: "web_search_tool_result",
            tool_use_id: "s1",
            content: [
              { type: "web_search_result", url: "https://a", title: "A" },
              { type: "text", text: "片段" },
              { type: "web_search_result", url: "  " },
            ],
          },
          { type: "text", text: "答" },
        ],
      },
    ]);
    expect((withTitle.body.messages as Array<Record<string, unknown>>)[1].content).toEqual([
      { type: "text", text: "https://a — A\n片段" },
      { type: "text", text: "答" },
    ]);

    const empty = await runWith({ baseUrl: BRIDGE }, [
      { role: "user", content: "查" },
      {
        role: "assistant",
        content: "答",
        wireBlocks: [
          { type: "web_search_tool_result", tool_use_id: "s1", content: [] },
          { type: "text", text: "答" },
        ],
      },
    ]);
    expect((empty.body.messages as Array<Record<string, unknown>>)[1].content).toEqual([
      { type: "text", text: "答" },
    ]);
  });

  it("bridge:失败结果渲染为一行错误码", async () => {
    const { body } = await runWith({ baseUrl: BRIDGE }, [
      { role: "user", content: "查" },
      {
        role: "assistant",
        content: null,
        wireBlocks: [
          {
            type: "web_search_tool_result",
            tool_use_id: "s1",
            content: { type: "web_search_tool_result_error", error_code: "too_many_requests" },
          },
        ],
        toolCalls: [{ id: "t1", name: "f", args: {} }],
      },
    ]);
    expect((body.messages as Array<Record<string, unknown>>)[1].content).toEqual([
      { type: "text", text: "[web search failed: too_many_requests]" },
      { type: "tool_use", id: "t1", name: "f", input: {} },
    ]);
  });

  it("bridge:redacted_thinking 降为占位文本;native 原样回传", async () => {
    const row: InternalMsg[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "答",
        wireBlocks: [
          { type: "redacted_thinking", data: "enc-1" },
          { type: "text", text: "答" },
        ],
      },
    ];
    const bridge = await runWith({ baseUrl: BRIDGE }, row);
    expect((bridge.body.messages as Array<Record<string, unknown>>)[1].content).toEqual([
      { type: "text", text: "[encrypted thinking omitted]" },
      { type: "text", text: "答" },
    ]);
    const native = await runWith({}, row);
    expect((native.body.messages as Array<Record<string, unknown>>)[1].content).toEqual([
      { type: "redacted_thinking", data: "enc-1" },
      { type: "text", text: "答" },
    ]);
  });

  it("bridge:wireBlocks 无思考块时用 reasoning_content 合成 unsigned 思考块,置于首块", async () => {
    // 最终回答行(agent 不附 wireBlocks)与跨 run 的旧历史行都走这条路;
    // 缺它就会命中「content[].thinking must be passed back」的 400
    const { body } = await runWith({ baseUrl: BRIDGE }, [
      { role: "user", content: "问" },
      { role: "assistant", content: "答", reasoning_content: "想过" },
    ]);
    const content = (body.messages as Array<Record<string, unknown>>)[1]
      .content as Array<Record<string, unknown>>;
    expect(content).toEqual([
      { type: "thinking", thinking: "想过" },
      { type: "text", text: "答" },
    ]);
    // 合成块绝不能带 signature:桥接端点验不了 Anthropic 签名
    expect(content[0]).not.toHaveProperty("signature");
  });

  it("已有思考块时不重复合成;native 一律不合成(官方拒收无签名思考块)", async () => {
    const withWire: InternalMsg[] = [
      { role: "user", content: "问" },
      {
        role: "assistant",
        content: "答",
        reasoning_content: "想过",
        wireBlocks: [{ type: "thinking", thinking: "想过" }],
      },
    ];
    for (const cfg of [{ baseUrl: BRIDGE }, {}]) {
      const { body } = await runWith(cfg, withWire);
      expect((body.messages as Array<Record<string, unknown>>)[1].content).toEqual([
        { type: "thinking", thinking: "想过" },
        { type: "text", text: "答" },
      ]);
    }
    const nativeNoWire = await runWith({}, [
      { role: "user", content: "问" },
      { role: "assistant", content: "答", reasoning_content: "想过" },
    ]);
    expect((nativeNoWire.body.messages as Array<Record<string, unknown>>)[1].content).toEqual([
      { type: "text", text: "答" },
    ]);
  });

  it("400 直接上抛,不做剥块重发(不再依赖报错文案补救)", async () => {
    const REJECT =
      'HTTP 400 — {"error":{"message":"The `content[].thinking` in the thinking mode must be passed back to the API.","type":"invalid_request_error"}}';
    apiFetchMock.mockRejectedValueOnce(new Error(REJECT));
    const { req } = makeReq({ messages: mixedTurn });
    await expect(adapter({ baseUrl: BRIDGE }).chat(req)).rejects.toThrow(
      /must be passed back/,
    );
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it("端点类别判定:官方域名(含子域)走 native;其余与解析不出的裸域名按 bridge 保守处理", async () => {
    const typesOf = async (baseUrl?: string) =>
      (
        ((await runWith({ baseUrl }, mixedTurn)).body.messages as Array<
          Record<string, unknown>
        >)[1].content as Array<{ type: string }>
      ).map((b) => b.type);
    for (const native of [
      "https://api.anthropic.com/v1", // i18n-ok:wire 端点常量,非 UI 断言
      "https://gateway.anthropic.com/v1",
    ]) {
      expect(await typesOf(native)).toContain("server_tool_use");
    }
    for (const bridge of [
      "https://api.deepseek.com/anthropic/v1",
      "https://relay.example.com/v1",
      "api.anthropic.com/v1", // 裸域名解析不出一致主机名 → 保守按 bridge
    ]) {
      expect(await typesOf(bridge)).not.toContain("server_tool_use");
    }
  });
});

// ---- 空块与桥接入参形态 ----

describe("空块与桥接形态", () => {
  it("历史里的空文本块不进请求(Anthropic 拒收空 text 块)", async () => {
    const { body } = await runWith({}, [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "答",
        wireBlocks: [
          { type: "thinking", thinking: "想" },
          { type: "text", text: "" },
        ],
      },
    ]);
    expect((body.messages as Array<Record<string, unknown>>)[1].content).toEqual([
      { type: "thinking", thinking: "想" },
    ]);
  });

  it("整条空的 assistant 行不进请求(Anthropic 拒收空 content 数组)", async () => {
    const { body } = await runWith({}, [
      { role: "user", content: "hi" },
      { role: "assistant", content: "" },
    ]);
    expect((body.messages as unknown[]).length).toBe(1);
  });

  it("响应侧空 text 块(起了块却没有 delta)不落进 wireBlocks", async () => {
    const { out } = await runWith({}, undefined, [
      ev({ type: "message_start", message: { usage: { input_tokens: 1 } } }),
      ev({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
      ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "想" } }),
      ev({ type: "content_block_stop", index: 0 }),
      ev({ type: "content_block_start", index: 1, content_block: { type: "text" } }),
      ev({ type: "content_block_stop", index: 1 }),
      ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
      ev({ type: "message_stop" }),
    ]);
    expect(out.wireBlocks).toEqual([{ type: "thinking", thinking: "想" }]);
  });

  it("工具入参整体给在 start 帧(无 input_json_delta)也能还原 args", async () => {
    const { out } = await runWith({}, undefined, [
      ev({ type: "message_start", message: { usage: { input_tokens: 1 } } }),
      ev({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "t1", name: "f", input: { tabId: 7 } },
      }),
      ev({ type: "content_block_stop", index: 0 }),
      ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } }),
      ev({ type: "message_stop" }),
    ]);
    expect(out.toolCalls).toEqual([{ id: "t1", name: "f", args: { tabId: 7 } }]);
  });

  it("server_tool_use 入参同理:start 帧整体给时进 wireBlocks.input", async () => {
    const { out } = await runWith({}, undefined, [
      ev({ type: "message_start", message: { usage: { input_tokens: 1 } } }),
      ev({
        type: "content_block_start",
        index: 0,
        content_block: { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "q" } },
      }),
      ev({ type: "content_block_stop", index: 0 }),
      ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
      ev({ type: "message_stop" }),
    ]);
    expect(out.wireBlocks).toEqual([
      { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "q" } },
    ]);
  });
});
