// session 域 port 消息 handler:历史回放(带压缩点/resync)、会话列表、
// 删除、清空、气泡图片字节通道。存储访问走 sessions/sessionHistory,
// 单例与 port 仍归 index.ts 所有,此处只经 ctx 访问。

import { MSG, type SideToBg } from "../../shared/messages";
import { errText } from "../../shared/errors";
import { bytesToBase64 } from "../../shared/imageCodec";
import {
  clearAllSessions,
  deleteSession,
  getCompactionMark,
  listSessions,
  loadImage,
  loadHistory,
  toChatRecords,
} from "../sessions/sessionHistory";
import type { PortCtx } from "./context";

export async function handleSessionMessage(
  msg: SideToBg,
  ctx: PortCtx,
): Promise<boolean> {
  const { port } = ctx;
  switch (msg.type) {
    case MSG.LOAD_HISTORY: {
      // 从历史列表切回某会话时,把该会话消息回给前端渲染;
      // 有压缩时带上压缩点,面板据此渲染分隔条(历史本身始终全量)。
      // resync = 断连重同步,原样回显给面板走「按库替换」分支。
      // sessionId 必须回带:面板按「响应会话 == 当前会话」判定新鲜度,
      // 缺了它,快速切会话时旧回包会把 A 的转写盖上 B 的 id。
      // 兜底回包纪律(同 LIST_SESSIONS):读取抛错必须带 error 回包,
      // 否则面板把存储异常伪装成空会话(REQ-P0-3 评审补漏)
      try {
        const history = await loadHistory(msg.sessionId);
        const compaction = await getCompactionMark(msg.sessionId);
        port.postMessage({
          type: MSG.HISTORY,
          sessionId: msg.sessionId,
          messages: toChatRecords(history),
          ...(compaction ? { compaction } : {}),
          ...(msg.resync ? { resync: true } : {}),
        });
      } catch (e) {
        port.postMessage({
          type: MSG.HISTORY,
          sessionId: msg.sessionId,
          messages: [],
          error: errText(e),
          ...(msg.resync ? { resync: true } : {}),
        });
      }
      return true;
    }
    case MSG.LIST_SESSIONS: {
      // 兜底回包纪律(port 消息 checklist):handler 抛错必须带 error 回包,
      // 否则面板只能干等超时,且会把存储异常误读成「还没有会话」(REQ-P0-3)
      try {
        const sessions = await listSessions();
        port.postMessage({ type: MSG.SESSIONS, sessions });
      } catch (e) {
        port.postMessage({
          type: MSG.SESSIONS,
          sessions: [],
          error: errText(e),
        });
      }
      return true;
    }
    case MSG.DELETE_SESSION: {
      await deleteSession(msg.sessionId);
      return true;
    }
    case MSG.CLEAR_ALL_HISTORY: {
      await clearAllSessions();
      return true;
    }
    case MSG.GET_IMAGE: {
      // 历史气泡渲染图片:字节单独走这条通道(消息列表只带元数据)。
      // base64 传输 —— port 消息是 JSON 语义,TypedArray 过不去
      const img = await loadImage(msg.id).catch(() => undefined);
      try {
        port.postMessage({
          type: MSG.IMAGE_DATA,
          id: msg.id,
          ...(img
            ? {
                mime: img.mime,
                base64: bytesToBase64(img.bytes),
                w: img.w,
                h: img.h,
              }
            : {}),
        });
      } catch {
        /* 端口已断开,面板侧反正也收不到 */
      }
      return true;
    }
    default:
      return false;
  }
}
