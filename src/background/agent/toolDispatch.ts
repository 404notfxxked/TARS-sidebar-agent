// 工具分发:注册表工具的统一执行口 —— 确认门(写动作/私网出口)、批准后的
// 白名单追加、执行上下文归属。 ⚠️ setToolExecutionContext 必须紧贴
// tool.execute(并发纪律见 toolContext.ts 头注);清理不在本模块 —— 只在
// run 收口的 finally(agent.ts)由所有者统一做。

import { allowlistDomainOf } from "../web/outboundGuard";
import { getTool } from "../tools/tools";
import { setToolExecutionContext, type ToolExecutionContext } from "../tools/toolContext";
import {
  CONFIRM_DENIED_MSG,
  needsConfirmation,
  requestConfirmation,
} from "./confirmations";
import type { AgentPort } from "./agent";

export type DispatchToolCall = (name: string, args: unknown) => Promise<unknown>;

/** 工具分发工厂:闭包本次 run 的确认开关/白名单/执行上下文。
 *  注:本函数不读写 run 可变状态(messages/落盘锚点都在 loop 里),故不收 loop;
 *  run 内会变的只有确认白名单集合,按引用传入(确认门里 add)。 */
export function createDispatchToolCall(
  cfg: { confirmActions: boolean },
  toolCtx: ToolExecutionContext,
  port: AgentPort,
  signal: AbortSignal | undefined,
  fetchAllowlist: Set<string>,
): DispatchToolCall {
  return async (name, args) => {
    const tool = getTool(name);
    if (!tool) throw new Error(`unknown tool: ${name}`);
    // 写操作确认门:页面动作(点按/填写)、记忆写入/删除、MCP 动态工具
    // (语义未知不假设只读),以及 web_fetch 的出口判定(私网目标 /
    // 白名单未命中)默认逐次经面板确认(设置可关)。拒绝/超时的文案作为
    // 工具错误回给模型 —— 让它改道而不是硬重试
    if (cfg.confirmActions && needsConfirmation(name, args, fetchAllowlist)) {
      const approved = await requestConfirmation(
        port,
        { name, displayName: tool.displayName, args },
        signal,
        toolCtx,
      );
      if (!approved) throw new Error(CONFIRM_DENIED_MSG);
      // 批准即知情:同 run 内该域后续抓取不再重复确认(跨 run 由下一轮
      // 从历史里的成功抓取结果推导)
      if (name === "web_fetch") {
        const domain = allowlistDomainOf(
          typeof (args as { url?: unknown } | null)?.url === "string"
            ? ((args as { url: string }).url as string)
            : "",
        );
        if (domain) fetchAllowlist.add(domain);
      }
    }
    setToolExecutionContext(toolCtx);
    return await tool.execute(args);
  };
}
