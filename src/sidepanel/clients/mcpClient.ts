// 面板侧 MCP_* 轻客户端(与 memoryClient 同款模式):一次性端口发一条请求,
// 等后台回包即断。连接与工具清单必须走 SW —— 工具执行、连接缓存都在 SW,
// 面板只做展示与转配(设置页「测试连接 / 工具清单」顺带预热缓存)。

import {
  MSG,
  type McpEra,
  type McpToolInfo,
} from "../../shared/messages";
import { MCP_TIMEOUT_DEFAULT_MS } from "../../shared/mcp";
import type { McpServerEntry } from "../../shared/mcp";
import { portReq } from "./portRequest";

/** 面板侧 port 等待下限:略大于后端缺省超时,先让后端的明确错误先到 */
const PORT_TIMEOUT_BASE_MS = 70_000;

/** 后端单请求超时可按服务器配置(mcpClient.ts 的 endpoint.timeoutMs),
 *  面板侧等待取「配置超时 + 10s」与下限的较大者,别比后台先断 */
function portTimeoutMs(server: McpServerEntry): number {
  return Math.max(PORT_TIMEOUT_BASE_MS, (server.timeoutMs ?? MCP_TIMEOUT_DEFAULT_MS) + 10_000);
}

/** 测试连接(连 tools/list 一起拉,成功即预热缓存) */
export async function mcpTest(server: McpServerEntry) {
  const e = await portReq<{
    ok?: boolean;
    toolCount?: number;
    era?: McpEra;
    error?: string;
  }>({ type: MSG.MCP_TEST, server }, MSG.MCP_TEST_RESULT, undefined, portTimeoutMs(server));
  return {
    ok: e.ok === true,
    toolCount: e.toolCount,
    era: e.era,
    error: e.error,
  };
}

/** 拉取该服务器的工具清单(名称 + 描述,UI 展示用) */
export async function mcpListTools(server: McpServerEntry): Promise<McpToolInfo[]> {
  const e = await portReq<{ error?: string; tools?: McpToolInfo[] }>(
    { type: MSG.MCP_TOOLS, server },
    MSG.MCP_TOOLS_RESULT,
    undefined,
    portTimeoutMs(server),
  );
  if (typeof e.error === "string") throw new Error(e.error);
  return e.tools ?? [];
}
