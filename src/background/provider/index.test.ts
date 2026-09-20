// createChatProvider 分派单测:按供应商协议字段选适配器;缺省(旧配置无
// kind)一律 chat-completions,历史配置零迁移;responses 仅预留枚举,显式报错。
// 末组用例经真适配器验证 serverWebSearch 从工厂到 wire 的透传。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createChatProvider } from "./index";
import { ChatCompletionsAdapter } from "./chatCompletions";
import { AnthropicMessagesAdapter } from "./anthropicMessages";
import { apiFetch } from "./client";

vi.mock("./client", () => ({ apiFetch: vi.fn() }));

const apiFetchMock = vi.mocked(apiFetch);

describe("createChatProvider 按协议分派", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it("undefined / chat-completions → ChatCompletionsAdapter(缺省兜底)", () => {
    expect(createChatProvider({ apiKey: "k", model: "m" })).toBeInstanceOf(
      ChatCompletionsAdapter,
    );
    expect(
      createChatProvider({ kind: "chat-completions", apiKey: "k", model: "m" }),
    ).toBeInstanceOf(ChatCompletionsAdapter);
  });

  it("anthropic-messages → AnthropicMessagesAdapter", () => {
    expect(
      createChatProvider({
        kind: "anthropic-messages",
        apiKey: "k",
        model: "claude-x",
      }),
    ).toBeInstanceOf(AnthropicMessagesAdapter);
  });

  it("responses 仅预留枚举:显式报错占位,不静默走 chat-completions", () => {
    expect(() =>
      createChatProvider({ kind: "responses", apiKey: "k", model: "gpt-x" }),
    ).toThrow(/Responses/);
  });

  it("serverWebSearch 经工厂透传:anthropic 请求带服务端声明,chat-completions 不带", async () => {
    const encoder = new TextEncoder();
    const sse = (frame: unknown) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
            c.close();
          },
        }),
      );

    apiFetchMock.mockResolvedValueOnce(
      sse({
        type: "message_start",
        message: { usage: { input_tokens: 1 } },
      }),
    );
    const anthropic = createChatProvider({
      kind: "anthropic-messages",
      apiKey: "k",
      model: "claude-x",
      serverWebSearch: true,
    });
    await anthropic.chat({
      messages: [{ role: "user", content: "hi" }],
      onDelta: () => {},
    });
    const anthropicBody = apiFetchMock.mock.calls.at(-1)![0]
      .body as Record<string, unknown>;
    expect(anthropicBody.tools).toEqual([
      { type: "web_search_20250305", name: "web_search", max_uses: 3 },
    ]);

    // chat-completions 适配器不消费 serverWebSearch:请求保持 OpenAI 形态
    apiFetchMock.mockResolvedValueOnce(
      sse({
        choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
      }),
    );
    const cc = createChatProvider({
      kind: "chat-completions",
      apiKey: "k",
      model: "m",
      serverWebSearch: true,
    });
    await cc.chat({
      messages: [{ role: "user", content: "hi" }],
      onDelta: () => {},
    });
    const ccBody = apiFetchMock.mock.calls.at(-1)![0].body as Record<string, unknown>;
    expect(ccBody.tools).toBeUndefined();
    expect(ccBody).toMatchObject({ model: "m", stream: true });
  });
});
