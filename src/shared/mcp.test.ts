// shared/mcp 单测:宽松归一的新字段(disabledTools / timeoutMs)与
// parseMcpImport 的四种认可形态。纯函数,无 chrome 依赖。

import { describe, expect, it } from "vitest";
import {
  clampMcpTimeoutMs,
  MCP_TIMEOUT_MAX_MS,
  MCP_TIMEOUT_MIN_MS,
  normalizeMcp,
  parseMcpImport,
} from "./mcp";

describe("normalizeMcp 新字段", () => {
  it("disabledTools 只留非空字符串,空集收敛为 undefined", () => {
    const cfg = normalizeMcp({
      enabled: true,
      servers: [
        { id: "a", enabled: true, disabledTools: ["x", "", 3, null] },
        { id: "b", enabled: true, disabledTools: [] },
        { id: "c", enabled: true },
      ],
    });
    expect(cfg.servers[0].disabledTools).toEqual(["x"]);
    expect(cfg.servers[1].disabledTools).toBeUndefined();
    expect(cfg.servers[2].disabledTools).toBeUndefined();
  });

  it("timeoutMs 收窄到合法区间,非法值回落 undefined(用内置缺省)", () => {
    const cfg = normalizeMcp({
      servers: [
        { id: "a", timeoutMs: 1 },
        { id: "b", timeoutMs: 999_999 },
        { id: "c", timeoutMs: 123_456 },
        { id: "d", timeoutMs: "slow" },
        { id: "e" },
      ],
    });
    expect(cfg.servers[0].timeoutMs).toBe(MCP_TIMEOUT_MIN_MS);
    expect(cfg.servers[1].timeoutMs).toBe(MCP_TIMEOUT_MAX_MS);
    expect(cfg.servers[2].timeoutMs).toBe(123_456);
    expect(cfg.servers[3].timeoutMs).toBeUndefined();
    expect(cfg.servers[4].timeoutMs).toBeUndefined();
  });

  it("clampMcpTimeoutMs:取整并夹紧", () => {
    expect(clampMcpTimeoutMs(0)).toBe(MCP_TIMEOUT_MIN_MS);
    expect(clampMcpTimeoutMs(12345.6)).toBe(12346);
    expect(clampMcpTimeoutMs(Number.NaN)).toBe(60_000);
  });
});

describe("parseMcpImport", () => {
  it("单台对象:补 enabled,headers 归一", () => {
    const r = parseMcpImport({
      name: "GitHub",
      url: "https://api.githubcopilot.com/mcp",
      headers: { Authorization: " Bearer ghp_x " },
    });
    expect(r.skipped).toBe(0);
    expect(r.entries).toEqual([
      {
        name: "GitHub",
        url: "https://api.githubcopilot.com/mcp",
        headers: { Authorization: "Bearer ghp_x" },
        enabled: true,
      },
    ]);
  });

  it("数组与 servers 键:逐台解析", () => {
    const arr = [{ url: "https://a.example.com/mcp" }, { url: "https://b.example.com/mcp" }];
    expect(parseMcpImport(arr).entries.length).toBe(2);
    expect(parseMcpImport({ servers: arr }).entries.length).toBe(2);
  });

  it("mcpServers 键(Claude Desktop 风格):键名作 name,stdio 条目跳过计数", () => {
    const r = parseMcpImport({
      mcpServers: {
        deepwiki: { url: "https://mcp.deepwiki.com/mcp" },
        memory: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] },
      },
    });
    expect(r.skipped).toBe(1);
    expect(r.entries).toEqual([
      {
        name: "deepwiki",
        url: "https://mcp.deepwiki.com/mcp",
        headers: {},
        enabled: true,
      },
    ]);
  });

  it("缺 URL / 非 http(s) / 垃圾输入:跳过或空结果", () => {
    expect(parseMcpImport({ command: "npx" }).skipped).toBe(1);
    expect(parseMcpImport({ url: "ftp://x" }).skipped).toBe(1);
    expect(parseMcpImport("not json").entries).toEqual([]);
    expect(parseMcpImport(null).entries).toEqual([]);
    expect(parseMcpImport([{ url: "https://ok.example.com" }, 42]).skipped).toBe(1);
  });
});
