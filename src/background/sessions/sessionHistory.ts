// 会话历史:IndexedDB 持久化,多会话各自隔离
// - 后台 SW 是唯一读写方,面板经 LOAD_HISTORY / LIST_SESSIONS 等消息间接访问
// - 写入是「基线追加」:run 开始时记下历史长度,结束时只落新增的消息,
//   上下文溢出裁剪只影响本轮 prompt、不写回 —— 落盘永远是全量历史
// - 保留期:默认只留最近 7 天(按最后活跃算),懒清理(启动 + 每次保存后),
//   0 = 全部保留。数据短命是有意为之:IndexedDB 会被用户的「清除浏览数据」
//   连带清掉、磁盘紧张时可能被驱逐,当历史被当作可丢弃数据时这些都不再致命
// - 首次启动把旧版 chrome.storage.session 里的 history:* 一次性搬进来

import type { InternalMsg } from "../provider/types";
import type { ChatRecord, SessionMeta, UserMessagePayload } from "../../shared/messages";
import { bytesToBase64 } from "../../shared/imageCodec";
import { createLogger } from "../../shared/logger";
import * as db from "./sessionDb";

const log = createLogger({ ctx: "bg" });

const RETENTION_DEFAULT_DAYS = 7;
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
 *  落盘前剥离思考内容(reasoning_content)与图片字节:严格按 OpenAI 规范
 *  校验的端点对 assistant 消息里的未知字段直接 400;图片字节进 images store,
 *  消息行只留引用。单次 run 内的逐轮回传不受影响(内存直用)。写失败由
 *  调用方兜底,不打断回答。 */
export async function saveHistory(
  sessionId: string,
  msgs: InternalMsg[],
  fromIdx: number,
  baseSeq: number,
): Promise<void> {
  if (!sessionId) return;
  const freshRaw = msgs.slice(fromIdx);
  if (freshRaw.length === 0) return;
  const imageRows = collectImageRows(sessionId, freshRaw);
  const fresh = freshRaw.map(persistableMsg);
  const now = Date.now();
  const prev = await db.getSession(sessionId).catch(() => undefined);
  const meta: db.SessionRow = {
    id: sessionId,
    title:
      prev?.title && !isPseudoUserMsg({ role: "user", content: prev.title })
        ? prev.title
        : deriveTitle(msgs),
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
    // msgCount = 下一条待写 seq:库里已有条数 + 本次新增。不能用 msgs.length
    // —— 发生过裁剪/压缩的 run 里 msgs 比全量短,那会让列表条数倒退
    msgCount: baseSeq + freshRaw.length,
    // upsert 会整行覆盖:压缩/token 基线字段必须透传,否则一次保存就丢
    ...(prev?.compaction ? { compaction: prev.compaction } : {}),
    ...(prev?.ctx ? { ctx: prev.ctx } : {}),
  };
  await db.appendMessages(sessionId, meta, fresh, baseSeq, imageRows);
  // 顺带做一次保留期清理(内部自捕获,失败不影响本次保存)
  void pruneExpiredSessions();
}

/** 取单张图片(历史气泡渲染,面板经 GET_IMAGE 消息转发到这里) */
export function loadImage(id: string) {
  return db.getImage(id);
}

/** 会话的压缩元数据与实测 token 基线(run 开始时 agent 组装上下文用) */
export async function loadSessionInfo(
  sessionId: string,
): Promise<{
  compaction?: db.SessionCompaction;
  ctx?: db.SessionCtx;
}> {
  if (!sessionId) return {};
  const row = await db.getSession(sessionId).catch(() => undefined);
  return { compaction: row?.compaction, ctx: row?.ctx };
}

/** 面板用的压缩点(无摘要文本,面板只渲染分隔条);无压缩返回 null */
export async function getCompactionMark(
  sessionId: string,
): Promise<{ uptoSeq: number; at: number } | null> {
  const { compaction } = await loadSessionInfo(sessionId);
  return compaction ? { uptoSeq: compaction.uptoSeq, at: compaction.at } : null;
}

/** 写入压缩元数据(压缩发生在 run 开始,与消息追加解耦) */
export function saveCompaction(
  sessionId: string,
  compaction: db.SessionCompaction,
): Promise<void> {
  return db.saveSessionInfo(sessionId, { compaction });
}

