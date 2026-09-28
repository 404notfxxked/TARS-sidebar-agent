// token 估算与上下文窗口防护:压缩触发基线(baseline/usable)、溢出裁剪、
// run 内工具结果预算共用这一套量级估算。精确记账不在目标内(见下)。

import {
  isTurnStart,
  usableTokens,
} from "./compaction";
import type { InternalMsg } from "../provider";
import { createLogger } from "../../shared/logger";

const log = createLogger({ ctx: "bg" });

// 每张图片的 token 估值(detail auto、1600px 长边压缩后约 3~4 个 512px 块,
// 宁可高估防超窗);随请求发送的字节预算与上下文窗口估算都靠它兜底
export const IMAGE_TOKEN_ESTIMATE = 1500;

// ---- 工具结果预算(run 内) ----
// trimHistoryForWindow 只在 run 开始时裁剪历史;run 内部持续增长的工具结果
// (网页窗口最多 20k 字符/次)靠这里限流:总字符超预算时,从最旧的大结果开始
// 替换为省略标记。只改 tool 消息的 content、不动 toolCallId —— 消息结构保持
// 合法,且这些内容模型都已消费过;截断会破坏 prompt cache 前缀,可接受
// (不截断的代价是直接撞上下文上限 400)。
const TOOL_RESULT_STUB =
  "\n[此前的工具结果已因长度限制省略,如仍需要请重新调用工具获取]";
const TOOL_RESULT_KEEP_CHARS = 1_500;

export function enforceToolResultBudget(messages: InternalMsg[], budgetChars: number): void {
  const totalChars = () =>
    messages.reduce((n, m) => (m.role === "tool" ? n + m.content.length : n), 0);
  if (totalChars() <= budgetChars) return;
  // 最新一条 tool 消息保留不截(模型下一步就要读它)—— 但单条自身超预算时
  // 例外:不截的话一条超大 MCP 结果就能让整个预算机制失效,请求体量失控。
  // 按预算半数截断保留头部,注记里声明原始体量,模型需要时可重新调用
  let lastToolIdx = -1;
  messages.forEach((m, i) => {
    if (m.role === "tool") lastToolIdx = i;
  });
  const lastTool = messages[lastToolIdx];
  if (lastTool?.role === "tool" && lastTool.content.length > budgetChars) {
    lastTool.content =
      lastTool.content.slice(0, Math.floor(budgetChars / 2)) +
      `\n[此工具结果过长(共 ${lastTool.content.length} 字符)已截断,如仍需要请分页/重新调用]`;
  }
  let truncated = 0;
  for (let i = 0; i < lastToolIdx && totalChars() > budgetChars; i++) {
    const m = messages[i];
    if (m.role !== "tool" || m.content.length <= TOOL_RESULT_KEEP_CHARS) continue;
    m.content = m.content.slice(0, TOOL_RESULT_KEEP_CHARS) + TOOL_RESULT_STUB;
    truncated++;
  }
  if (truncated > 0) {
    log.warn("agent", "工具结果超出预算,已截断最旧的结果", {
      truncated,
      totalChars: totalChars(),
      budgetChars,
    });
  }
}

// ---- 上下文溢出防护(轻量) ----
// 仅当模型条目配了 contextTokens 时生效;目标是挡住「长历史 + 小窗模型」时
// 必现的 400,不求精确 —— token 只做量级估算,精确记账等将来真需要时再引入。
// 丢弃单位是「整轮对话」(一条 user 起,到下一条 user 前):保证留下的 tool
// 消息总和它的 assistant 配对在同一轮里,不会裁出非法消息结构。

/** 粗估 token 数:CJK≈1.1 token/字,西文≈4 字符/token,向上取整 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.codePointAt(i)! > 0x2e7f) cjk++;
  }
  return Math.ceil(cjk * 1.1 + (text.length - cjk) / 4);
}

/** 消息的估量文本:assistant 的工具调用参数(JSON)也计入 */
export function messageText(m: InternalMsg): string {
  if (m.role === "assistant") {
    return (
      (m.content ?? "") + (m.toolCalls ? JSON.stringify(m.toolCalls) : "")
    );
  }
  return m.content; // system / user / tool 的 content 都是字符串
}

