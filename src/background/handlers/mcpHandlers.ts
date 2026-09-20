// mcp 域 port 消息 handler:服务器「测试连接」与工具清单拉取,失败都回
// 结构化结果(ok:false / tools:[])而非抛错 —— 面板就地展示错误。
// 访问走 mcp/mcpManager 的同一条后台缓存;port 仍归 index.ts 所有。

import { MSG, type SideToBg } from "../../shared/messages";
import { errText } from "../../shared/errors";
import { listServerTools, testServer } from "../mcp/mcpManager";
import type { PortCtx } from "./context";

export async function handleMcpMessage(
  msg: SideToBg,
  ctx: PortCtx,
): Promise<boolean> {
  const { port } = ctx;
  switch (msg.type) {
    case MSG.MCP_TEST: {
      // 测试连接:连 tools/list 一起拉(同一条缓存,成功即预热下次 run)
      try {
        port.postMessage({ type: MSG.MCP_TEST_RESULT, ...(await testServer(msg.server)) });
      } catch (err) {
        port.postMessage({
          type: MSG.MCP_TEST_RESULT,
          ok: false,
          error: errText(err),
        });
      }
      return true;
    }
    case MSG.MCP_TOOLS: {
      try {
        port.postMessage({ type: MSG.MCP_TOOLS_RESULT, tools: await listServerTools(msg.server) });
      } catch (err) {
        port.postMessage({
          type: MSG.MCP_TOOLS_RESULT,
          tools: [],
          error: errText(err),
        });
      }
      return true;
    }
    default:
      return false;
  }
}
