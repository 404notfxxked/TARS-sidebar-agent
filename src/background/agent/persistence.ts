// 落盘收口:增量保存(persistNewMessages)与失败轮错误行(persistFailure)。
// ⚠️ messages 与三个锚点(savedUpTo/persistedSeqs/persistedInCtx)必须同生共死
// —— 全部经同一个 loop 引用读写,这里不做任何复制/解构;锚点算术一处都不能动
// (2026-09 事故:失败轮 error 行被同会话追问写没,见 RunLoopState 头注)。

import { createLogger } from "../../shared/logger";
import { errText } from "../../shared/errors";
import { saveHistory } from "../sessions/sessionHistory";
import type { RunLoopState } from "./agent";

const log = createLogger({ ctx: "bg" });

/**
 * 增量落盘:每 turn 收口即追加保存,中途关面板(端口断开取消)或 SW 被
 * 杀最多丢进行中的 turn,不再丢整轮对话(含用户提问)。savedUpTo = 领域
 * 消息里已落盘到的下标;baseSeq = 库里已有条数 = 初始历史 + 已落盘的新增。
 * appendMessages 按 [sessionId, seq] put,保存失败不推进游标、下次重写
 * 同一批 seq,天然幂等。取消在 turn 中段打断时不追加保存 —— 历史不能停在
 * 未答完的 toolCalls 上(严格端点拒收),已收口的边界已在库里
 */
export async function persistNewMessages(
  loop: RunLoopState,
  sessionId: string | undefined,
): Promise<void> {
  if (!sessionId) return;
  const domain = loop.messages.slice(1);
  if (domain.length <= loop.savedUpTo) return;
  try {
    await saveHistory(
      sessionId,
      domain,
      loop.savedUpTo,
      loop.persistedSeqs + (loop.savedUpTo - loop.persistedInCtx),
    );
    loop.savedUpTo = domain.length;
  } catch (err) {
    // 落盘失败不打断 run:边界留在原地,下个收口点把这一批连同新内容重写
    log.warn("agent", "save history failed", {
      stack: err instanceof Error ? err.stack : String(err),
    });
  }
}

/**
 * 失败轮错误行:比 persistNewMessages 多追加一条 error 行,锚点语义一致
 * (fromIdx = savedUpTo,连同此前未落盘的尾巴一起写)。文本与实况错误
 * 气泡同文同源(后台错误串,不经字典 —— 既有债务,AGENTS.md「文案」)
 */
export async function persistFailure(
  loop: RunLoopState,
  sessionId: string | undefined,
  text: string,
): Promise<void> {
  if (!sessionId) return;
  try {
    const domain = loop.messages.slice(1);
    await saveHistory(
      sessionId,
      [...domain, { role: "assistant", content: text, error: true }],
      loop.savedUpTo,
      loop.persistedSeqs + (loop.savedUpTo - loop.persistedInCtx),
    );
  } catch (err) {
    log.warn("agent", "save error row failed", {
      error: errText(err),
    });
  }
}
