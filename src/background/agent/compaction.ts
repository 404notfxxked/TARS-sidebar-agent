// 上下文压缩(第二层):历史占用超过阈值时,把较早的整轮用 LLM 压成结构化
// 摘要,替换进 prompt —— 摘要进上下文,原文留库。第一层「清旧工具结果」
// 见 agent.enforceToolResultBudget(便宜无损),先于本层生效。
// - 只改「发给模型的」,不动「存下来的」:全量历史仍在 IndexedDB,转写完整,
//   压缩点(uptoSeq)存会话行,面板据此渲染分隔条
// - 滚动压缩:再次触发时摘要输入 = 旧摘要 + 增量前缀,摘要本身不无限膨胀
// 与业界对齐:Claude Code(结构化摘要/保留近期原文)、Gemini CLI(阈值比例)、
// Anthropic Context Editing(先清工具结果再摘要的两层策略)

import type { CompactLevel } from "../../shared/configStore";
import { createLogger } from "../../shared/logger";
import type { ChatProvider, InternalMsg } from "../provider";

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

/** 系统注记 user 消息前缀(agent 循环给截图等工具附件用的注入文本)。
 *  这类消息是前一个工具轮的附件,不是新的一轮 —— 切分时必须算作延续,
 *  否则会把 assistant+toolCalls 和它的观察结果劈到摘要两侧 */
export const SYSTEM_NOTE_PREFIX = "[System note:";

/** 整轮分组:每轮 = 一条 user 起,到下一条 user 前。与 trim 同一单位,
 *  保证 assistant+toolCalls 和它的 tool 观察结果永远在同一侧,不会裁出
 *  「tool 消息悬空」的非法结构。系统注记(截图附件)不算轮起点 */
function turnStarts(history: InternalMsg[]): number[] {
  const starts: number[] = [];
  history.forEach((m, i) => {
    if (m.role === "user" && !m.content.startsWith(SYSTEM_NOTE_PREFIX)) {
      starts.push(i);
    }
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

const SUMMARY_SYSTEM = `You compress the history of an AI assistant conversation into a context summary that later turns will rely on. Output only the summary — no preamble, no explanation. Requirements:
- Write in the conversation's language, at most 900 words
- Must keep: the user's task and goal, actions taken and conclusions so far, key sources (URLs and key points), open items and next steps, preferences and constraints the user expressed, failed attempts and what went wrong (so they are not retried)
- May drop: pleasantries, repetition, details unrelated to the task
- Use section headings and bullet items; favor information density`;

/** 转写预算:tool 结果是转写里唯一无上界的部分(一次 page_read 窗口最大
 *  2 万字符,长研究会话轻松堆出几十万字符)。转写本身超出 summarizer 的
 *  窗口会让压缩请求整体 400,压缩静默回落 trim —— 「长会话不失忆」失明。
 *  超预算从最旧的 tool 正文开始打桩:丢的是陈旧页面原文(结论已在
 *  assistant 行里),user/assistant 行承载任务语义,保留全文 */
export const TRANSCRIPT_BUDGET_CHARS = 120_000;

/** wire 转写:user 消息解掉 <context>/<user-request> 包裹(tab 快照是噪音,
 *  用户输入的原文才是要记的),工具调用带上参数摘要 */
export function toTranscript(prefix: InternalMsg[]): string {
  const lines = prefix.map((m) => {
    if (m.role === "user") {
      const inner = m.content.match(/<user-request>([\s\S]*?)<\/user-request>/);
      return { text: `[user] ${inner ? inner[1] : m.content}`, toolChars: -1 };
    }
    if (m.role === "assistant") {
      const calls =
        m.toolCalls
          ?.map((tc) => `[call ${tc.name} ${JSON.stringify(tc.args)}]`)
          .join(" ") ?? "";
      return {
        text: `[assistant] ${m.content ?? ""} ${calls}`.trim(),
        toolChars: -1,
      };
    }
    if (m.role === "tool") {
      // toolChars = 正文字符数;≥ 0 标记该行超预算时可打桩
      return { text: `[tool result] ${m.content}`, toolChars: m.content.length };
    }
    return { text: "", toolChars: -1 }; // system 不会出现在前缀里
  });

  // 从最新往回累计预算;放不下的更旧 tool 正文打桩(保留行结构,
  // summarizer 仍知道「这里有过一次工具调用及其体量」)。
  // 严格预算:某条放不下就打桩,转写总量才有上界 —— 保证压缩请求
  // 本身不再撞 summarizer 的窗口
  let remaining = TRANSCRIPT_BUDGET_CHARS;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.toolChars < 0) continue; // user/assistant 行不打桩
    if (line.toolChars > remaining) {
      line.text = `[tool result omitted — ${line.toolChars} chars of stale page/fetch content; conclusions from it are kept in the assistant turns above]`;
    } else {
      remaining -= line.toolChars;
    }
  }

  return lines
    .map((l) => l.text)
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
        ? `<previous_summary>\n${prevSummary}\n</previous_summary>\n\n<new_messages>\n${transcript}\n</new_messages>\n\nMerge the previous summary and the new messages into one updated summary: keep still-relevant content from the previous summary, update or drop completed / outdated items, fold in key information from the new messages. Output only the new summary.`
        : `<conversation>\n${transcript}\n</conversation>\n\nSummarize this conversation per the system instructions.`,
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
    content: `<context-summary>\nCompressed summary of earlier parts of this conversation (details may be omitted; re-fetch with tools when needed):\n${summary}\n</context-summary>`,
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
