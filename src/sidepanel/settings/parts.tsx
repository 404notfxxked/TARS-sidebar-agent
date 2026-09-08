// 设置页内部共享件:分节骨架、展开卡片骨架、小工具。
// 只服务 settings/ 下的分节组件;跨视图的通用件在 ui/。

import type { ReactNode } from "react";

/** 分节:眉题 + 白卡。卡内子块节奏由 .settings-card > * + * 的 margin 管
 *  (契约 6,勿给子块另垫上下 padding)。首个分节 mt-3,其余 mt-4 */
export function SettingsSection({
  title,
  first = false,
  children,
}: {
  title: string;
  first?: boolean;
  children: ReactNode;
}) {
  return (
    <>
      <h3 className={`settings-eyebrow mb-1.5 ${first ? "mt-3" : "mt-4"}`}>
        {title}
      </h3>
      <div className="settings-card">{children}</div>
    </>
  );
}

/** 展开卡片:收起态头部(名称 + 徽标 + 右侧概要 + chevron),点击展开折叠体。
 *  供应商卡 / MCP 服务器卡 / 模型行共用这一套骨架,几何与 aria 由这里统一
 *  (样式类 .model-row* 见 styles/settings.css) */
export function ExpandCard({
  open,
  onToggle,
  label,
  badge,
  meta,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
  /** 名称旁的小徽标(默认/当前/停用) */
  badge?: ReactNode;
  /** 头部右侧概要(模型数/工具数/主机名);null 不占位 */
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="model-row">
      <button
        type="button"
        className="model-row-head"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="min-w-0 truncate">
          <span className="model-row-name">{label}</span>
          {badge}
        </span>
        {meta != null && (
          <span className="ml-auto shrink-0 pr-1 text-[11px] text-on-surface-variant">
            {meta}
          </span>
        )}
        <svg
          className="model-row-chevron"
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m6 3 5 5-5 5" />
        </svg>
      </button>
      <div className="model-row-body" data-open={open}>
        <div className="model-row-body-inner">{children}</div>
      </div>
    </div>
  );
}

/** baseUrl → 主机名(供应商/服务器未命名时的展示兜底) */
export const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};
