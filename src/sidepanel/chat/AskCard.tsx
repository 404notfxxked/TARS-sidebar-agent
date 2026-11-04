// 反问卡:ask_user 工具的用户侧交互面,渲染在执行流中该工具调用的位置
// (trace 里 ToolRow 的特化替身)。交互态(live running 且面板持有 ask 请求):
// 选项点选(单选圆点/多选方块)、「其他」展开自由输入,全部题目答齐后卡片级
// 提交 —— 单选也走提交:radio 的可供性是「选完再确认」,点选即发既易误触,
// 也让单选与多选行为不一致。作答后原地收起为紧凑行(问题 + 所选摘要),
// 可展开回看全部选项与高亮 —— 回放由 ProcessItem(name+args+result)以同款
// 组件重渲染,实况与回放一份渲染、两个数据源。校验在 SW 侧(askUser.ts)
// 硬校验过,这里只做防御性解析。键位表必须写字面量(check-i18n)。

import { useState } from "react";
import { useT } from "../ui/hooks";

/** SW 侧 askUser.ts 的 AskQuestion(面板侧防御性重声明,不跨域 import) */
export interface AskQuestionView {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}

/** 作答:selected = 选中的 label(单选也是数组),text = 「其他」自由输入 */
export interface AskAnswerView {
  selected: string[];
  text?: string;
}

/** 工具结果的解析:作答 / 未答(超时)/ 不可解析三路 */
export function parseAskResult(
  result: unknown,
): { answers?: { question: string; selected: string[]; text?: string }[]; unanswered?: boolean } | null {
  if (typeof result !== "string") return null;
  try {
    const parsed = JSON.parse(result) as {
      answers?: unknown;
      status?: unknown;
    };
    if (parsed.status === "unanswered") return { unanswered: true };
    if (Array.isArray(parsed.answers)) return { answers: parsed.answers as never };
    return null;
  } catch {
    return null;
  }
}

/** args → questions 的防御性提取(ToolSeg.args 是对象,回放投影可能给 JSON 串) */
export function askQuestionsOf(args: unknown): AskQuestionView[] {
  const container =
    typeof args === "string"
      ? (() => {
          try {
            return JSON.parse(args) as { questions?: unknown };
          } catch {
            return null;
          }
        })()
      : (args as { questions?: unknown } | null | undefined);
  const qs = container?.questions;
  if (!Array.isArray(qs)) return [];
  return qs.filter(
    (q): q is AskQuestionView =>
      !!q &&
      typeof (q as { question?: unknown }).question === "string" &&
      Array.isArray((q as { options?: unknown }).options),
  );
}

/** 收起态的形态:已答(有 answers)/ 未答(超时)/ 等待(结果未到或面板丢请求) */
type CollapsedMode = "answered" | "unanswered" | "waiting";

