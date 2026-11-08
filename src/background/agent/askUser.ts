// agent 反问通道(SW 侧):ask_user 工具的执行体 —— 发 AGENT_ASK_REQUEST
// 给面板、挂起等 ASK_RESPONSE,把作答回填为模型可见的结构化 JSON。
// 与确认门(confirmations.ts)刻意分立:确认门防「替用户动手」的安全
// 后果,超时=拒绝(从严);反问只是缺信息,超时=未答,模型自行决断并
// 明说 —— 两套语义不混流。共享的是同一条事实:run 循环在等待点阻塞,
// 确认卡与反问卡不会同时在场(工具批次串行 + 循环阻塞,无需跨模块协调)。
// SW 被回收时 pending Map 随之消失,面板迟到答复在 resolveAsk 静默忽略
// (与确认门同款兜底)。

import { MSG } from "../../shared/messages";
import { startUserWaitKeepalive } from "./confirmations";
import type { AgentPort } from "./agent";

/** 等待作答上限:反问没有安全后果,比确认门宽(5 分钟);超时回填
 *  「未答」而非拒绝 —— 模型拿到明确信号后自行决断,不要立刻重问 */
const ASK_TIMEOUT_MS = 300_000;

export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  question: string;
  /** 短标签(≤12 字):窄侧栏里作问题组的标题,可缺省 */
  header?: string;
  options: AskOption[];
  multiSelect?: boolean;
}

/** 面板逐题作答:selected = 选中的 label(单选也用数组),text 为「其他」
 *  自由输入 —— 用户可以只打字不选,两者互不依赖 */
export interface AskAnswer {
  selected: string[];
  text?: string;
}

const pending = new Map<string, (answers: AskAnswer[] | null) => void>();

/** 面板答复入口(runHandlers 的 port 路由调用);幂等,未知/过期
 *  requestId 静默忽略(面板刷新/SW 回收后的迟到作答打不穿) */
export function resolveAsk(requestId: string, answers: AskAnswer[]): void {
  const settle = pending.get(requestId);
  if (!settle) return;
  pending.delete(requestId);
  settle(answers);
}

function invalid(msg: string): never {
  throw new Error(`ask_user: ${msg}`);
}

/** 参数硬校验(工具层,violation 直接作为工具错误打回模型):
 *  1–3 问、每问 2–4 个非空 label 选项、问题文本非空、header ≤12 字。
 *  schema 之外再守一道 —— 模型漏带/多带时给可行动的错误,不是渲染期崩 */
function validateArgs(args: unknown): AskQuestion[] {
  const questions = (args as { questions?: unknown } | null | undefined)
    ?.questions;
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 3)
    invalid("questions must be an array with 1-3 questions");
  return questions.map((q, i) => {
    const at = `questions[${i}]`;
    const question = (q as { question?: unknown })?.question;
    if (typeof question !== "string" || !question.trim())
      invalid(`${at}.question must be a non-empty string`);
    const header = (q as { header?: unknown })?.header;
    if (
      header !== undefined &&
      (typeof header !== "string" || header.length > 12)
    )
      invalid(
        `${at}.header must be a string of at most 12 characters (or omitted)`,
      );
    const options = (q as { options?: unknown })?.options;
    if (!Array.isArray(options) || options.length < 2 || options.length > 4)
      invalid(`${at}.options must be an array of 2-4 options`);
    for (const [j, o] of options.entries()) {
      const label = (o as { label?: unknown })?.label;
      if (typeof label !== "string" || !label.trim())
        invalid(`${at}.options[${j}].label must be a non-empty string`);
    }
    return q as AskQuestion;
  });
}

/** 模型可见结果:作答 → 以问题文本为键的 answers(回显问题便于模型对号);
 *  未答(超时/取消)→ status=unanswered + 自行决断的注记。答案回填与
 *  会话流留痕是两个视图一份事实:落盘走 tool_call/tool_result 全量管线 */
function resultOf(questions: AskQuestion[], answers: AskAnswer[] | null): string {
  if (!answers) {
    return JSON.stringify({
      status: "unanswered",
      note: "The user did not respond within 5 minutes; proceed with your best judgment and say so to the user.",
    });
  }
  return JSON.stringify({
    answers: questions.map((q, i) => ({
      question: q.question,
      selected: answers[i]?.selected ?? [],
      ...(answers[i]?.text ? { text: answers[i].text } : {}),
    })),
  });
}

/** 发反问卡并等待作答;返回模型可见的结构化结果(见 resultOf) */
export async function requestAskUser(
  port: AgentPort,
  args: unknown,
  signal?: AbortSignal,
): Promise<string> {
  const questions = validateArgs(args);
  const requestId = crypto.randomUUID();
  port.postMessage({
    type: MSG.AGENT_ASK_REQUEST,
    requestId,
    questions,
    // 超时口径随载荷下发:反问卡展示「多久未答由模型自行判断」
    timeoutMs: ASK_TIMEOUT_MS,
  });

  return new Promise<string>((resolve) => {
    const keepalive = startUserWaitKeepalive();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = (answers: AskAnswer[] | null) => {
      pending.delete(requestId);
      clearInterval(keepalive);
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(resultOf(questions, answers));
    };
    const onAbort = () => settle(null);
    pending.set(requestId, settle);
    timer = setTimeout(() => settle(null), ASK_TIMEOUT_MS);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
