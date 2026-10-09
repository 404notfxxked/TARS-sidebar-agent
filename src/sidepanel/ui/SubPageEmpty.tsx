import type { ReactNode } from "react";

/** 子页空态(记忆/技能/历史共用):图标 + 主文案 + 可选副文案 + 可选动作。
 *  文案在调用侧经 t() 现取后传入 —— 组件内不查字典(AGENTS.md「文案」:禁动态键) */
export function SubPageEmpty({ icon, title, hint, children }: {
  icon: ReactNode; title: string; hint?: string; children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
      <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
        className="text-on-surface-variant opacity-60">
        {icon}
      </svg>
      <p className="m-0 text-[13px] text-on-surface-variant">{title}</p>
      {hint ? <p className="m-0 text-[12px] leading-4 text-on-surface-variant/80">{hint}</p> : null}
      {/* 动作按钮:外层 mt-1 补足 —— 历史页原本是 gap-3(12px),这里 8px+4px 保持原视觉 */}
      {children ? <div className="mt-1">{children}</div> : null}
    </div>
  );
}
