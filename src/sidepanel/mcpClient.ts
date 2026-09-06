// 面板侧 MCP_* 轻客户端(与 memoryClient 同款模式):一次性端口发一条请求,
// 等后台回包即断。连接与工具清单必须走 SW —— 工具执行、连接缓存都在 SW,
// 面板只做展示与转配(设置页「测试连接 / 工具清单」顺带预热缓存)。

import {
  MSG,
  PORT_NAME,
  type McpToolInfo,
} from "../shared/messages";
import type { McpServerEntry } from "../shared/mcp";

/** 发一条请求,等指定类型的回包原样返回 */
function portReq(
  msg: Record<string, unknown>,
  replyType: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: PORT_NAME });
    port.onMessage.addListener((evt: Record<string, unknown>) => {
      if (evt.type === replyType) {
        resolve(evt);
        port.disconnect();
      }
    });
    port.onDisconnect.addListener(() => reject(new Error("port closed")));
    port.postMessage(msg);
  });
}

/** 测试连接(连 tools/list 一起拉,成功即预热缓存) */
export async function mcpTest(server: McpServerEntry) {
  const e = await portReq({ type: MSG.MCP_TEST, server }, MSG.MCP_TEST_RESULT);
  return {
    ok: e.ok === true,
    toolCount: e.toolCount as number | undefined,
    era: e.era as string | undefined,
    error: e.error as string | undefined,
  };
}

/** 拉取该服务器的工具清单(名称 + 描述,UI 展示用) */
export async function mcpListTools(server: McpServerEntry): Promise<McpToolInfo[]> {
  const e = await portReq({ type: MSG.MCP_TOOLS, server }, MSG.MCP_TOOLS_RESULT);
  if (typeof e.error === "string") throw new Error(e.error);
  return (e.tools as McpToolInfo[]) ?? [];
}
