// run 域 port 消息 handler:用户消息(会话级防重 + 启动)、重答(截库窗口
// 防重)、取消(只响应归属面板)、确认卡答复。activeRuns / preparingSessions /
// sessionBusy / launchRun 仍归 index.ts 所有,此处只经 ctx 访问。

import {
  MSG,
  type SideToBg,
  type UserMessagePayload,
} from "../../shared/messages";
import { errText } from "../../shared/errors";
import { createLogger } from "../../shared/logger";
import { resolveConfirmation } from "../agent/confirmations";
import { prepareRegenerate } from "../sessions/sessionHistory";
import type { PortCtx } from "./context";

const log = createLogger({ ctx: "bg" });

export async function handleRunMessage(
  msg: SideToBg,
  ctx: PortCtx,
): Promise<boolean> {
  const { port, activeRuns, preparingSessions, sessionBusy, launchRun } = ctx;
  switch (msg.type) {
    case MSG.USER_MESSAGE: {
      // 会话级防重:同会话已有 run 在途时拒绝(双窗口同会话 / 面板异步
      // 门控的竞窗都会打到这)。面板在提交时乐观置 thinking,拒绝必须
      // 回包(AGENT_ERROR 会让面板归位 idle 并显示错误),否则卡死在思考态
      const sessionId = msg.payload.sessionId ?? crypto.randomUUID();
      if (sessionBusy(sessionId)) {
        log.warn("agent", "user message ignored, run in progress", {
          sessionId,
        });
        try {
          port.postMessage({
            type: MSG.AGENT_ERROR,
            error: "该会话已有正在进行的任务,请等它结束后再发送新消息",
          });
        } catch {
          /* 端口已断开 */
        }
        return true;
      }
      await launchRun(port, { ...msg.payload, sessionId });
      return true;
    }
    case MSG.REGENERATE: {
      // 已有 run 在跑(或截库在途)的会话不接受重答。SW 侧防重是权威防线
      // (面板的 idle 门控读渲染闭包,异步窗口内不保证拦住),面板门控只是
      // 第一道 Filter
      if (sessionBusy(msg.sessionId)) {
        log.warn("agent", "regenerate ignored, run in progress", {
          sessionId: msg.sessionId,
        });
        return true;
      }
      // 占位登记一直持有到 launchRun 收口(内部随即写 activeRuns,两者对
      // 防重等价):中途不留「登记空窗」,哪条退出路径都不会漏放
      preparingSessions.add(msg.sessionId);
      try {
        // 截库失败同样要回包:面板已乐观截断本地消息并置 thinking,静默
        // 静默返回会把面板卡死在思考态(切会话/新对话都被 idle 门控拦住)
        let prep: UserMessagePayload | null = null;
        try {
          prep = await prepareRegenerate(msg.sessionId);
        } catch (err) {
          log.warn("agent", "regenerate prepare failed", {
            sessionId: msg.sessionId,
            error: errText(err),
          });
        }
        if (!prep) {
          try {
            port.postMessage({
              type: MSG.AGENT_ERROR,
              error:
                "没有可重新生成的消息:该会话可能尚未成功保存到本地,请直接发送新消息",
            });
          } catch {
            /* 端口已断开 */
          }
          return true;
        }
        // tabId 不还原:重答按当时的活动 tab 取页面上下文,与手发一致
        await launchRun(port, prep);
      } finally {
        preparingSessions.delete(msg.sessionId);
      }
      return true;
    }
    case MSG.CANCEL_RUN: {
      const run = activeRuns.get(msg.sessionId);
      log.warn("agent", "cancel requested", {
        sessionId: msg.sessionId,
        found: run !== undefined && run.port === port,
      });
      // 只响应归属面板的取消:历史列表是跨窗口共享的,别的窗口
      // 正在运行的会话不该被这里误杀
      if (run && run.port === port) run.abort.abort();
      return true;
    }
    case MSG.CONFIRM_RESPONSE: {
      // 确认卡的答复;未知/过期 requestId 在确认门内静默忽略
      resolveConfirmation(msg.requestId, msg.approved);
      return true;
    }
    default:
      return false;
  }
}
