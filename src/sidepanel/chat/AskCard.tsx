// 反问卡:ask_user 工具的用户侧交互面,渲染在执行流中该工具调用的位置
// (trace 里 ToolRow 的特化替身 —— 交互态(live running 且面板持有 ask 请求)
// 选项可点、「其他」展开自由输入、多选/多问走卡片级提交;作答后原地翻
// 已答态(选中高亮/未答徽记),回放由 ProcessItem(name+args+result)以同款
// 组件重渲染 —— 实况与回放一份渲染、两个数据源。校验在 SW 侧(askUser.ts)
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

export function AskCard({
  questions,
  interactive,
  onAnswer,
  result,
  timeoutMs,
}: {
  questions: AskQuestionView[];
  /** true = 等待作答(选项可点);false = 已答/回放形态 */
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

  /** 单问单选:点选项即整卡作答(少一次点击);其余形态卡片级提交 */
  const immediate = interactive && questions.length === 1 && !questions[0].multiSelect;
  const answered = !interactive;
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

  return (
    <div className="w-full rounded-lg bg-surface-container-high p-3">
      {questions.map((q, qi) => {
        const res = parsed?.answers?.[qi];
        return (
          <div key={qi} className={qi > 0 ? "mt-3 border-t border-outline-variant pt-3" : ""}>
            {q.header && (
              <p className="text-[11px] font-medium tracking-wide text-primary">
                {q.header}
              </p>
            )}
            <p className="text-[13px] font-medium text-on-surface">{q.question}</p>
            <div className="mt-1.5 flex flex-col gap-1">
              {q.options.map((o) => {
                const picked = answered
                  ? (res?.selected ?? []).includes(o.label)
                  : picks[qi].includes(o.label);
                if (answered) {
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
                        className={`mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full border ${
                          picked ? "border-on-primary-container bg-on-primary-container" : "border-outline"
                        }`}
                      />
                      <span className="min-w-0 break-all">
                        {o.label}
                        {o.description && (
                          <span className="block text-[11.5px] opacity-80">{o.description}</span>
                        )}
                      </span>
                    </div>
                  );
                }
                return (
                  <button
                    key={o.label}
                    type="button"
                    disabled={submitted}
                    onClick={() => {
                      if (immediate) commit([{ selected: [o.label] }]);
                      else togglePick(qi, o.label, !!q.multiSelect);
                    }}
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
                      } ${picked ? "border-on-primary-container bg-on-primary-container" : "border-outline"}`}
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
              {/* 「其他」自由输入:UI 侧自动追加,交互态展开输入,已答态展示回答行 */}
              {interactive ? (
                <>
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
                    <div className="mt-1 flex items-end gap-1.5">
                      <textarea
                        value={texts[qi]}
                        onChange={(e) =>
                          setTexts((prev) => prev.map((v, i) => (i === qi ? e.target.value : v)))
                        }
                        rows={1}
                        placeholder={t("chat.askOtherPlaceholder")}
                        aria-label={t("chat.askOtherPlaceholder")}
                        className="block min-w-0 flex-1 resize-none rounded-xs bg-surface-container-highest px-2 py-1.5 text-[12.5px] leading-relaxed text-on-surface outline-none placeholder:text-on-surface-variant"
                      />
                      {immediate && (
                        <button
                          type="button"
                          disabled={!texts[qi].trim()}
                          onClick={() =>
                            commit([{ selected: [], text: texts[qi].trim() }])
                          }
                          aria-label={t("chat.askSend")}
                          className="btn-text h-8 shrink-0"
                        >
                          {t("chat.askSend")}
                        </button>
                      )}
                    </div>
                  )}
                </>
              ) : (
                res?.text && (
                  <div className="mt-1 rounded-md bg-primary-container px-2.5 py-1.5 text-[12.5px] text-on-primary-container">
                    {res.text}
                  </div>
                )
              )}
            </div>
          </div>
        );
      })}

      {interactive ? (
        <>
          {!immediate && (
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
          )}
          {submitted ? (
            <p className="mt-2 text-[11.5px] text-on-surface-variant/80">{t("chat.askSubmitted")}</p>
          ) : (
            <p className="mt-2 text-[11.5px] leading-4 text-on-surface-variant/80">
              {t("chat.askTimeoutHint", {
                n: String(Math.max(1, Math.round((timeoutMs ?? 300_000) / 60000))),
              })}
            </p>
          )}
        </>
      ) : (
        <p className="mt-2 text-[11.5px] leading-4 text-on-surface-variant/80">
          {parsed?.unanswered
            ? t("chat.askUnansweredBadge")
            : parsed?.answers
              ? ""
              : t("chat.askWaiting")}
        </p>
      )}
    </div>
  );
}
