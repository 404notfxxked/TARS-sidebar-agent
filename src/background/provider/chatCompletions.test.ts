import { beforeEach, describe, expect, it, vi } from "vitest";
import { readSSE, ChatCompletionsAdapter } from "./chatCompletions";
import { apiFetch } from "./client";
import type { ChatRequest } from "./types";

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

async function collect(res: Response, idleMs?: number): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const event of readSSE(res, idleMs)) out.push(event);
  return out;
}

describe("readSSE 兼容端点脏形态", () => {
  it("LF 帧逐条解析", async () => {
    const events = await collect(
      sseResponse([
        'data: {"n":1}\n\ndata: {"n":2}\n\ndata: [DONE]\n\n',
      ]),
    );
    expect(events).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("CRLF 行尾照常切帧", async () => {
    const events = await collect(
      sseResponse(['data: {"a":true}\r\n\r\ndata: {"b":1}\r\n\r\n']),
    );
    expect(events).toEqual([{ a: true }, { b: 1 }]);
  });

  it("CRLF 帧分隔符跨块劈开(块尾孤立 \\r)不破坏帧边界", async () => {
    // 帧分隔符 \r\n\r\n 在块尾断成 \r + \n:孤立的 \r 留在 buffer,
    // 与下一块的 \n 到齐后归一成 \n\n,帧边界恢复
    const events = await collect(
      sseResponse(['data: {"x":1}\r\n\r', "\ndata: [DONE]\r\n\r\n"]),
    );
    expect(events).toEqual([{ x: 1 }]);
  });

  it("半个帧留到下一个块再解析", async () => {
    const events = await collect(
      sseResponse(['data: {"par', 'tle":7}\n\ndata: [DONE]\n\n']),
    );
    expect(events).toEqual([{ partle: 7 }]);
  });

  it("单帧 JSON 坏了只跳过该帧,不炸整个流", async () => {
    const events = await collect(
      sseResponse([
        'data: {"ok":1}\n\ndata: {broken json}\n\ndata: {"ok":2}\n\ndata: [DONE]\n\n',
      ]),
    );
    expect(events).toEqual([{ ok: 1 }, { ok: 2 }]);
  });

  it("多行 data: 按规范拼成一整条载荷(JSON 跨行 token)", async () => {
    const events = await collect(
      sseResponse(['data: {"a":\n', 'data: 42}\n\ndata: [DONE]\n\n']),
    );
    expect(events).toEqual([{ a: 42 }]);
  });

  it("纯注释/心跳帧不产出事件", async () => {
    const events = await collect(
      sseResponse([': ping\n\ndata: {"v":9}\n\n: ping\n\ndata: [DONE]\n\n']),
    );
    expect(events).toEqual([{ v: 9 }]);
  });

  it("流中途断流:看门狗窗口内无字节即报错,不永久悬挂", async () => {
    // 半开流:发一帧后既不 close 也不再有字节(代理吞连接的典型形态)
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"n":1}\n\n'));
        // 故意不 close
      },
    });
    const events: unknown[] = [];
    await expect(
      (async () => {
        for await (const event of readSSE(new Response(stream), 40)) {
          events.push(event);
        }
      })(),
    ).rejects.toThrow(/stream stalled/);
    expect(events).toEqual([{ n: 1 }]); // 已收到的 delta 保留在调用方缓冲
  });

  it("正常流不受看门狗影响(每个字节都重置计时)", async () => {
    const events = await collect(
      sseResponse(['data: {"n":1}\n\n', 'data: [DONE]\n\n']),
      10_000,
    );
    expect(events).toEqual([{ n: 1 }]);
  });
});

// ---- ChatCompletionsAdapter.chat:delta 聚合层 ----
// 真实端点的 tool_calls arguments 是分片增量下发的,adapter 按 index
// 累加拼接;此前 e2e mock 永远整包单帧,聚合逻辑零覆盖(2026-09 评审)。

const apiFetchMock = vi.mocked(apiFetch);

/** 单个 SSE 帧编码(与 wire 形状一致,choices 只用首个) */
const frame = (delta: unknown, finishReason?: string) =>
  `data: ${JSON.stringify({
    choices: [{ delta, ...(finishReason ? { finish_reason: finishReason } : {}) }],
  })}\n\n`;

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

const adapter = () =>
  new ChatCompletionsAdapter({ apiKey: "sk-test", model: "test-model" });

beforeEach(() => {
  apiFetchMock.mockReset();
});

