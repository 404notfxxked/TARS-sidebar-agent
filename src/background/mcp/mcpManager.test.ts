// mcpManager 单测:tools/list 分页拉全 + 单服务器工具数硬上限。
// fetch 全局 stub,按请求序回放分页响应(与 e2e 的 CDP 请求档案同思路);
// 走真 McpClient(现代形状首请求兼做时代探测),协议层不在本文件覆盖面内。

import { afterEach, describe, expect, it, vi } from "vitest";
import { getMcpToolSchemas, listServerTools } from "./mcpManager";
import type { McpConfig } from "../../shared/mcp";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** 每台测试服务器独立 id:mcpManager 的连接缓存是模块级,防用例间串味 */
const server = (id: string, name: string): McpConfig => ({
  enabled: true,
  servers: [
    { id, name, url: "https://mcp.example.com/mcp", headers: {}, enabled: true },
  ],
});

/** 按页序回放 tools/list 结果;记录每次请求体供 cursor 断言。
 *  响应回显请求 id —— 客户端逐请求递增 id 并做配对校验 */
function stubPaginatedFetch(pages: { tools?: unknown[]; nextCursor?: unknown }[]) {
  const bodies: string[] = [];
  const fetchMock = vi.fn(async (_url: unknown, init?: { body?: string }) => {
    const page = pages[Math.min(bodies.length, pages.length - 1)];
    bodies.push(String(init?.body));
    const reqId = JSON.parse(init?.body ?? "{}").id ?? 1;
    return jsonResponse({ jsonrpc: "2.0", id: reqId, result: page });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { bodies, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("tools/list 分页", () => {
  it("nextCursor 逐页拉全,工具齐全且顺序保持,后续页带上页 cursor", async () => {
    const { bodies, fetchMock } = stubPaginatedFetch([
      { tools: [{ name: "a" }, { name: "b" }], nextCursor: "p2" },
      { tools: [{ name: "c" }], nextCursor: "p3" },
      { tools: [{ name: "d" }] },
    ]);
    const { schemas, errors } = await getMcpToolSchemas(server("s1", "Paged"));
    expect(errors).toEqual([]);
    expect(schemas.map((s) => s.name)).toEqual([
      "mcp_Paged_a",
      "mcp_Paged_b",
      "mcp_Paged_c",
      "mcp_Paged_d",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(bodies[1]).toContain('"cursor":"p2"');
    expect(bodies[2]).toContain('"cursor":"p3"');
  });

  it("单页无 nextCursor 行为不变:只发一次请求", async () => {
    const { fetchMock } = stubPaginatedFetch([{ tools: [{ name: "only" }] }]);
    const { schemas, errors } = await getMcpToolSchemas(server("s2", "Single"));
    expect(errors).toEqual([]);
    expect(schemas.map((s) => s.name)).toEqual(["mcp_Single_only"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("工具数达上限即停:不再翻页,注入数封顶(硬预算护栏)", async () => {
    const bigPage = Array.from({ length: 250 }, (_, i) => ({ name: `t${i}` }));
    const { fetchMock } = stubPaginatedFetch([
      { tools: bigPage, nextCursor: "more" },
      { tools: [] },
    ]);
    const { schemas, errors } = await getMcpToolSchemas(server("s3", "Cap"));
    expect(errors).toEqual([]);
    expect(schemas.length).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("空页挂 cursor 不死循环:正常终止", async () => {
    const { fetchMock } = stubPaginatedFetch([
      { tools: [], nextCursor: "x" },
      { tools: [] },
    ]);
    const { schemas, errors } = await getMcpToolSchemas(server("s4", "Empty"));
    expect(errors).toEqual([]);
    expect(schemas).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("工具级启停", () => {
  it("禁用工具不进 schema;listServerTools 仍回全量(面板开关的数据源)", async () => {
    const cfg = server("s5", "Filt");
    cfg.servers[0].disabledTools = ["b"];
    stubPaginatedFetch([{ tools: [{ name: "a" }, { name: "b" }, { name: "c" }] }]);
    const { schemas, errors } = await getMcpToolSchemas(cfg);
    expect(errors).toEqual([]);
    expect(schemas.map((s) => s.name)).toEqual(["mcp_Filt_a", "mcp_Filt_c"]);
    const all = await listServerTools(cfg.servers[0]);
    expect(all.map((t) => t.name)).toEqual(["a", "b", "c"]);
  });
});
