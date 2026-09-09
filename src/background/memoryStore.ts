// 长期记忆领域层:跨会话记住用户偏好/事实,一行一条存 IndexedDB(db "tars"
// 的 memories store,经 sessionDb 的底层函数访问)。
//
// 设计要点(与 compaction 同构的「虚拟注入」原则):
// - 记忆只在组装 prompt 时投影成一条 user 伪消息(<user-memory> 包裹),
//   不写入任何会话的消息历史 —— 持久化锚点 persistedInCtx 从尾部计数,不受影响
// - 注入预算封顶:超预算按 置顶优先 → 最近更新优先 裁剪(预算/粗估/规划在
//   shared/memory.ts,与面板共用同一套估算)
// - 保存入口两条:模型经 memory_save 工具(少而精,description 里约束)、
//   用户在记忆页手动添加 —— 都走 addMemory 做 校验/去重

import { createLogger } from "../shared/logger";
import {
  MEMORY_MAX_CHARS,
  MEMORY_PREAMBLE,
  type MemoryTag,
  isMemoryCard,
  memoryFooterText,
  memoryInjectionLines,
  planMemoryInjection,
} from "../shared/memory";
import type { InternalMsg } from "./provider/types";
import type { MemoryRow } from "./sessionDb";
import {
  clearMemoryRows,
  deleteMemoryRow,
  listMemoryRows,
  putMemoryRow,
} from "./sessionDb";

const log = createLogger({ ctx: "bg" });

/** 全部记忆,注入顺序排序:置顶在前,其余按最近更新优先 */
export async function loadMemories(): Promise<MemoryRow[]> {
  const rows = await listMemoryRows();
  return rows.sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt,
  );
}

export interface AddMemoryOptions {
  /** 卡片槽位名:有值即卡片态,按 (subject,key) upsert——同槽位覆盖旧值 */
  key?: string;
  /** 卡片关于谁;缺省即用户本人 */
  subject?: string;
  tag?: MemoryTag;
  /** 替换目标条目 id:只换文本,其余字段不动。模型侧纪律:仅限
   *  <user-memory> 里可见的条目——看不见的条目谈不上裁决(mem0 v2 教训) */
  replaceOf?: string;
}

export interface AddMemoryOutcome {
  row: MemoryRow;
  /** 规范化后与现有内容相同:未新增,只把原条目提到最近更新 */
  duplicate: boolean;
  /** 卡片 upsert 命中:同 (subject,key) 槽位被本条覆盖 */
  upserted?: boolean;
  /** replaceOf 命中:指定条目的文本被替换 */
  replaced?: boolean;
}

/** 收敛空白 + 限长(两个写入口共用;清空报错,超长提示收敛成一句) */
function cleanMemoryText(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) throw new Error("Memory content is empty");
  if (clean.length > MEMORY_MAX_CHARS) {
    throw new Error(
      `Memory must be at most ${MEMORY_MAX_CHARS} characters (got ${clean.length}); condense it into one self-contained sentence`,
    );
  }
  return clean;
}

/** 去重用规范化:小写 + 去标点/符号 + 收敛空白——「不吃香菜」与
 *  「不吃,香菜」「不吃 香菜」视为同文(比较用,不改变存入文本) */
