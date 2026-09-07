// 长期记忆的纯函数层:预算常量、token 粗估、注入规划。
// 面板(设置页/记忆页)与后台(memoryStore)共用;刻意不含任何存储依赖 ——
// 面板不可 import background/memoryStore,那会连带引 sessionDb(只有 SW 碰 IDB)。

/** 单条记忆长度上限(字符):一条应是一句独立成文的事实,不是一段笔记 */
export const MEMORY_MAX_CHARS = 200;

/** 注入预算(粗估 token):记忆块整体超过就按优先级裁剪 */
export const MEMORY_BUDGET_TOKENS = 600;

/** 注入块头部:三条使用纪律,专门压「硬关联」——让带记忆 ≠ 用记忆 */
export const MEMORY_PREAMBLE = [
  "Long-term information about the user, kept for background reference:",
  "- Consider it only when relevant to the current question; do not bring it up unasked",
  "- Never mention these notes proactively or force-associate them with unrelated topics",
  "- If irrelevant to the current question, ignore them completely",
].join("\n");

/** 粗估 token:CJK≈1.1 token/字,西文≈4 字符/token(与 agent.estimateTokens
 *  同公式;单独放一份避免 agent ⇄ memoryStore 循环依赖) */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) if (/[\u4e00-\u9fff\u3040-\u30ff]/.test(ch)) cjk++;
  return Math.ceil(cjk * 1.1 + (text.length - cjk) / 4);
}

export interface MemoryTextLike {
  text: string;
  pinned: boolean;
  updatedAt: number;
}

/** 面板展示用:按注入规划估算每轮实际携带的 token(含头部纪律开销) */
export function memoryUsedTokens<T extends MemoryTextLike>(items: T[]): number {
  const { kept } = planMemoryInjection(items);
  return (
    estimateTokens(MEMORY_PREAMBLE) +
    kept.reduce((s, r) => s + estimateTokens(`・${r.text}`), 0)
  );
}

/** 注入规划:按 置顶优先 → 最近更新优先 把条目装进预算,落选的记入 dropped
 *  (跳过继续装更小的,与注入语义一致)。后台 renderMemoryBlock 用 kept 出
 *  注入文本;面板用 kept/dropped 做「每轮约 X token / 有 N 条未注入」估算 */
export function planMemoryInjection<T extends MemoryTextLike>(items: T[]) {
  const sorted = [...items].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt,
  );
  let budget = MEMORY_BUDGET_TOKENS - estimateTokens(MEMORY_PREAMBLE);
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const r of sorted) {
    const cost = estimateTokens(`・${r.text}`);
    if (budget - cost < 0) {
      dropped.push(r);
      continue;
    }
    budget -= cost;
    kept.push(r);
  }
  return { kept, dropped };
}
