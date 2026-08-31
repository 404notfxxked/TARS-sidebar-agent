// 会话历史:IndexedDB 持久化,多会话各自隔离
// - 后台 SW 是唯一读写方,面板经 LOAD_HISTORY / LIST_SESSIONS 等消息间接访问
// - 写入是「基线追加」:run 开始时记下历史长度,结束时只落新增的消息,
//   上下文溢出裁剪只影响本轮 prompt、不写回 —— 落盘永远是全量历史
// - 保留期:默认只留最近 7 天(按最后活跃算),懒清理(启动 + 每次保存后),
//   0 = 全部保留。数据短命是有意为之:IndexedDB 会被用户的「清除浏览数据」
//   连带清掉、磁盘紧张时可能被驱逐,当历史被当作可丢弃数据时这些都不再致命
// - 首次启动把旧版 chrome.storage.session 里的 history:* 一次性搬进来

import type { InternalMsg } from "./provider/types";
import type { ChatRecord, SessionMeta } from "../shared/messages";
import { createLogger } from "../shared/logger";
import * as db from "./sessionDb";

const log = createLogger({ ctx: "bg" });

export const RETENTION_DEFAULT_DAYS = 7;
/** 列表标题截断长度 */
const TITLE_MAX_CHARS = 30;

/** 读某会话全部消息(seq 升序);没有/读取失败返回空数组 */
export async function loadHistory(sessionId: string): Promise<InternalMsg[]> {
  if (!sessionId) return [];
  try {
    const rows = await db.loadMessageRows(sessionId);
    return rows
      .map((r) => r.msg)
      .filter(
        (m): m is InternalMsg =>
          !!m && typeof m === "object" && "role" in (m as object),
      );
  } catch (err) {
    log.warn("agent", "load history failed", {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** 追加保存:只落本轮新增的消息。
 *  - msgs:本轮结束时的完整领域消息(不含 system,调用方已 slice(1))
 *  - fromIdx:msgs 里第一条「本轮新增」的下标。无裁剪时 = 已落盘条数;
 *    发生过溢出裁剪时更小(最早几轮已从内存丢弃,但库里仍存着全量 ——
 *    裁剪只影响本轮 prompt,不写回,落盘永远是全量历史)
 *  - baseSeq:该会话在库里的已有条数,即新消息的起始 seq
 *  落盘前剥离思考内容(reasoning_content):严格按 OpenAI 规范校验的端点
 *  对 assistant 消息里的未知字段直接 400;单次 run 内的逐轮回传不受影响
 *  (agent 循环直接用内存 messages)。写失败由调用方兜底,不打断回答。 */
export async function saveHistory(
  sessionId: string,
  msgs: InternalMsg[],
  fromIdx: number,
  baseSeq: number,
): Promise<void> {
  if (!sessionId) return;
  const fresh = msgs.slice(fromIdx).map(stripReasoning);
  if (fresh.length === 0) return;
  const now = Date.now();
  const prev = await db.getSession(sessionId).catch(() => undefined);
  const meta: db.SessionRow = {
    id: sessionId,
    title: prev?.title || deriveTitle(msgs),
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
    msgCount: msgs.length,
  };
  await db.appendMessages(sessionId, meta, fresh, baseSeq);
  // 顺带做一次保留期清理(内部自捕获,失败不影响本次保存)
  void pruneExpiredSessions();
}

/** 会话列表,最近活跃在前 */
export async function listSessions(): Promise<SessionMeta[]> {
  const rows = await db.listSessions();
  return rows.map(({ id, title, createdAt, updatedAt, msgCount }) => ({
    id,
    title,
    createdAt,
    updatedAt,
    msgCount,
  }));
}

export function deleteSession(sessionId: string): Promise<void> {
  return db.deleteSessionRows(sessionId);
}

export function clearAllSessions(): Promise<void> {
  return db.clearAllRows();
}

/** 保留期天数:storage.local 的 historyRetention(0 = 全部保留),缺省 7 */
async function retentionDays(): Promise<number> {
  try {
    const l = await chrome.storage.local.get("historyRetention");
    const v = l.historyRetention;
    return typeof v === "number" && v >= 0 ? v : RETENTION_DEFAULT_DAYS;
  } catch {
    return RETENTION_DEFAULT_DAYS;
  }
}

/** 清掉超过保留期的会话。按 updatedAt(最后活跃)判定,不按创建时间 ——
 *  老会话但一直在聊的不该被清。极端情况:会话在浏览器长开期间闲置老化、
 *  被其他会话的保存触发的清理波及,此时它尚无新写入,删掉可接受。 */
export async function pruneExpiredSessions(): Promise<void> {
  try {
    const days = await retentionDays();
    if (days <= 0) return;
    const cutoff = Date.now() - days * 86_400_000;
    const rows = await db.listSessions();
    const expired = rows
      .filter((r) => r.updatedAt < cutoff)
      .map((r) => r.id);
    if (expired.length > 0) await db.deleteSessions(expired);
  } catch (err) {
    log.warn("bg", "prune sessions failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** 一次性迁移:旧版把整包历史存 chrome.storage.session(浏览器重启即丢)。
 *  搬进 IDB 后删掉旧 key,天然幂等(搬完 key 就没了)。 */
export async function migrateLegacySessionStorage(): Promise<void> {
  try {
    const bag = await chrome.storage.session.get(null);
    const legacyKeys = Object.keys(bag).filter((k) =>
      k.startsWith("history:"),
    );
    for (const key of legacyKeys) {
      const id = key.slice("history:".length);
      const msgs = bag[key];
      if (Array.isArray(msgs) && msgs.length > 0) {
        await saveHistory(id, msgs as InternalMsg[], 0, 0);
        log.info("bg", "migrated legacy history", {
          sessionId: id,
          msgs: msgs.length,
        });
      }
      await chrome.storage.session.remove(key);
    }
    // 旧版的全局会话指针:新语义(打开即新会话)下不再需要
    await chrome.storage.session.remove("sessionId:default");
  } catch (err) {
    log.warn("bg", "legacy history migration failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** 首条用户消息 → 列表标题。用户 content 带 <context>/<user-request> 包裹,
 *  取 <user-request> 内层文本(旧数据无包裹则原样用),压平空白后截断 */
function deriveTitle(msgs: InternalMsg[]): string {
  const first = msgs.find((m) => m.role === "user");
  const raw = first?.content ?? "";
  const inner = raw.match(/<user-request>([\s\S]*?)<\/user-request>/);
  const text = (inner ? inner[1] : raw).replace(/\s+/g, " ").trim();
  if (!text) return "未命名会话";
  return text.length > TITLE_MAX_CHARS
    ? `${text.slice(0, TITLE_MAX_CHARS)}…`
    : text;
}

function stripReasoning(
  m: InternalMsg,
): InternalMsg {
  if (m.role !== "assistant" || m.reasoning_content === undefined) return m;
  // 重建对象以彻底去掉 reasoning_content 键(undefined 值可能被存储层保留)
  return {
    role: "assistant",
    content: m.content,
    ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
    ...(m.model ? { model: m.model } : {}),
  };
}

/** 完整 InternalMsg[] → 前端展示用的精简投影(只留 user/assistant 文本) */
export function toChatRecords(msgs: InternalMsg[]): ChatRecord[] {
  const out: ChatRecord[] = [];
  for (const m of msgs) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant" && m.content) {
      out.push({ role: "assistant", content: m.content });
    }
    // tool / 空 assistant 不展示
  }
  return out;
}
