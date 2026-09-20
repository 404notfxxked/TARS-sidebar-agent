// 写操作确认卡:后台在执行页面写动作/记忆持久写/受控外链读取前停下等答复;
// 展示目标页与操作内容,给用户足够信息做「允许 / 拒绝」决定;视觉沿用
// combo-pop 浮层语言。键位表必须写字面量(check-i18n 只收集键形字面量)

import type { MSG, AgentEvent } from "../../shared/messages";
import { useT } from "../ui/hooks";
import { toolLabel } from "./toolNames";

type ConfirmRequest = Extract<
  AgentEvent,
  { type: typeof MSG.AGENT_CONFIRM_REQUEST }
>;

/** 按工具族取卡片标题键:页面动作/记忆/外链各自有更贴题的说法 */
function confirmTitleKey(name: string): string {
  switch (name) {
    case "memory_save":
      return "chat.confirmMemorySaveTitle";
    case "memory_delete":
      return "chat.confirmMemoryDeleteTitle";
    case "web_fetch":
      return "chat.confirmWebFetchTitle";
    default:
      return "chat.confirmTitle";
  }
}

export function ConfirmCard({
  req,
  onAnswer,
}: {
  req: ConfirmRequest;
  onAnswer: (approved: boolean) => void;
}) {
  const t = useT();
  const args = (req.args ?? {}) as {
    selector?: string;
    text?: string;
    pressEnterAfter?: boolean;
    content?: string;
    match?: string;
    url?: string;
  };
  const host = (() => {
    try {
      return req.tabUrl ? new URL(req.tabUrl).hostname : "";
    } catch {
      return "";
    }
  })();
  const targetLabel = req.tabTitle
    ? host
      ? `${req.tabTitle}（${host}）`
      : req.tabTitle
    : host;
  const isFill = req.name === "fill_input";
  const fillText =
    isFill && typeof args.text === "string" ? args.text.slice(0, 80) : "";
  // 记忆/外链族的操作对象也必须上卡(与 fill 的写入内容同一条信息纪律)
  const memSaveText =
    req.name === "memory_save" && typeof args.content === "string"
      ? args.content.slice(0, 80)
      : "";
  const memDeleteMatch =
    req.name === "memory_delete" && typeof args.match === "string"
      ? args.match.slice(0, 80)
      : "";
  // 链接行只展示 host + 路径:这族门的意义是「看清将要外发什么」,而外泄
  // 负载恰好藏在长查询串里 —— 查询串不逐字展示,另起一行只报长度,让
  // 「截断」本身成为信号
  const fetchRawUrl =
    req.name === "web_fetch" && typeof args.url === "string" ? args.url : "";
  const fetchTarget = (() => {
    if (!fetchRawUrl) return null;
    try {
      return new URL(fetchRawUrl);
    } catch {
      return null;
    }
  })();
  const fetchPathRaw = fetchTarget ? fetchTarget.pathname : "";
  const fetchLabel = fetchTarget
    ? `${fetchTarget.host}${fetchPathRaw === "/" ? "" : fetchPathRaw.slice(0, 80)}`
    : fetchRawUrl.slice(0, 120);
  const fetchTruncated =
    !fetchTarget || fetchTarget.search.length > 1 || fetchPathRaw.length > 80;
  const fetchQueryChars = fetchTarget ? fetchTarget.search.length - 1 : 0;
  const titleKey = confirmTitleKey(req.name);
  return (
    <div
      role="alertdialog"
      aria-label={t(titleKey)}
      className="mx-3 mb-2 rounded-lg bg-surface-container-high p-3 shadow-2"
    >
      <p className="flex items-center gap-1.5 text-[13px] font-medium text-on-surface">
        <ConfirmIcon />
        {toolLabel(t, req.name, req.displayName)} · {t(titleKey)}
      </p>
      {targetLabel && (
        <p className="mt-1 truncate text-[12px] text-on-surface-variant">
          {t("chat.confirmTarget", { title: targetLabel })}
        </p>
      )}
      {fillText && (
        <p className="mt-1 break-all text-[12px] text-on-surface-variant">
          {t("chat.confirmFillText", { text: fillText })}
          {args.text && args.text.length > 80 ? "…" : ""}
        </p>
      )}
      {isFill && args.pressEnterAfter && (
        <p className="mt-1 text-[12px] text-error">
          {t("chat.confirmSubmitHint")}
        </p>
      )}
      {memSaveText && (
        <p className="mt-1 break-all text-[12px] text-on-surface-variant">
          {t("chat.confirmMemorySaveText", { text: memSaveText })}
          {(args.content?.length ?? 0) > 80 ? "…" : ""}
        </p>
      )}
      {memDeleteMatch && (
        <p className="mt-1 break-all text-[12px] text-on-surface-variant">
          {t("chat.confirmMemoryDeleteText", { match: memDeleteMatch })}
        </p>
      )}
      {fetchRawUrl && (
        <>
          <p className="mt-1 break-all font-mono text-[11.5px] text-on-surface-variant">
            {t("chat.confirmWebFetchUrl", { url: fetchLabel })}
            {fetchTruncated ? "…" : ""}
          </p>
          {fetchTarget && fetchQueryChars > 0 && (
            <p className="mt-1 break-all text-[12px] text-on-surface-variant">
              {t("chat.confirmWebFetchQuery", { n: String(fetchQueryChars) })}
            </p>
          )}
        </>
      )}
      {typeof args.selector === "string" && args.selector && (
        <p className="mt-1 truncate font-mono text-[11.5px] text-on-surface-variant">
          {t("chat.confirmSelectorLabel", { selector: args.selector })}
        </p>
      )}
      <div className="mt-2.5 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => onAnswer(false)}
          aria-label={t("chat.confirmDeny")}
          className="btn-text"
        >
          {t("chat.confirmDeny")}
        </button>
        <button
          type="button"
          onClick={() => onAnswer(true)}
          aria-label={t("chat.confirmAllow")}
          className="icon-btn-filled ml-2 h-9 px-3 font-medium leading-none"
        >
          {t("chat.confirmAllow")}
        </button>
      </div>
    </div>
  );
}

function ConfirmIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      <path d="M8 1.8 13.5 4v4.2c0 3.1-2.3 5.3-5.5 6.2-3.2-.9-5.5-3.1-5.5-6.2V4L8 1.8Z" />
      <path d="m5.6 8 1.7 1.7 3.1-3.3" strokeLinecap="round" />
    </svg>
  );
}
