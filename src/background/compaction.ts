// 上下文压缩(第二层):历史占用超过阈值时,把较早的整轮用 LLM 压成结构化
// 摘要,替换进 prompt —— 摘要进上下文,原文留库。第一层「清旧工具结果」
// 见 agent.enforceToolResultBudget(便宜无损),先于本层生效。
// - 只改「发给模型的」,不动「存下来的」:全量历史仍在 IndexedDB,转写完整,
//   压缩点(uptoSeq)存会话行,面板据此渲染分隔条
// - 滚动压缩:再次触发时摘要输入 = 旧摘要 + 增量前缀,摘要本身不无限膨胀
// 与业界对齐:Claude Code(结构化摘要/保留近期原文)、Gemini CLI(阈值比例)、
// Anthropic Context Editing(先清工具结果再摘要的两层策略)

import type { CompactLevel } from "../shared/configStore";
import { createLogger } from "../shared/logger";
import type { ChatProvider, InternalMsg } from "./provider";

const log = createLogger({ ctx: "bg" });

/** 各档位触发阈值:占可用窗口的比例(展示名见 configStore.COMPACT_LABELS) */
export const THRESHOLDS: Record<CompactLevel, number> = {
  early: 0.6,
  standard: 0.75,
  late: 0.9,
};

/** 压缩时保留原文的最近轮数:太少丢近期细节,太多省不出空间 */
const KEEP_TURNS = 4;
/** 撞窗紧急压缩保留的轮数(目标是挤出一次重试的空间,越少越好) */
export const EMERGENCY_KEEP_TURNS = 2;

/** 可用窗口 = contextTokens − maxTokens − 20% 余量,下限 1/4 窗口
 *  (与 trimHistoryForWindow 同一公式 —— 挤出来的空间要接得住下一次回复) */
export function usableTokens(contextTokens: number, maxTokens?: number): number {
  return Math.max(
    contextTokens - (maxTokens ?? 4096) - Math.floor(contextTokens * 0.2),
    Math.floor(contextTokens / 4),
  );
}

/** 触发判定:估算/实测基线超过 档位阈值 × 可用窗口 */
export function shouldCompact(
  baselineTokens: number,
  level: CompactLevel,
  usable: number,
): boolean {
  return baselineTokens > THRESHOLDS[level] * usable;
}

/** 整轮分组:每轮 = 一条 user 起,到下一条 user 前。与 trim 同一单位,
 *  保证 assistant+toolCalls 和它的 tool 观察结果永远在同一侧,不会裁出
 *  「tool 消息悬空」的非法结构 */
function turnStarts(history: InternalMsg[]): number[] {
  const starts: number[] = [];
  history.forEach((m, i) => {
    if (m.role === "user") starts.push(i);
  });
  return starts;
}

/**
 * 选分割点:保留最近几轮原文,其余进摘要。
 * 返回摘要应覆盖的最后一条消息 seq(闭包端点);没什么可压缩的返回 null。
 * 历史不足 keepTurns 轮但确实超窗时,至少压缩第一轮(留最后一轮原文)。
 */
function pickSplit(
  history: InternalMsg[],
  keepTurns = KEEP_TURNS,
): number | null {
  const starts = turnStarts(history);
  if (starts.length < 2) return null;
  const keep = Math.min(keepTurns, starts.length - 1);
  const keptStart = starts[starts.length - keep];
  if (keptStart <= 0) return null;
  return keptStart - 1;
}

// ---- 摘要生成 ----

const SUMMARY_SYSTEM = `你在压缩一段 AI 助手对话的历史记录,产出供后续对话继续使用的上下文摘要。只输出摘要本身,不要任何开场白或解释。要求:
- 用中文,不超过 1200 字
- 必须保留:用户的任务与目标、已完成的操作与结论、关键来源(URL 和要点)、未完成的事项与下一步、用户表达的偏好与约束
- 可以丢弃:寒暄、重复内容、与任务无关的细节
- 用小标题分节,条目化,信息密度优先`;