/** 写入实测 token 基线(run 结束,供下次 run 算压缩触发基线) */
export function saveCtx(
  sessionId: string,
  ctx: db.SessionCtx,
): Promise<void> {
  return db.saveSessionInfo(sessionId, { ctx });
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

/**
 * 准备重新生成:找到末条真实 user 行,把「它及其后」的消息行截掉,
 * 还原出可重跑的用户负载(原文 + 图片字节水合)。
 * 截断含 user 行本身:重跑会作为新消息重新落盘,库里不出现重复提问;
 * 技能调用文本带 /name 原样返回,由 agent 侧的技能解析再处理(宽容纪律同首次)。
 * 没有可重跑的轮次返回 null。图片字节从 images store 水合,缺图的张跳过。
 */
export async function prepareRegenerate(
  sessionId: string,
): Promise<UserMessagePayload | null> {
  if (!sessionId) return null;
  const rows = await db.loadMessageRows(sessionId);
  let lastUser: db.MessageRow | undefined;
  for (const row of rows) {
    const m = row.msg as InternalMsg;
    if (
      m &&
      typeof m === "object" &&
      (m as { role?: string }).role === "user" &&
      !isPseudoUserMsg(m)
    ) {
      lastUser = row; // 顺序扫,留最后一个
    }
  }
  if (!lastUser) return null;
  const user = lastUser.msg as Extract<InternalMsg, { role: "user" }>;
  await db.deleteMessagesFrom(sessionId, lastUser.seq);
  const images: NonNullable<UserMessagePayload["images"]> = [];
  for (const im of user.images ?? []) {
    const row = await db.getImage(im.id).catch(() => undefined);
    if (!row) continue; // 字节已被清理:该图跳过,不阻塞重答
    images.push({
      mime: im.mime,
      w: im.w,
      h: im.h,
      base64: bytesToBase64(row.bytes),
    });
  }
  return {
    text: userRequestText(user.content ?? ""),
    sessionId,
    ...(images.length ? { images } : {}),
  };
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

/** 用户 wire content 里的可读文本:content 带 <context>/<user-request> 包裹,
 *  取 <user-request> 内层(旧数据/无包裹则原样)。面板回显与会话标题共用。
 *  包裹模板是 "<user-request>\n…\n</user-request>",内层带首尾换行,
 *  回显是 pre-wrap,不 trim 气泡首尾就会多出空行 */
function userRequestText(content: string): string {
  const inner = content.match(/<user-request>([\s\S]*?)<\/user-request>/);
  return inner ? inner[1].trim() : content;
}

/** 注入型伪消息(<user-memory> / <context-summary>)的 user 角色消息:
 *  只进 prompt 不进历史,但 deriveTitle 拿到的切片数组以它们开头 */
function isPseudoUserMsg(m: InternalMsg): boolean {
  const c = m.content ?? "";
  return c.startsWith("<user-memory>") || c.startsWith("<context-summary>");
}

/** 首条用户消息 → 列表标题(压平空白后截断);跳过注入型伪消息 */
function deriveTitle(msgs: InternalMsg[]): string {
  const first = msgs.find((m) => m.role === "user" && !isPseudoUserMsg(m));
  const text = userRequestText(first?.content ?? "")
    .replace(/\s+/g, " ")
    .trim();
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

/** 持久化形态:剥 reasoning_content + 剥图片字节(字节另行入 images store) */
function persistableMsg(m: InternalMsg): InternalMsg {
  if (m.role === "user" && m.images?.length) {
    return {
      role: "user",
      content: m.content,
      images: m.images.map(({ id, mime, w, h }) => ({ id, mime, w, h })),
    };
  }
  return stripReasoning(m);
}

/** 从待保存的新消息里收集图片字节行(只收带字节的;历史引用没有字节) */
function collectImageRows(
  sessionId: string,
  msgs: InternalMsg[],
): db.ImageRow[] {
  const rows: db.ImageRow[] = [];
  for (const m of msgs) {
    if (m.role !== "user" || !m.images) continue;
    for (const im of m.images) {
      if (im.bytes) {
        rows.push({
          sessionId,
          id: im.id,
          mime: im.mime,
          w: im.w,
          h: im.h,
          bytes: im.bytes,
        });
      }
    }
  }
  return rows;
}

/** 完整 InternalMsg[] → 前端展示用的精简投影(user/assistant 文本 + 图片元信息)。
 *  用户消息解掉 <context>/<user-request> 包裹 —— 气泡回显的应是用户输入的
 *  原文,与实时发送时的本地回显一致;wire 内容只属于发给模型的请求。
 *  seq = 数组下标:seq 是 0 基稠密(loadMessageRows 按 seq 升序返回且无空洞),
 *  压缩分隔条据此定位压缩点 */
export function toChatRecords(msgs: InternalMsg[]): ChatRecord[] {
  const out: ChatRecord[] = [];
  msgs.forEach((m, seq) => {
    if (m.role === "user") {
      out.push({
        role: "user",
        content: userRequestText(m.content),
        seq,
        ...(m.images?.length
          ? { images: m.images.map(({ id, mime, w, h }) => ({ id, mime, w, h })) }
          : {}),
      });
    } else if (m.role === "assistant" && m.content) {
      out.push({ role: "assistant", content: m.content, seq });
    }
    // tool / 空 assistant 不展示
  });
  return out;
}