export function AskCard({
  questions,
  interactive,
  onAnswer,
  result,
  timeoutMs,
}: {
  questions: AskQuestionView[];
  /** true = 等待作答(选项可点);false = 已答/回放形态(收起为摘要行) */
  interactive: boolean;
  onAnswer?: (answers: AskAnswerView[]) => void;
  /** 工具结果原文(JSON 串):已答/未答的判定源 */
  result?: unknown;
  timeoutMs?: number;
}) {
  const t = useT();
  const parsed = parseAskResult(result);
  /** 逐题本地态:选中 label 集合 / 「其他」输入 / 其他框是否展开 */
  const [picks, setPicks] = useState<string[][]>(questions.map(() => []));
  const [texts, setTexts] = useState<string[]>(questions.map(() => ""));
  const [otherOpen, setOtherOpen] = useState<boolean[]>(questions.map(() => false));
  const [submitted, setSubmitted] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const everyAnswered = questions.every(
    (_, i) => picks[i].length > 0 || texts[i].trim().length > 0,
  );

  const togglePick = (qi: number, label: string, multi: boolean) => {
    setPicks((prev) =>
      prev.map((set, i) =>
        i !== qi
          ? set
          : multi
            ? (set.includes(label) ? set.filter((l) => l !== label) : [...set, label])
            : [label],
      ),
    );
  };

  const commit = (answers: AskAnswerView[]) => {
    setSubmitted(true);
    onAnswer?.(answers);
  };

  const submitCard = () => {
    commit(
      questions.map((_, i) => ({
        selected: picks[i],
        ...(texts[i].trim() ? { text: texts[i].trim() } : {}),
      })),
    );
  };

  const mode: CollapsedMode = parsed?.answers
    ? "answered"
    : parsed?.unanswered
      ? "unanswered"
      : "waiting";

  /** 已答摘要:selected 合并 + text 追加(收起态的问题行尾回显) */
  const summaryOf = (qi: number): string => {
    const res = parsed?.answers?.[qi];
    if (!res) return "";
    const parts: string[] = [];
    if (res.selected?.length) parts.push(res.selected.join("、"));
    if (res.text) parts.push(res.text);
    return parts.join(" · ");
  };

  // ---- 收起态:作答后/回放。逐题一行「问题 + 所选摘要」,可展开回看 ----
  if (!interactive) {
    return (
      <div className="w-full rounded-lg bg-surface-container-high p-3">
        {questions.map((q, qi) => {
          const summary = summaryOf(qi);
          return (
            <div key={qi} className={qi > 0 ? "mt-2 border-t border-outline-variant pt-2" : ""}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="min-w-0 flex-1 break-all text-[12.5px] text-on-surface-variant">
                  {q.question}
                </span>
                {summary !== "" && (
                  <div className="inline-flex max-w-full items-center rounded-full bg-primary-container px-2 py-0.5 text-[11.5px] text-on-primary-container">
                    <span className="break-all">{summary}</span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {mode === "waiting" && (
          <p className="mt-1.5 text-[11.5px] text-on-surface-variant/80">
            {t("chat.askWaiting")}
          </p>
        )}
        {mode === "unanswered" && (
          <p className="mt-1.5 text-[11.5px] text-on-surface-variant/80">
            {t("chat.askUnansweredBadge")}
          </p>
        )}
        {/* 已答/未答都可展开回看全部选项(高亮/无高亮);等待态没有可看的内容 */}
        {mode !== "waiting" && (
          <>
            <button
              type="button"
              onClick={() => setDetailsOpen((v) => !v)}
              aria-expanded={detailsOpen}
              aria-label={t(detailsOpen ? "chat.confirmCollapse" : "chat.confirmExpand")}
              className="btn-text mt-0.5 h-7 px-1"
            >
              {t(detailsOpen ? "chat.confirmCollapse" : "chat.confirmExpand")}
            </button>
            {detailsOpen && (
              <div className="mt-1 flex flex-col gap-1.5">
                {questions.map((q, qi) => {
                  const textAns = mode === "answered" ? parsed?.answers?.[qi]?.text : undefined;
                  return (
                    <div key={qi}>
                      {q.header && (
                        <p className="text-[11px] font-medium tracking-wide text-primary">
                          {q.header}
                        </p>
                      )}
                      <div className="mt-1 flex flex-col gap-1">
                        {q.options.map((o) => {
                          const picked =
                            mode === "answered" &&
                            (parsed?.answers?.[qi]?.selected ?? []).includes(o.label);
                          return (
                            <div
                              key={o.label}
                              className={`flex items-start gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] ${
                                picked
                                  ? "bg-primary-container text-on-primary-container"
                                  : "text-on-surface-variant"
                              }`}
                            >
                              <span
                                aria-hidden="true"
                                className={`mt-0.5 h-3.5 w-3.5 shrink-0 border ${
                                  q.multiSelect ? "rounded-xs" : "rounded-full"
                                } ${
                                  picked
                                    ? "border-on-primary-container bg-on-primary-container"
                                    : "border-outline"
                                }`}
                              />
                              <span className="min-w-0 break-all">
                                {o.label}
                                {o.description && (
                                  <span className="block text-[11.5px] opacity-80">
                                    {o.description}
                                  </span>
                                )}
                              </span>
                            </div>
                          );
                        })}
                        {textAns && (
                          <div className="mt-1 rounded-md bg-primary-container px-2.5 py-1.5 text-[12.5px] text-on-primary-container">
                            {textAns}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  // ---- 交互态:点选 + 其他自由输入,答齐后卡片级提交 ----
  return (
    <div className="w-full rounded-lg bg-surface-container-high p-3">
      {questions.map((q, qi) => (
        <div key={qi} className={qi > 0 ? "mt-3 border-t border-outline-variant pt-3" : ""}>
          {q.header && (
            <p className="text-[11px] font-medium tracking-wide text-primary">{q.header}</p>
          )}
          <p className="text-[13px] font-medium text-on-surface">{q.question}</p>
          <div className="mt-1.5 flex flex-col gap-1">
            {q.options.map((o) => {
              const picked = picks[qi].includes(o.label);
              return (
                <button
                  key={o.label}
                  type="button"
                  disabled={submitted}
                  onClick={() => togglePick(qi, o.label, !!q.multiSelect)}
                  className={`flex items-start gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] ${
                    picked
                      ? "bg-primary-container text-on-primary-container"
                      : "bg-surface-container-highest text-on-surface"
                  } disabled:opacity-60`}
                >
                  <span
                    aria-hidden="true"
                    className={`mt-0.5 h-3.5 w-3.5 shrink-0 border ${
                      q.multiSelect ? "rounded-xs" : "rounded-full"
                    } ${
                      picked
                        ? "border-on-primary-container bg-on-primary-container"
                        : "border-outline"
                    }`}
                  />
                  <span className="min-w-0 break-all">
                    {o.label}
                    {o.description && (
                      <span className="block text-[11.5px] text-on-surface-variant">
                        {o.description}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
            {!otherOpen[qi] && (
              <button
                type="button"
                disabled={submitted}
                onClick={() =>
                  setOtherOpen((prev) => prev.map((v, i) => (i === qi ? true : v)))
                }
                aria-label={t("chat.askOther")}
                className="rounded-md border border-dashed border-outline px-2.5 py-1.5 text-left text-[12.5px] text-on-surface-variant disabled:opacity-60"
              >
                + {t("chat.askOther")}
              </button>
            )}
            {otherOpen[qi] && (
              <textarea
                value={texts[qi]}
                onChange={(e) =>
                  setTexts((prev) => prev.map((v, i) => (i === qi ? e.target.value : v)))
                }
                rows={1}
                placeholder={t("chat.askOtherPlaceholder")}
                aria-label={t("chat.askOtherPlaceholder")}
                className="block w-full resize-none rounded-xs bg-surface-container-highest px-2 py-1.5 text-[12.5px] leading-relaxed text-on-surface outline-none placeholder:text-on-surface-variant"
              />
            )}
          </div>
        </div>
      ))}
      <div className="mt-2.5 flex items-center justify-end gap-2">
        <button
          type="button"
          disabled={submitted || !everyAnswered}
          onClick={submitCard}
          aria-label={t("chat.askSubmit")}
          className="icon-btn-filled h-8 px-3 text-[12.5px] font-medium leading-none"
        >
          {t("chat.askSubmit")}
        </button>
      </div>
      {submitted ? (
        <p className="mt-2 text-[11.5px] text-on-surface-variant/80">{t("chat.askSubmitted")}</p>
      ) : (
        <p className="mt-2 text-[11.5px] leading-4 text-on-surface-variant/80">
          {t("chat.askTimeoutHint", {
            n: String(Math.max(1, Math.round((timeoutMs ?? 300_000) / 60000))),
          })}
        </p>
      )}
    </div>
  );
}
