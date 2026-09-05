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

export interface AddMemoryOutcome {
  row: MemoryRow;
  /** 已有完全相同文本:未新增,只把原条目提到最近更新 */
  duplicate: boolean;
}

/** 新增一条(两个入口共用):文本收敛空白、限长、精确去重 */
export async function addMemory(
  text: string,
  source: MemoryRow["source"],
): Promise<AddMemoryOutcome> {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) throw new Error("记忆内容不能为空");
  if (clean.length > MEMORY_MAX_CHARS) {
    throw new Error(`记忆需在 ${MEMORY_MAX_CHARS} 字以内(当前 ${clean.length} 字),请浓缩成一句独立成文的事实`);
  }
  const now = Date.now();
  const existing = (await listMemoryRows()).find((r) => r.text === clean);
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
  };
  await putMemoryRow(row);
  log.info("memory", "记忆已保存", { chars: clean.length, source });
  return { row, duplicate: false };
}

export async function updateMemory(
  id: string,
  text: string,
): Promise<MemoryRow> {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) throw new Error("记忆内容不能为空");
  if (clean.length > MEMORY_MAX_CHARS) {
    throw new Error(`记忆需在 ${MEMORY_MAX_CHARS} 字以内(当前 ${clean.length} 字)`);
  }
  const all = await loadMemories();
  const prev = all.find((r) => r.id === id);
  if (!prev) throw new Error("记忆不存在或已删除");
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
  if (!prev) throw new Error("记忆不存在或已删除");
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
  if (!needle) throw new Error("请给出要删除的记忆关键词");
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

/** 渲染注入块文本:头部纪律 + 预算内的条目(前缀「・」),无记忆返回 null。
 *  装填/裁剪策略在 shared/memory.ts 的 planMemoryInjection,与面板估算同源 */
export function renderMemoryBlock(memories: MemoryRow[]): string | null {
  const { kept, dropped } = planMemoryInjection(memories);
  if (kept.length === 0) return null;
  if (dropped.length > 0) {
    log.info("memory", "记忆超出注入预算,已裁剪", {
      kept: kept.length,
      dropped: dropped.length,
    });
  }
  return `${MEMORY_PREAMBLE}\n${kept.map((r) => `・${r.text}`).join("\n")}`;
}

/** 记忆块 → user 角色伪消息:插在 system 之后、压缩摘要之前(记忆比摘要
 *  稳定,缓存前缀更稳);角色用 user,兼容严格端点 —— 同 summaryToMsg */
export function memoryToMsg(block: string): Extract<InternalMsg, { role: "user" }> {
  return {
    role: "user",
    content: `<user-memory>\n${block}\n</user-memory>`,
  };
}
