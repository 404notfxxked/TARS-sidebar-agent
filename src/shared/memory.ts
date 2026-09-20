// 长期记忆的纯函数层:预算、token 粗估、注入规划。
// 面板(设置页/记忆页)与后台(memoryStore)共用;刻意不含任何存储依赖 ——
// 面板不可 import background/memoryStore,那会连带引 sessionDb(只有 SW 碰 IDB)。

/** 单条记忆长度上限(字符):一条应是一句独立成文的事实,不是一段笔记 */
export const MEMORY_MAX_CHARS = 200;

/** 兜底注入预算(粗估 token):contextTokens 未配置时用(现状值,不猜窗口) */
export const MEMORY_BUDGET_TOKENS = 600;

/** 动态注入预算:配置了上下文窗口就按 1% 缩放——记忆是每轮在场的背景层,
 *  占比应稳定而非绝对值稳定。下限 200:小窗用户(如 Ollama 默认 4K)下 600
 *  会占掉 15%;上限 2000(≈40-50 条)是注意力纪律护栏 + agent loop 每个
 *  请求都携带的记忆块的成本乘数。contextTokens=0/缺省 视为未配置 */
export function memoryBudgetTokens(contextTokens?: number): number {
  if (!contextTokens) return MEMORY_BUDGET_TOKENS;
  return Math.min(2000, Math.max(200, Math.round(contextTokens * 0.01)));
}

/** 裁剪尾注:被裁条目模型看不见,「<user-memory> 已有同样信息就别再存」的
 *  工具纪律会失明——注入块尾注明库存,提醒别重复保存 */
export function memoryFooterText(dropped: number): string {
  return `(+${dropped} older ${dropped === 1 ? "entry" : "entries"} not shown)`;
}

/** 尾注的预算预留(三位数条目余量封顶):规划时先扣掉,保证
 *  「头注 + 条目 + 尾注」整体不破预算,而不是尾注加在预算外 */
const MEMORY_FOOTER_RESERVE = estimateTokens(memoryFooterText(999));

/** 记忆粗分类:注入分组/记忆页徽标/二期蒸馏权重(tag 权重+年龄)共用。
 *  定稿依据:ChatGPT 记忆内容实证五类(身份/工作上下文/输出偏好/长期项目/禁则,
 *  归并为 work→project、禁则→preference);health 单列,作「低频但致命」类
 *  条目的关键性代理(蒸馏时永不入选) */
export type MemoryTag =
  | "identity"
  | "preference"
  | "project"
  | "health"
  | "other";

/** 枚举顺序即展示顺序;memory_save 的 schema enum 与面板徽标共用这份清单 */
export const MEMORY_TAGS: MemoryTag[] = [
  "identity",
  "preference",
  "project",
  "health",
  "other",
];

/** 注入块头部:三条使用纪律,专门压「硬关联」——让带记忆 ≠ 用记忆 */
export const MEMORY_PREAMBLE = [
  "Long-term information about the user, kept for background reference:",
  "- Consider it only when relevant to the current question; do not bring it up unasked",
  "- Never mention these notes proactively or force-associate them with unrelated topics",
  "- If irrelevant to the current question, ignore them completely",
].join("\n");

/** 粗估 token:CJK≈1.1 token/字,西文≈4 字符/token。与 agent.estimateTokens
 *  **同源不同形**(那边按 codePointAt 阈值判 CJK,这边只数 \u4e00-\u9fff + 假名,
 *  中文标点落进「÷4」桶)。两份各自服务不同预算,允许漂移,**勿互相「对齐公式」**
 *  —— 改了会静默挪动压缩触发线与记忆注入预算。
 *  单独放一份是为了避免 agent ⇄ memoryStore 循环依赖。 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) if (/[\u4e00-\u9fff\u3040-\u30ff]/.test(ch)) cjk++;
  return Math.ceil(cjk * 1.1 + (text.length - cjk) / 4);
}

export interface MemoryTextLike {
  text: string;
  pinned: boolean;
  updatedAt: number;
  /** 卡片槽位名:有值即卡片态(注入渲染「key: text」,预算裁剪优先于简条;
   *  按 subject+key upsert) */
  key?: string;
  /** 卡片关于谁;缺省即用户本人,注入时非缺省才加前缀 */
  subject?: string;
  /** 粗分类(不进注入行;面板徽标与二期蒸馏权重用) */
  tag?: MemoryTag;
}

/** 卡片态判定:有稳定槽位名 key(简条没有;两种形态同一存储形状) */
export function isMemoryCard(r: Pick<MemoryTextLike, "key">): boolean {
  return typeof r.key === "string" && r.key.length > 0;
}

/** 单条注入行:卡片渲染「(subject) key: text」消歧,简条原文加「・」 */
export function memoryLine(r: MemoryTextLike): string {
  if (!isMemoryCard(r)) return `・${r.text}`;
  const subject = r.subject ? `(${r.subject}) ` : "";
  return `・${subject}${r.key}: ${r.text}`;
}

/** 注入行列表:卡片在前、简条在后,两段都非空才加段头——单一形态不加,
 *  简条用户(存量)的注入块格式与 1.5 改版前保持逐字节一致 */
export function memoryInjectionLines<T extends MemoryTextLike>(
  kept: T[],
): string[] {
  const cards = kept.filter((r) => isMemoryCard(r));
  const notes = kept.filter((r) => !isMemoryCard(r));
  if (cards.length === 0 || notes.length === 0) {
    return [...cards, ...notes].map(memoryLine);
  }
  return [
    "[profile]",
    ...cards.map(memoryLine),
    "[notes]",
    ...notes.map(memoryLine),
  ];
}

/** 面板展示用:按注入规划估算每轮实际携带的 token(含头部纪律、段头与裁剪尾注) */
export function memoryUsedTokens<T extends MemoryTextLike>(
  items: T[],
  contextTokens?: number,
): number {
  const { kept, dropped } = planMemoryInjection(items, contextTokens);
  const body = memoryInjectionLines(kept).reduce(
    (s, l) => s + estimateTokens(l),
    0,
  );
  return (
    estimateTokens(MEMORY_PREAMBLE) +
    body +
    (dropped.length > 0 ? estimateTokens(memoryFooterText(dropped.length)) : 0)
  );
}

/** 注入规划:按 置顶优先 → 卡片优先于简条 → 最近更新优先 把条目装进预算
 *  (预算由 memoryBudgetTokens 按 contextTokens 动态得出),落选的记入
 *  dropped(跳过继续装更小的,与注入语义一致)。后台 renderMemoryBlock 用
 *  kept 出注入文本;面板用 kept/dropped 做「每轮约 X token / 有 N 条未注入」估算 */
export function planMemoryInjection<T extends MemoryTextLike>(
  items: T[],
  contextTokens?: number,
) {
  const sorted = [...items].sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      Number(isMemoryCard(b)) - Number(isMemoryCard(a)) ||
      b.updatedAt - a.updatedAt,
  );
  let budget =
    memoryBudgetTokens(contextTokens) -
    estimateTokens(MEMORY_PREAMBLE) -
    MEMORY_FOOTER_RESERVE;
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const r of sorted) {
    const cost = estimateTokens(memoryLine(r));
    if (budget - cost < 0) {
      dropped.push(r);
      continue;
    }
    budget -= cost;
    kept.push(r);
  }
  return { kept, dropped };
}