describe("ChatCompletionsAdapter 思考程度 → wire 参数", () => {
  /** 以指定 cfg 跑一轮,返回发给 apiFetch 的 body(取最近一次调用) */
  const bodyWith = async (cfg: {
    model: string;
    reasoningEffort?: string;
  }) => {
    apiFetchMock.mockResolvedValue(
      sseResponse([frame({ content: "ok" }, "stop"), "data: [DONE]\n\n"]),
    );
    const { req } = makeReq();
    await new ChatCompletionsAdapter({ apiKey: "sk-test", ...cfg }).chat(req);
    return apiFetchMock.mock.calls.at(-1)![0].body as Record<string, unknown>;
  };

  it("档位值直传 reasoning_effort(各家族通用)", async () => {
    expect(
      (await bodyWith({ model: "glm-5.3", reasoningEffort: "max" })).reasoning_effort,
    ).toBe("max");
    expect(
      (await bodyWith({ model: "gpt-5", reasoningEffort: "medium" })).reasoning_effort,
    ).toBe("medium");
  });

  it("undefined = 跟随模型默认,不发任何思考参数", async () => {
    const body = await bodyWith({ model: "deepseek-flash" });
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.thinking).toBeUndefined();
    expect(body.enable_thinking).toBeUndefined();
  });

  it("关:effort 家族 → reasoning_effort none(deepseek/gemini)", async () => {
    expect(
      (await bodyWith({ model: "deepseek-flash", reasoningEffort: "off" })).reasoning_effort,
    ).toBe("none");
    expect(
      (await bodyWith({ model: "gemini-3.8-flash", reasoningEffort: "off" })).reasoning_effort,
    ).toBe("none");
  });

  it("关:glm → thinking.type disabled;qwen → enable_thinking false", async () => {
    expect(
      (await bodyWith({ model: "glm-4.5", reasoningEffort: "off" })).thinking,
    ).toEqual({ type: "disabled" });
    expect(
      (await bodyWith({ model: "qwen3-235b", reasoningEffort: "off" })).enable_thinking,
    ).toBe(false);
  });

  it("开:纯开关模型 glm → thinking.type enabled;qwen → enable_thinking true", async () => {
    expect(
      (await bodyWith({ model: "glm-4.5", reasoningEffort: "on" })).thinking,
    ).toEqual({ type: "enabled" });
    expect(
      (await bodyWith({ model: "qwen3-235b", reasoningEffort: "on" }))
        .enable_thinking,
    ).toBe(true);
  });

  it("开:其余家族开就是默认,不发参数(发未知字段可能 400)", async () => {
    const body = await bodyWith({
      model: "some-mystery-model",
      reasoningEffort: "on",
    });
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.thinking).toBeUndefined();
    expect(body.enable_thinking).toBeUndefined();
  });

  it("关:o 系/gpt-5 无法真正关,降级 minimal(最低档)", async () => {
    expect(
      (await bodyWith({ model: "o3", reasoningEffort: "off" })).reasoning_effort,
    ).toBe("minimal");
    expect(
      (await bodyWith({ model: "gpt-5", reasoningEffort: "off" })).reasoning_effort,
    ).toBe("minimal");
  });

  it("关:识别不出的家族不发参数(猜错会 400,跟随默认永远安全)", async () => {
    const body = await bodyWith({
      model: "some-mystery-model",
      reasoningEffort: "off",
    });
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.thinking).toBeUndefined();
    expect(body.enable_thinking).toBeUndefined();
  });

  it("OpenRouter 风格带厂商前缀的 id 家族识别照常", async () => {
    expect(
      (await bodyWith({
        model: "deepseek/deepseek-v4-flash",
        reasoningEffort: "off",
      })).reasoning_effort,
    ).toBe("none");
  });
});

