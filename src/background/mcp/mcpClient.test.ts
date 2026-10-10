// McpClient 单测:响应解析的两条分支(JSON / 请求作用域 SSE)+ 错误映射 +
// 400 触发的 legacy 握手重试。fetch 打桩在 globalThis;chrome 缺席时
// clientInfo 回落 0.0.0(设计内路径,见 mcpClient.ts 头注)。

import { afterEach, describe, expect, it, vi } from "vitest";
import { McpClient, McpRpcError } from "./mcpClient";

const SSE_HEADERS = { "Content-Type": "text/event-stream" };
const JSON_HEADERS = { "Content-Type": "application/json" };

const sseResponse = (frames: unknown[]) =>
  new Response(
    frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(""),
    { headers: SSE_HEADERS },
  );

const jsonResponse = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { headers: { ...JSON_HEADERS, ...headers } });

const newClient = () =>
  new McpClient({ url: "https://mcp.test/endpoint", headers: {} }, "测试服务器");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("McpClient 响应解析", () => {
  it("JSON 响应:id 配对返回 result,首请求探测成功 → modern", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(jsonResponse({ jsonrpc: "2.0", id: 1, result: { tools: [] } })),
    );
    const c = newClient();
    await expect(c.request("tools/list", {})).resolves.toEqual({ tools: [] });
    expect(c.era).toBe("modern");
  });

  it("JSON 响应里的 JSON-RPC 错误 → McpRpcError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32601, message: "no such method" },
        }),
      ),
    );
    const c = newClient();
    await expect(c.request("nope", {})).rejects.toBeInstanceOf(McpRpcError);
  });

  it("SSE 响应:请求作用域流取本 id 的最终响应,通知帧忽略", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        sseResponse([
          { jsonrpc: "2.0", method: "notifications/progress", params: {} },
          { jsonrpc: "2.0", id: 1, result: { ok: true } },
        ]),
      ),
    );
    const c = newClient();
    await expect(c.request("tools/call", { name: "f" })).resolves.toEqual({ ok: true });
    expect(c.era).toBe("modern");
  });

  it("SSE 流上的错误帧 → McpRpcError;流提前结束 → 显式报错不挂死", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        sseResponse([
          { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "tool broke" } },
        ]),
      ),
    );
    const c = newClient();
    await expect(c.request("tools/call", {})).rejects.toBeInstanceOf(McpRpcError);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(sseResponse([])));
    const c2 = newClient();
    await expect(c2.request("tools/call", {})).rejects.toThrow(/stream ended/);
  });

  it("现代形状 400 → initialize 握手转 legacy 并重试:重试请求带会话头、不带现代协议头", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("no modern api", { status: 400 }))
      .mockResolvedValueOnce(
        jsonResponse(
          { jsonrpc: "2.0", id: 2, result: { protocolVersion: "2025-06-18" } },
          { "mcp-session-id": "sess-1" },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 })) // notifications/initialized
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: "2.0", id: 3, result: { done: true } }));
    vi.stubGlobal("fetch", fetchMock);

    const c = newClient();
    await expect(c.request("tools/list", {})).resolves.toEqual({ done: true });
    expect(c.era).toBe("legacy");

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const retryInit = fetchMock.mock.calls[3]![1] as {
      headers: Record<string, string>;
      body: string;
    };
    expect(retryInit.headers["Mcp-Session-Id"]).toBe("sess-1");
    expect(retryInit.headers).not.toHaveProperty("MCP-Protocol-Version");
    const retriedBody = JSON.parse(retryInit.body) as { method: string };
    expect(retriedBody.method).toBe("tools/list"); // 原请求重发,不是 initialize
  });
});
