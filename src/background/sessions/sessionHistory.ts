// 会话历史:IndexedDB 持久化,多会话各自隔离
// - 后台 SW 是唯一读写方,面板经 LOAD_HISTORY / LIST_SESSIONS 等消息间接访问
// - 写入是「基线追加」:run 开始时记下历史长度,结束时只落新增的消息,
//   上下文溢出裁剪只影响本轮 prompt、不写回 —— 落盘永远是全量历史
// - 保留期:默认只留最近 7 天(按最后活跃算),懒清理(启动 + 每次保存后),
//   0 = 全部保留。数据短命是有意为之:IndexedDB 会被用户的「清除浏览数据」
//   连带清掉、磁盘紧张时可能被驱逐,当历史被当作可丢弃数据时这些都不再致命
// - 首次启动把旧版 chrome.storage.session 里的 history:* 一次性搬进来

import { SYSTEM_NOTE_PREFIX } from "../agent/compaction";
import type { InternalMsg } from "../provider/types";
import type {
  ChatRecord,
  ProcessItem,
  SessionMeta,
  UserMessagePayload,
} from "../../shared/messages";
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
    return rows.map((r, i) => {
      const m = r.msg as InternalMsg | null | undefined;
      if (m && typeof m === "object" && "role" in (m as object)) return m;
      // 损坏行不能跳过:数组下标 = seq 是压缩点、持久化锚点与追加 baseSeq
      // 的共同地基,跳一行会让 baseSeq 回退、覆写既有 seq(数据损坏放大)。
      // 替换为 error 占位行保序 —— error 行不回灌 prompt(loadTranscript 滤除),
      // 回放渲染为错误气泡,损坏可见而非静默
      log.warn("agent", "unreadable message row replaced", {
        sessionId,
        seq: r.seq ?? i,
      });
      return {
        role: "assistant",
        content: "[此消息行数据损坏,已替换为占位]",
        error: true,
      } as InternalMsg;
    });
  } catch (err) {
    log.warn("agent", "load history failed", {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** 组装 prompt 用的历史:与落盘同源,但两处口径收窄 ——
 *  ①滤掉失败轮错误行:错误文本不是模型说过的话,回灌会污染上下文;
 *  ②最终回答行剥离 reasoning_content:思考对 API 没有回传价值,剥掉把
 *    「未知字段」暴露面收到最小;带 toolCalls 的行保留 —— DeepSeek 新版
 *    thinking 模式要求 reasoning_content 随 tools 回传(缺失 400,见
 *    api-docs.deepseek.com/guides/thinking_mode),且 run 内内存直用的
 *    wire(openai.ts toWireMessages)本就带此字段,跨 run 与 run 内口径
 *    一致;严格网关若拒收未知字段,run 内第二轮同样会炸,非跨 run 新增
 *    风险(审计 2026-09-18 C 的冲突由此收口)。
 *  回放投影(toChatRecords)包含错误行,两层口径不同是有意设计 */
export async function loadTranscript(sessionId: string): Promise<InternalMsg[]> {
  const msgs = await loadHistory(sessionId);
  return msgs
    .filter((m) => !(m.role === "assistant" && m.error))
    .map((m) => {
      if (m.role !== "assistant") return m;
      // 带 toolCalls 的行原样回传(含 reasoning_content);最终回答行重建对象
      // 以彻底去掉 reasoning_content 键(undefined 值可能被存储层保留)
      if (m.toolCalls?.length) return m;
      if (m.reasoning_content === undefined) return m;
      return {
        role: "assistant",
        content: m.content,
        ...(m.model ? { model: m.model } : {}),
        ...(m.error ? { error: m.error } : {}),
      };
    });
}

/** 追加保存:只落本轮新增的消息。
 *  - msgs:本轮结束时的完整领域消息(不含 system,调用方已 slice(1))
 *  - fromIdx:msgs 里第一条「本轮新增」的下标。无裁剪时 = 已落盘条数;
 *    发生过溢出裁剪时更小(最早几轮已从内存丢弃,但库里仍存着全量 ——
 *    裁剪只影响本轮 prompt,不写回,落盘永远是全量历史)
 *  - baseSeq:该会话在库里的已有条数,即新消息的起始 seq
 *  落盘前剥离图片字节(进 images store,消息行只留引用);思考内容
 *  (reasoning_content)自 2026-09 起全量落盘作回放展示元数据,回灌 prompt
 *  前在 loadTranscript 处剥离。写失败由调用方兜底,不打断回答。 */
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
  // 思考落盘计量:只记 turns 与字节数,不记原文(诊断导出判据,硬规则 12)。
  // 用于评估全量落盘的真实存储分布(2026-09-18 决策:全量落盘试运行);
  // 日志按类 400 条环形淘汰,重用会滚掉更早的条目
  const reasoningTurns = freshRaw.filter(
    (m): m is Extract<InternalMsg, { role: "assistant" }> =>
      m.role === "assistant" && !!m.reasoning_content,
  );
  if (reasoningTurns.length > 0) {
    const enc = new TextEncoder();
    log.info("bg", "思考内容落盘", {
      turns: reasoningTurns.length,
      bytes: reasoningTurns.reduce(
        (sum, m) => sum + enc.encode(m.reasoning_content ?? "").length,
        0,
      ),
    });
  }
  const now = Date.now();
  const prev = await db.getSession(sessionId).catch(() => undefined);
  // 可见条数增量维护:新会话从 0 起步;旧版本会话行没有该字段时全量扫一次
  // 作为基线(此后每轮追加都是增量,7 天短命数据很快自愈)
  const freshVisible = freshRaw.filter((m) => isVisibleBubbleMsg(m)).length;
  const visibleBase = prev
    ? (prev.visibleCount ?? (await displayRowCount(sessionId)))
    : 0;
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
    visibleCount: visibleBase + freshVisible,
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

/** 会话列表,最近活跃在前。msgCount 口径 = 用户可见的气泡数(真实提问 +
 *  有正文的回答;tool/注记/processOnly 纯过程行不计 —— 过程行在回放里是
 *  折叠卡不是气泡)。展示条数走会话行上的增量缓存(visibleCount,保存/截断
 *  时维护),不逐会话读消息行;缓存缺省(旧版本行)才回落单会话扫描一次,
 *  并把结果回填进缓存 —— 否则每次开列表都对同一批存量会话重扫 */
export async function listSessions(): Promise<SessionMeta[]> {
  const rows = await db.listSessions();
  const out: SessionMeta[] = [];
  for (const row of rows) {
    let msgCount = row.visibleCount;
    if (msgCount === undefined) {
      msgCount = await displayRowCount(row.id);
      // 回填缓存(旧版本行的一次性迁移),失败不影响列表:下次开列表再扫
      await db.patchVisibleCount(row.id, msgCount).catch(() => {});
    }
    out.push({
      id: row.id,
      title: row.title,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      msgCount,
    });
  }
  return out;
}

/** 用户可见气泡口径(列表「N 条」与回放气泡同源):真实提问 + 有正文且
 *  不带工具调用的回答(工具轮的中间文案在回放里是过程卡内文案,不是气泡);
 *  错误占位行照计(回放渲染为错误气泡) */
function isVisibleBubbleMsg(m: InternalMsg): boolean {
  if (m.role === "user") return !isPseudoUserMsg(m);
  if (m.role === "assistant") {
    if (m.error) return true;
    return !!m.content && !m.toolCalls?.length;
  }
  return false;
}

/** 单会话的用户可见消息数;读取失败按 0(列表不为它打断)。
 *  只作 visibleCount 缓存缺省时的回落扫描(旧版本会话行) */
async function displayRowCount(sessionId: string): Promise<number> {
  try {
    const rows = await db.loadMessageRows(sessionId);
    return rows.filter((r) => {
      const m = r.msg as InternalMsg;
      return !!m && typeof m === "object" && isVisibleBubbleMsg(m);
    }).length;
  } catch {
    return 0;
  }
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
  // 截断段可见气泡数(列表条数缓存同步扣减)与图片字节先于截断处理:
  // 级联删除会清掉截断段引用的图片行(含本条 user 自己的),必须先水合
  const doomed = rows.filter((r) => r.seq >= lastUser.seq);
  const visibleDelta = doomed.filter((r) => {
    const m = r.msg as InternalMsg;
    return !!m && typeof m === "object" && isVisibleBubbleMsg(m);
  }).length;
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
  await db.deleteMessagesFrom(sessionId, lastUser.seq, visibleDelta);
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

/** 注入型伪 user 消息:<user-memory>/<context-summary> 只进 prompt 不进
 *  历史;截图系统注记(SYSTEM_NOTE_PREFIX)则全量落盘 —— 三者都不是用户
 *  提问:标题推导跳过、重新生成的截断点跳过、面板投影标 synthetic */
function isPseudoUserMsg(m: InternalMsg): boolean {
  const c = m.content ?? "";
  return (
    c.startsWith("<user-memory>") ||
    c.startsWith("<context-summary>") ||
    c.startsWith(SYSTEM_NOTE_PREFIX)
  );
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

/** 持久化形态:剥图片字节(另行入 images store);reasoning_content 全量
 *  保留(prompt 侧剥离在 loadTranscript,见彼处注释) */
function persistableMsg(m: InternalMsg): InternalMsg {
  if (m.role === "user" && m.images?.length) {
    return {
      role: "user",
      content: m.content,
      images: m.images.map(({ id, mime, w, h }) => ({ id, mime, w, h })),
    };
  }
  return m;
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

/** 工具结果在回放投影里的单条字符上限:与实况单条工具结果同量级,超出截断
 *  并标注体量(硬规则 8 同款纪律)。截断只影响投影,库里仍全量 */
const PROCESS_RESULT_CAP_CHARS = 12_000;

/** 完整 InternalMsg[] → 前端展示用的精简投影(user/assistant 文本 + 图片元信息)。
 *  用户消息解掉 <context>/<user-request> 包裹 —— 气泡回显的应是用户输入的
 *  原文,与实时发送时的本地回显一致;wire 内容只属于发给模型的请求。
 *  run 内的过程数据(思考/中间文案/工具调用+结果)按 seq 顺序聚成
 *  processItems,挂在收尾记录(回答/error)上;没有收尾记录的 run(取消/
 *  SW 被杀)由 processOnly 载体行独立成卡 —— 回放过程卡才能与实况过程卡
 *  看到同一批步骤(曾因投影跳过空正文 assistant 行,工具轮思考全部丢失)。
 *  seq = 数组下标:seq 是 0 基稠密(loadMessageRows 按 seq 升序返回且无空洞),
 *  压缩分隔条据此定位压缩点 */
export function toChatRecords(msgs: InternalMsg[]): ChatRecord[] {
  const out: ChatRecord[] = [];
  /** 当前 run(自上一条真实 user 起)累积的过程项;收尾时挂载 */
  let pending: ProcessItem[] = [];
  let lastSeq = 0;
  // 收尾记录缺席:过程数据出载体行(不是气泡,不计列表条数)
  const flushCarrier = () => {
    if (pending.length === 0) return;
    out.push({
      role: "assistant",
      content: "",
      seq: lastSeq,
      processOnly: true,
      processItems: pending,
    });
    pending = [];
  };
  msgs.forEach((m, seq) => {
    lastSeq = seq;
    if (m.role === "user") {
      // 截图注记:标 synthetic 照常投影(面板不作真实用户气泡渲染),
      // 但它是 run 内的附件延续 —— 不打断过程归组
      if (isPseudoUserMsg(m)) {
        out.push({
          role: "user",
          content: userRequestText(m.content),
          seq,
          synthetic: true,
          ...(m.images?.length
            ? { images: m.images.map(({ id, mime, w, h }) => ({ id, mime, w, h })) }
            : {}),
        });
        return;
      }
      flushCarrier();
      out.push({
        role: "user",
        content: userRequestText(m.content),
        seq,
        ...(m.images?.length
          ? { images: m.images.map(({ id, mime, w, h }) => ({ id, mime, w, h })) }
          : {}),
      });
      return;
    }
    if (m.role === "tool") {
      // 回填最近一次同名配对的工具项(结果按 toolCallId 对应)
      const item = [...pending]
        .reverse()
        .find((p): p is Extract<ProcessItem, { kind: "tool" }> =>
          p.kind === "tool" && p.id === m.toolCallId);
      if (item) {
        item.error = m.content.startsWith("Error: ");
        item.result =
          m.content.length > PROCESS_RESULT_CAP_CHARS
            ? `${m.content.slice(0, PROCESS_RESULT_CAP_CHARS)}\n[回放截断:共 ${m.content.length} 字符]`
            : m.content;
      }
      return;
    }
    if (m.role !== "assistant") return;
    if (m.error) {
      const items = pending;
      pending = [];
      out.push({
        role: "assistant",
        content: m.content ?? "",
        seq,
        error: true,
        ...(items.length ? { processItems: items } : {}),
      });
      return;
    }
    if (m.toolCalls?.length) {
      // 工具轮:思考 → 中间文案 → 工具调用,与实况段的到达顺序一致
      if (m.reasoning_content) {
        pending.push({ kind: "reasoning", text: m.reasoning_content });
      }
      if (m.content?.trim()) pending.push({ kind: "text", text: m.content });
      for (const tc of m.toolCalls) {
        pending.push({ kind: "tool", id: tc.id, name: tc.name, args: tc.args });
      }
      return;
    }
    if (m.content) {
      // 最终回答:思考进卡,答案气泡留在卡外(与实况 settled 布局一致)
      const items = pending;
      pending = [];
      if (m.reasoning_content) items.push({ kind: "reasoning", text: m.reasoning_content });
      out.push({
        role: "assistant",
        content: m.content,
        seq,
        ...(items.length ? { processItems: items } : {}),
      });
    }
    // 无正文也无思考的空 assistant 不展示
  });
  flushCarrier();
  return out;
}
