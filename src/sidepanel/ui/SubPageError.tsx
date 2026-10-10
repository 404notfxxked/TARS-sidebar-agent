// 子页错误态(记忆/技能/会话三页共用):
// error 必须与 empty 拆成两个状态 —— 存储异常渲染成「还没有数据」是恐慌性
// 误报,会诱发用户清数据/重装(需求 REQ-P0-3)。文案在调用侧经 t() 现取
// 传入(同 SubPageEmpty 口径:组件内不查字典,禁动态键);重试动作由调用
// 方注入(各页重拉各自的列表),本组件只管形态。

import { useT } from "./hooks";

export function SubPageError({
  title,
  hint,
  onRetry,
}: {
  title: string;
  hint?: string;
  onRetry: () => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
      <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
        className="text-on-surface-variant opacity-60">
        <path d="M12 3.2 21.2 19.4H2.8L12 3.2Z" />
        <path d="M12 9.4v4" />
        <path d="M12 16.4h.01" />
      </svg>
      <p className="m-0 text-[13px] text-on-surface-variant">{title}</p>
      {hint ? <p className="m-0 text-[12px] leading-4 text-on-surface-variant/80">{hint}</p> : null}
      <div className="mt-1">
        <button type="button" className="settings-btn" onClick={onRetry}>
          {t("common.retry")}
        </button>
      </div>
    </div>
  );
}