/** wire 转写:user 消息解掉 <context>/<user-request> 包裹(tab 快照是噪音,
 *  用户输入的原文才是要记的),工具调用带上参数摘要 */
function toTranscript(prefix: InternalMsg[]): string {
  return prefix
    .map((m) => {
      if (m.role === "user") {
        const inner = m.content.match(/<user-request>([\s\S]*?)<\/user-request>/);
        return `[用户] ${inner ? inner[1] : m.content}`;
      }
      if (m.role === "assistant") {
        const calls =
          m.toolCalls
            ?.map((tc) => `[调用 ${tc.name} ${JSON.stringify(tc.args)}]`)
            .join(" ") ?? "";
        return `[助手] ${m.content ?? ""} ${calls}`.trim();
      }
      if (m.role === "tool") return `[工具结果] ${m.content}`;
      return ""; // system 不会出现在前缀里
    })
    .filter(Boolean)
    .join("\n\n");
}

/** 压缩请求的 messages:有旧摘要则合并(滚动压缩),否则直接摘 */
function buildSummaryMessages(
  prevSummary: string,
  prefix: InternalMsg[],
): InternalMsg[] {
  const transcript = toTranscript(prefix);
  return [
    { role: "system", content: SUMMARY_SYSTEM },
    {
      role: "user",
      content: prevSummary
        ? `<previous_summary>\n${prevSummary}\n</previous_summary>\n\n<new_messages>\n${transcript}\n</new_messages>\n\n请把旧摘要与新消息合并为一份新摘要:旧摘要里仍相关的内容保留,已完成或已失效的内容更新,新消息的关键信息并入。只输出新摘要。`
        : `<conversation>\n${transcript}\n</conversation>\n\n请按系统要求输出这段对话的摘要。`,
    },
  ];
}

/** 摘要文本 → 拼进 prompt 的消息。role 用 user 放在 system 之后 ——
 *  部分严格端点拒绝非首位的 system 消息 */
export function summaryToMsg(
  summary: string,
): Extract<InternalMsg, { role: "user" }> {
  return {
    role: "user",
    content: `<context-summary>\n以下是本会话较早内容的压缩摘要(细节可能省略,需要时可用工具重新获取):\n${summary}\n</context-summary>`,
  };
}

export interface CompactionOutcome {
  /** 新摘要文本(已并入旧摘要,若有) */
  summary: string;
  /** 摘要覆盖的最后一条消息 seq;prompt 保留 history.slice(uptoSeq + 1) */
  uptoSeq: number;
}

/**
 * 执行一次压缩:把 history[0..uptoSeq] 压成摘要。
 * 抛错(不可分割/摘要为空/网络失败/取消)由调用方回退 trim,本层不吞。
 */
export async function compactHistory(
  summarizer: ChatProvider,
  history: InternalMsg[],
  prevSummary: string,
  opts: { keepTurns?: number; signal?: AbortSignal } = {},
): Promise<CompactionOutcome> {
  const uptoSeq = pickSplit(history, opts.keepTurns);
  if (uptoSeq === null) throw new Error("history 没有可压缩的整轮");
  const prefix = history.slice(0, uptoSeq + 1);
  const startedAt = Date.now();
  const result = await summarizer.chat({
    messages: buildSummaryMessages(prevSummary, prefix),
    onDelta: () => {}, // 摘要不进聊天流
    signal: opts.signal,
  });
  const summary = result.content.trim();
  if (!summary) throw new Error("模型返回了空摘要");
  log.info("compact", "摘要完成", {
    uptoSeq,
    srcMsgs: prefix.length,
    chars: summary.length,
    ms: Date.now() - startedAt,
    rolling: prevSummary.length > 0,
  });
  return { summary, uptoSeq };
}

/** 识别「超上下文窗口」类错误(各家文案取并集,撞窗重试用) */
export function isContextOverflow(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /context[._ ]?length|maximum context length|prompt is too long|input (is )?too long|too many (input )?tokens|tokens? exceed/i.test(
    msg,
  );
}