/** history[from..] 的 token 估算(图片按固定估值计入,字节本身不进文本
 *  估算,防止 base64 撑爆估算)。压缩触发基线与 trim 共用 */
export function estimateRange(history: InternalMsg[], from: number): number {
  let n = 0;
  for (let i = from; i < history.length; i++) {
    const m = history[i];
    n += estimateTokens(messageText(m));
    if (m.role === "user" && m.images) {
      n += m.images.length * IMAGE_TOKEN_ESTIMATE;
    }
  }
  return n;
}

/** 压缩触发基线:实测部分 + 测量后新增库行的估算 + 固定开销。
 *  ctx.rows = 测量时刻(run 收口)的库总行数:promptTokens 覆盖到当时的
 *  全部历史(压缩会话 = 摘要 + 尾部,普通会话 = 全量),新增部分只有之后
 *  追加的行,按 rows 切与压缩与否无关 —— 旧实现用 prompt 消息条数(msgs)
 *  当切分点,压缩过的会话把摘要已覆盖的行重复计入,基线系统性虚高
 *  (审计 §1.1)。旧行无 rows(或越界,如库被清理)回落全量估算:
 *  粗一点,但不继承错基线 */
export function estimateBaselineTokens(
  ctx: { promptTokens: number; rows?: number } | undefined,
  history: InternalMsg[],
  fixedEstimate: number,
): number {
  if (ctx && ctx.rows !== undefined && ctx.rows <= history.length) {
    return ctx.promptTokens + estimateRange(history, ctx.rows) + fixedEstimate;
  }
  return estimateRange(history, 0) + fixedEstimate;
}

/** 生产端:测量时刻(run 收口)「已滤口径」的库行数 —— ctx.rows 的唯一
 *  算式。生产端(存什么)与消费端(怎么切)是同一份契约的两半,放同一
 *  模块、同一测试文件钉住。只认三个落盘锚点,用结构类型而故意**不收
 *  persistedSeqs**(未滤库行数,error 行也占 seq):含错误行的会话里它
 *  > 已滤行数,混进算式会超出消费端已滤 history 的长度,实测基线被整轮
 *  丢弃(审计 §1.1 的错误行残留,tokenBudget.test.ts 锁此契约) */
export function coveredLibraryRows(loop: {
  libraryRowsAtStart: number;
  savedUpTo: number;
  persistedInCtx: number;
}): number {
  return loop.libraryRowsAtStart + (loop.savedUpTo - loop.persistedInCtx);
}

export function trimHistoryForWindow(
  history: InternalMsg[],
  opts: {
    contextTokens?: number;
    maxTokens?: number;
    /** 本轮固定开销的估算(system + 即将拼入的 user 消息) */
    currentEstimate: number;
  },
): InternalMsg[] {
  const { contextTokens, maxTokens } = opts;
  if (!contextTokens || history.length === 0) return history;
  // 预留输出上限 + 20% 余量;下限 1/4 窗口,防 contextTokens 配小后把历史裁到只剩一轮
  const limit = usableTokens(contextTokens, maxTokens);
  const sum = (from: number) => opts.currentEstimate + estimateRange(history, from);
  if (sum(0) <= limit) return history;
  // 每轮起始 = isTurnStart(与 compaction.pickSplit 共享同一判定函数,轮的
  // 单位契约单点在 compaction.ts;本函数的输入是装配后的 DB 历史,本就不含
  // 合成块,共享判定是防未来输入域变化时两处漂移);从最旧的一轮开始
  // 整轮丢弃,直到塞得下或只剩最后一轮
  const roundStarts: number[] = [];
  history.forEach((m, i) => {
    if (isTurnStart(m)) roundStarts.push(i);
  });
  let dropIdx = 0;
  while (
    dropIdx < roundStarts.length - 1 &&
    sum(roundStarts[dropIdx]) > limit
  ) {
    dropIdx++;
  }
  if (dropIdx === 0) return history; // 单轮就超限:保底全发,交给 API 报错
  log.warn("agent", "history overflow — dropped oldest round(s)", {
    droppedTurns: dropIdx,
    keptMsgs: history.length - roundStarts[dropIdx],
    limitTokens: limit,
  });
  return history.slice(roundStarts[dropIdx]);
}
