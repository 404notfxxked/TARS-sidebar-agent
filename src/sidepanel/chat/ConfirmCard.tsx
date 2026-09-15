// 写操作确认卡:后台在执行点击/填写前停下等答复;展示目标页与写入内容,
// 给用户足够信息做「允许 / 拒绝」决定;视觉沿用 combo-pop 浮层语言

import type { MSG, AgentEvent } from "../../shared/messages";
import { useT } from "../ui/hooks";
import { toolLabel } from "./toolNames";

type ConfirmRequest = Extract<
  AgentEvent,
  { type: typeof MSG.AGENT_CONFIRM_REQUEST }
>;

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
  return (
    <div
      role="alertdialog"
      aria-label={t("chat.confirmTitle")}
      className="mx-3 mb-2 rounded-xl bg-surface-container-high p-3 shadow-2"
    >
      <p className="flex items-center gap-1.5 text-[13px] font-medium text-on-surface">
        <ConfirmIcon />
        {toolLabel(t, req.name, req.displayName)} · {t("chat.confirmTitle")}
      </p>
      {targetLabel && (
        <p className="mt-1 truncate text-[11.5px] text-on-surface-variant">
          {t("chat.confirmTarget", { title: targetLabel })}
        </p>
      )}
      {fillText && (
        <p className="mt-1 break-all text-[11.5px] text-on-surface-variant">
          {t("chat.confirmFillText", { text: fillText })}
          {args.text && args.text.length > 80 ? "…" : ""}
        </p>
      )}
      {isFill && args.pressEnterAfter && (
        <p className="mt-1 text-[11.5px] text-error">
          {t("chat.confirmSubmitHint")}
        </p>
      )}
      {typeof args.selector === "string" && args.selector && (
        <p className="mt-1 truncate font-mono text-[11px] text-on-surface-variant">
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
          className="icon-btn-filled ml-2 h-8 px-3 text-[12px] font-medium leading-none"
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
