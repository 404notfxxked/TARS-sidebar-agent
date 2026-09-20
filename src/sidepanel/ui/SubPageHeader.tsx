// 整页悬浮层(设置/历史/记忆)的吸顶头部:返回钮 + 标题 + 右侧插槽。
// 顶栏必须在滚动区外(悬浮层硬规则),本组件只负责头部本身,
// 滚动区由各页面自己接在后面。

import type { ReactNode } from "react";
import { useT } from "./hooks";

export default function SubPageHeader({
  title,
  onBack,
  backLabel,
  /** 水平内边距随页面密度:设置页 px-4,历史/记忆页 px-3 */
  className = "px-3",
  /** 右侧内容(保存反馈/溢出菜单/新建钮);宽元素自行带 ml-auto */
  children,
}: {
  title: string;
  onBack: () => void;
  backLabel?: string;
  className?: string;
  children?: ReactNode;
}) {
  // 缺省返回文案在组件体内现取(参数缺省求值读模块态,编译器下语言切换不刷新)
  const fallbackT = useT();
  const back = backLabel ?? fallbackT("common.backToChat");
  return (
    <header className={`flex items-center gap-2 pb-1 pt-3 ${className}`}>
      <button
        type="button"
        onClick={onBack}
        aria-label={back}
        className="icon-btn"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M10 3 5 8l5 5" />
        </svg>
      </button>
      <h2 className="m-0 text-[16px] font-medium text-on-surface">{title}</h2>
      {children}
    </header>
  );
}
