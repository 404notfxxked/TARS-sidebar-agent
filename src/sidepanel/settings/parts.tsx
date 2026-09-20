// 设置页内部共享件:分节骨架、展开卡片骨架、「了解详情」折叠、小工具。
// 只服务 settings/ 下的分节组件;跨视图的通用件在 ui/。

import { useState, type ReactNode } from "react";
import { useT } from "../ui/hooks";

// hostOf 迁至 shared/url(三处重复实现收口);重导出保住设置分节们的现有 import
export { hostOf } from "../../shared/url";

/** 分节:眉题 + 白卡。卡内子块节奏由 .settings-card > * + * 的 margin 管
 *  (勿给子块另垫上下 padding)。首个分节 mt-3,其余 mt-5
 *  (分节之间多给一档呼吸,眉题才压得住卡) */
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
      <h3 className={`settings-eyebrow mb-1.5 ${first ? "mt-3" : "mt-5"}`}>
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
          <span className="ml-auto shrink-0 pr-1 text-[11.5px] text-on-surface-variant">
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

/** 卡内导航入口行:左摘要 + 右主色动作,整行可点去对应整页。
 *  悬停底色宽度 = 内容列(不出血):桌面指针不需要移动端的大色块靶心,
 *  px-2 的内缩读作嵌套层级,悬停时色块也不与卡片圆角打架 */
export function EntryRow({
  summary,
  action,
  onClick,
  ariaLabel,
}: {
  summary: string;
  /** 右侧动作文案,如「管理记忆」 */
  action: string;
  onClick: () => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left transition-colors duration-150 hover:bg-on-surface/8"
    >
      <span className="min-w-0 truncate pr-2 text-[13px] text-on-surface">
        {summary}
      </span>
      <span className="flex shrink-0 items-center gap-0.5 text-[12.5px] font-medium text-primary">
        {action}
        <svg
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
          <path d="m6 3.5 4.5 4.5L6 12.5" />
        </svg>
      </span>
    </button>
  );
}

/** 「了解详情」折叠:一句话说明留在明面,机制/隐私类长说明按需展开
 *  (定义类短说明走 ui/InfoTip 气泡,警示类保持明面)。
 *  展开体是普通 field-hint 段落,文案由调用侧经 t() 现取 */
export function HintMore({ detail }: { detail: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        className="hint-more-btn"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? t("common.showLess") : t("common.learnMore")}
        <svg
          width="10"
          height="10"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m6 3.5 4.5 4.5L6 12.5" />
        </svg>
      </button>
      {open && <p className="field-hint mt-1.5">{detail}</p>}
    </div>
  );
}