function normalizeForDedup(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 新增一条(模型工具/面板手填共用):
 *  - replaceOf → 替换指定条目文本;
 *  - key → 卡片态,按 (subject,key) upsert,值变化记冲突日志(冲突计数是
 *    二期温层蒸馏的触发信号之一);
 *  - 其余 → 简条,规范化去重后新增 */
export async function addMemory(
  text: string,
  source: MemoryRow["source"],
  opts: AddMemoryOptions = {},
): Promise<AddMemoryOutcome> {
  const clean = cleanMemoryText(text);
  const now = Date.now();
  const all = await listMemoryRows();

  if (opts.replaceOf) {
    const prev = all.find((r) => r.id === opts.replaceOf);
    if (!prev) throw new Error("Memory to replace not found or already deleted");
    const row: MemoryRow = { ...prev, text: clean, updatedAt: now };
    await putMemoryRow(row);
    log.info("memory", "记忆已替换", { id: row.id, old: prev.text });
    return { row, duplicate: false, replaced: true };
  }

  if (opts.key) {
    const key = opts.key.trim();
    const subject = opts.subject?.replace(/\s+/g, " ").trim() || undefined;
    const prev = all.find(
      (r) =>
        isMemoryCard(r) &&
        r.key === key &&
        (r.subject ?? "user") === (subject ?? "user"),
    );
    if (prev) {
      const conflict =
        normalizeForDedup(prev.text) !== normalizeForDedup(clean);
      const row: MemoryRow = {
        ...prev,
        text: clean,
        subject,
        tag: opts.tag ?? prev.tag,
        updatedAt: now,
      };
      await putMemoryRow(row);
      log.info("memory", conflict ? "记忆卡片覆盖旧值(冲突)" : "记忆卡片同值刷新", {
        key,
        old: prev.text,
      });
      return { row, duplicate: !conflict, upserted: true };
    }
    const row: MemoryRow = {
      id: crypto.randomUUID(),
      text: clean,
      createdAt: now,
      updatedAt: now,
      pinned: false,
      source,
      key,
      subject,
      tag: opts.tag,
    };
    await putMemoryRow(row);
    log.info("memory", "记忆卡片已保存", { chars: clean.length, key, source });
    return { row, duplicate: false };
  }

  const norm = normalizeForDedup(clean);
  const existing = all.find((r) => normalizeForDedup(r.text) === norm);
  if (existing) {
    const row = { ...existing, updatedAt: now };
    await putMemoryRow(row);
    log.info("memory", "记忆重复,已刷新原条目", { duplicate: true });
    return { row, duplicate: true };
  }
  const row: MemoryRow = {
    id: crypto.randomUUID(),
    text: clean,
    createdAt: now,
    updatedAt: now,
    pinned: false,
    source,
    tag: opts.tag,
  };
  await putMemoryRow(row);
  log.info("memory", "记忆已保存", { chars: clean.length, source });
  return { row, duplicate: false };
}

export async function updateMemory(
  id: string,
  text: string,
): Promise<MemoryRow> {
  const clean = cleanMemoryText(text);
  const all = await loadMemories();
  const prev = all.find((r) => r.id === id);
  if (!prev) throw new Error("Memory not found or already deleted");
  const row = { ...prev, text: clean, updatedAt: Date.now() };
  await putMemoryRow(row);
  log.info("memory", "记忆已更新", { chars: clean.length });
  return row;
}

export async function setMemoryPinned(
  id: string,
  pinned: boolean,
): Promise<void> {
  const all = await loadMemories();
  const prev = all.find((r) => r.id === id);
  if (!prev) throw new Error("Memory not found or already deleted");
  await putMemoryRow({ ...prev, pinned, updatedAt: prev.updatedAt });
  log.info("memory", pinned ? "记忆已置顶" : "记忆已取消置顶", {});
}

/** 按 id 删除(设置页入口) */
export async function deleteMemoryById(id: string): Promise<void> {
  await deleteMemoryRow(id);
  log.info("memory", "记忆已删除", {});
}

/** 按子串删除(模型工具入口):删掉所有 text 含 match 的条目,回报删了什么 */
export async function deleteMemoriesByMatch(
  match: string,
): Promise<{ count: number; deleted: string[] }> {
  const needle = match.replace(/\s+/g, " ").trim().toLowerCase();
  if (!needle) throw new Error("Provide a keyword to match memories for deletion");
  const all = await loadMemories();
  const hits = all.filter((r) => r.text.toLowerCase().includes(needle));
  for (const r of hits) await deleteMemoryRow(r.id);
  log.info("memory", "记忆按匹配删除", { count: hits.length });
  return { count: hits.length, deleted: hits.map((r) => r.text) };
}

export async function clearMemories(): Promise<void> {
  await clearMemoryRows();
  log.info("memory", "记忆已全部清空", {});
}

/** 渲染注入块文本:头部纪律 + 注入行(卡片在前简条在后,混合时带段头)+
 *  裁剪尾注(有条目被裁时),无记忆返回 null。装填/裁剪策略在
 *  shared/memory.ts 的 planMemoryInjection,与面板估算同源 */
export function renderMemoryBlock(
  memories: MemoryRow[],
  contextTokens?: number,
): string | null {
  const { kept, dropped } = planMemoryInjection(memories, contextTokens);
  if (kept.length === 0) return null;
  if (dropped.length > 0) {
    log.info("memory", "记忆超出注入预算,已裁剪", {
      kept: kept.length,
      dropped: dropped.length,
    });
  }
  const lines = memoryInjectionLines(kept);
  if (dropped.length > 0) lines.push(memoryFooterText(dropped.length));
  return `${MEMORY_PREAMBLE}\n${lines.join("\n")}`;
}

/** 记忆块 → user 角色伪消息:插在 system 之后、压缩摘要之前(记忆比摘要
 *  稳定,缓存前缀更稳);角色用 user,兼容严格端点 —— 同 summaryToMsg */
export function memoryToMsg(block: string): Extract<InternalMsg, { role: "user" }> {
  return {
    role: "user",
    content: `<user-memory>\n${block}\n</user-memory>`,
  };
}