describe("ChatCompletionsAdapter.chat 流式聚合", () => {
  it("tool_calls arguments 分 3 片到达,按 index 拼回完整 JSON", async () => {
    apiFetchMock.mockResolvedValue(
      sseResponse([
        frame({ tool_calls: [{ index: 0, id: "call_1", function: { name: "web_search", arguments: '{"que' } }] }),
        frame({ tool_calls: [{ index: 0, function: { arguments: 'ry":' } }] }),
        frame({ tool_calls: [{ index: 0, function: { arguments: '"tars"}' } }] }),
        frame({}, "tool_calls"),
        "data: [DONE]\n\n",
      ]),
    );
    const { req } = makeReq();
    const out = await adapter().chat(req);

    expect(out.content).toBe("");
    expect(out.finishReason).toBe("tool_calls");
    expect(out.toolCalls).toEqual([
      { id: "call_1", name: "web_search", args: { query: "tars" } },
    ]);
  });

  it("多个 tool_call 交错 delta(index 0/1 交替)互不串线", async () => {
    apiFetchMock.mockResolvedValue(
      sseResponse([
        frame({ tool_calls: [{ index: 0, id: "a", function: { name: "f1", arguments: '{"x":' } }] }),
        frame({ tool_calls: [{ index: 1, id: "b", function: { name: "f2", arguments: '{"y":2}' } }] }),
        frame({ tool_calls: [{ index: 0, function: { arguments: "1}" } }] }),
        frame({}, "tool_calls"),
        "data: [DONE]\n\n",
      ]),
    );
    const out = await adapter().chat(makeReq().req);

    expect(out.toolCalls).toEqual([
      { id: "a", name: "f1", args: { x: 1 } },
      { id: "b", name: "f2", args: { y: 2 } },
    ]);
  });

  it("function.name 本身分片到达时按 += 拼接(部分兼容端点的方言)", async () => {
    apiFetchMock.mockResolvedValue(
      sseResponse([
        frame({ tool_calls: [{ index: 0, id: "c", function: { name: "web_", arguments: "" } }] }),
        frame({ tool_calls: [{ index: 0, function: { name: "search", arguments: "{}" } }] }),
        frame({}, "tool_calls"),
        "data: [DONE]\n\n",
      ]),
    );
    const out = await adapter().chat(makeReq().req);

    expect(out.toolCalls).toEqual([
      { id: "c", name: "web_search", args: {} },
    ]);
  });

  it("finish_reason=length:截断的部分内容原样保留,不伪装成完整回答", async () => {
    apiFetchMock.mockResolvedValue(
      sseResponse([
        frame({ content: "回答写到一半" }),
        frame({}, "length"),
        "data: [DONE]\n\n",
      ]),
    );
    const { req, deltas } = makeReq();
    const out = await adapter().chat(req);

    expect(out.content).toBe("回答写到一半");
    expect(out.finishReason).toBe("length");
    expect(deltas).toEqual(["回答写到一半"]);
  });

  it("content 与 tool_calls 混合流:文本逐块回调,工具调用照常聚合", async () => {
    apiFetchMock.mockResolvedValue(
      sseResponse([
        frame({ content: "我先搜一下" }),
        frame({ tool_calls: [{ index: 0, id: "t", function: { name: "q", arguments: '{"k":1}' } }] }),
        frame({}, "tool_calls"),
        "data: [DONE]\n\n",
      ]),
    );
    const { req, deltas } = makeReq();
    const out = await adapter().chat(req);

    expect(deltas).toEqual(["我先搜一下"]);
    expect(out.content).toBe("我先搜一下");
    expect(out.toolCalls).toEqual([{ id: "t", name: "q", args: { k: 1 } }]);
  });

  it("reasoning 两种方言都归并进同一缓冲并回调", async () => {
    apiFetchMock.mockResolvedValue(
      sseResponse([
        frame({ reasoning_content: "思考A" }),
        frame({ reasoning: "思考B" }),
        frame({ content: "答" }),
        frame({}, "stop"),
        "data: [DONE]\n\n",
      ]),
    );
    const { req, reasoningDeltas } = makeReq();
    const out = await adapter().chat(req);

    expect(out.reasoning_content).toBe("思考A思考B");
    expect(reasoningDeltas).toEqual(["思考A", "思考B"]);
  });

  it("args 不是合法 JSON 时兜底为空对象,不炸整轮", async () => {
    apiFetchMock.mockResolvedValue(
      sseResponse([
        frame({ tool_calls: [{ index: 0, id: "x", function: { name: "f", arguments: "{broken" } }] }),
        frame({}, "tool_calls"),
        "data: [DONE]\n\n",
      ]),
    );
    const out = await adapter().chat(makeReq().req);

    expect(out.toolCalls).toEqual([{ id: "x", name: "f", args: {} }]);
  });

  it("只有 index 没有 name 的空壳 tool_call 被过滤", async () => {
    apiFetchMock.mockResolvedValue(
      sseResponse([
        frame({ tool_calls: [{ index: 0, id: "ghost", function: { arguments: "{}" } }] }),
        frame({}, "stop"),
        "data: [DONE]\n\n",
      ]),
    );
    const out = await adapter().chat(makeReq().req);

    expect(out.toolCalls).toEqual([]);
  });

  it("流中途错误帧:抛出服务端消息,不静默吞成空回答", async () => {
    apiFetchMock.mockResolvedValue(
      sseResponse([
        frame({ content: "写到一半" }),
        "data: " +
          JSON.stringify({ error: { message: "quota exceeded upstream" } }) +
          "\n\n",
        "data: [DONE]\n\n",
      ]),
    );
    await expect(adapter().chat(makeReq().req)).rejects.toThrow(
      "LLM stream error: quota exceeded upstream",
    );
  });

  it("请求体走流式约定:stream + include_usage,tools 映射 wire 形状", async () => {
    apiFetchMock.mockResolvedValue(
      sseResponse([frame({}, "stop"), "data: [DONE]\n\n"]),
    );
    await adapter().chat(
      makeReq({
        tools: [
          {
            type: "function",
            name: "q",
            description: "查询",
            parameters: { type: "object", properties: {} },
          },
        ],
      }).req,
    );

    const call = apiFetchMock.mock.calls[0][0];
    expect(call.path).toBe("/chat/completions");
    expect(call.body).toMatchObject({
      model: "test-model",
      stream: true,
      stream_options: { include_usage: true },
      tools: [
        {
          type: "function",
          function: { name: "q", description: "查询", parameters: { type: "object" } },
        },
      ],
    });
  });

  it("usage 帧映射成内部字段", async () => {
    apiFetchMock.mockResolvedValue(
      sseResponse([
        frame({ content: "ok" }),
        "data: " +
          JSON.stringify({
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }) +
          "\n\n",
        "data: [DONE]\n\n",
      ]),
    );
    const out = await adapter().chat(makeReq().req);

    expect(out.usage).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
  });
});
