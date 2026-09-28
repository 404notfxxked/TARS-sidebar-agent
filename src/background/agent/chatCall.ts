// 带撞窗重试的 chat 调用:超窗错误 → 紧急压缩(保最近 2 轮)再试一次,
// 之后所有轮次沿用压缩投影。⚠️ emergency 是「发送投影」而非落盘状态:
// loop.emergency 的写入只发生在这里,只喂 projectEmergency /
// shouldEmergencyCompact,不得写进 loop.messages 或落盘(架构不变式 15①)。

import {
  EMERGENCY_KEEP_TURNS,
  compactHistory,
  summaryToMsg,
} from "./compaction";
import { projectEmergency, shouldEmergencyCompact } from "./overflow";
import { projectForRequest } from "./imageProjection";
import { errText } from "../../shared/errors";
import { MSG } from "../../shared/messages";
import { createLogger } from "../../shared/logger";
import type { ChatProvider, ChatResult, InternalMsg } from "../provider";
import type { ToolSchema } from "../../shared/toolTypes";
import type { AgentPort, RunLoopState } from "./agent";

const log = createLogger({ ctx: "bg" });

export type CallChat = (
  extraMsgs?: InternalMsg[],
  withTools?: boolean,
) => Promise<ChatResult>;

/** chat 调用工厂:闭包本次 run 的 provider/工具表/压缩模型/视觉门控与流式回调。 */
export function createCallChat(
  cfg: {
    provider: ChatProvider;
    summarizer: ChatProvider;
    tools: ToolSchema[];
    contextTokens?: number;
    visionOk: boolean;
  },
  loop: RunLoopState,
  port: AgentPort,
  signal: AbortSignal | undefined,
): CallChat {
  return async (extraMsgs: InternalMsg[] = [], withTools = true) => {
    const attempt = async () => {
      const base = loop.emergency
        ? projectEmergency(
            loop.messages,
            loop.emergency.summaryMsg,
            loop.emergency.afterIdx,
            // 记忆块必须常驻请求:紧急压缩会把它卷进摘要(有损),
            // 投影时重插回 system 后 —— 与正常装配的放置契约一致
            loop.memoryMsg ? [loop.memoryMsg] : [],
          )
        : loop.messages;
      return cfg.provider.chat({
        messages: await projectForRequest(loop, cfg.visionOk, [
          ...base,
          ...extraMsgs,
        ]),
        ...(withTools ? { tools: cfg.tools } : {}),
        onDelta: (delta) => port.postMessage({ type: MSG.AGENT_MESSAGE, delta }),
        onReasoningDelta: (delta) =>
          port.postMessage({ type: MSG.AGENT_REASONING, delta }),
        signal,
      });
    };
    try {
      return await attempt();
    } catch (err) {
      if (!shouldEmergencyCompact(err, loop.emergency, cfg.contextTokens))
        throw err;
      log.warn("agent", "请求超出上下文窗口,紧急压缩后重试", {
        turn: loop.turnNo,
        error: errText(err),
      });
      try {
        // 压缩输入去掉 system(下标整体 −1),产出的 uptoSeq 也是 −1 系,
        // 转回 messages 下标要 +2(system 偏移 + slice 端点转开区间)
        const outcome = await compactHistory(
          cfg.summarizer,
          loop.messages.slice(1),
          "",
          { keepTurns: EMERGENCY_KEEP_TURNS, signal },
        );
        loop.emergency = {
          summaryMsg: summaryToMsg(outcome.summary),
          afterIdx: outcome.uptoSeq + 2,
        };
      } catch (cErr) {
        log.warn("agent", "紧急压缩失败,放弃重试", {
          error: errText(cErr),
        });
        throw err; // 原始撞窗错误更有诊断价值
      }
      return attempt();
    }
  };
}
