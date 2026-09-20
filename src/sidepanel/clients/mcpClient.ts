// 面板侧 MCP_* 轻客户端(与 memoryClient 同款模式):一次性端口发一条请求,
// 等后台回包即断。连接与工具清单必须走 SW —— 工具执行、连接缓存都在 SW,
// 面板只做展示与转配(设置页「测试连接 / 工具清单」顺带预热缓存)。

import {
  MSG,
  type McpToolInfo,
} from "../../shared/messages";
import type { McpServerEntry } from "../../shared/mcp";
import { portReq } from "./portRequest";

/** 测试连接(连 tools/list 一起拉,成功即预热缓存) */
export async function mcpTest(server: McpServerEntry) {
  const e = await portReq<{
    ok?: boolean;
    toolCount?: number;
    era?: string;
    error?: string;
  }>({ type: MSG.MCP_TEST, server }, MSG.MCP_TEST_RESULT);
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
  );
  if (typeof e.error === "string") throw new Error(e.error);
  return e.tools ?? [];
}
