import { describe, expect, it } from "vitest";
import { readSSE } from "./openai";

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

async function collect(res: Response): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const event of readSSE(res)) out.push(event);
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
});
