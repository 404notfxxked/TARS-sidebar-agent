// 渲染兜底边界:子树抛错时显示「渲染异常」兜底 UI,单块异常不再拖垮整个面板
// (此前一次 render 抛错 = 整块白屏,用户只能重开面板)。
// class 组件是 React 错误边界的唯一形态(hooks 无对应能力,有意不引第三方薄封装);
// 兜底文案拆成函数子组件经 useT() 现取 —— class 里调不了 hook,模块级 t() 又会被
// React Compiler 当零依赖永久缓存(AGENTS.md「面板状态」)。诊断日志只记错误信息与组件栈
// (logger 侧自动截断),不记任何 props/原文(日志隐私判据)。

import { Component, type ErrorInfo, type ReactNode } from "react";
import { errText } from "../../shared/errors";
import { createLogger } from "../../shared/logger";
import { useT } from "./hooks";

const log = createLogger({ ctx: "panel" });

function BoundaryFallback() {
  const t = useT();
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
        className="text-on-surface-variant opacity-60">
        <path d="M12 3.2 21.2 19.4H2.8L12 3.2Z" />
        <path d="M12 9.4v4" />
        <path d="M12 16.4h.01" />
      </svg>
      <p className="m-0 text-[13px] font-medium">{t("common.renderErrorTitle")}</p>
      <p className="m-0 text-[12px] leading-4 text-on-surface-variant">
        {t("common.renderErrorHint")}
      </p>
      <button type="button" className="settings-btn mt-1" onClick={() => location.reload()}>
        {t("common.reloadPanel")}
      </button>
    </div>
  );
}

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    log.error("boundary", "渲染边界捕获异常", {
      error: errText(error),
      componentStack: info.componentStack ?? undefined,
    });
  }

  override render() {
    return this.state.error ? <BoundaryFallback /> : this.props.children;
  }
}
