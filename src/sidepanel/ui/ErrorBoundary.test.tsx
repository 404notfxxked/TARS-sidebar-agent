// @vitest-environment jsdom
// ErrorBoundary 渲染兜底回归(需求 REQ-P0-4):此前一次 render 抛错 = 整块面板
// 白屏,无任何出口。边界挂载后:子树抛错必须渲染兜底 UI(标题 + 重载出口),
// 子树正常时不得出现兜底。文案期望一律经 zhCN 字典键派生(硬规则 1)。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { zhCN } from "../../shared/i18n/locales/zh-CN";
import { ErrorBoundary } from "./ErrorBoundary";

// 测试种子:受控抛错的子组件(非 UI 文案)
function Boom(): never {
  throw new Error("seed render error");
}

afterEach(cleanup);

describe("ErrorBoundary 渲染兜底", () => {
  it("子树抛错 → 兜底 UI 而非白屏,且有「重新加载面板」出口", () => {
    // React 会向 console.error 喷受控错误的诊断,收敛以免噪声埋断言
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText(zhCN.common.renderErrorTitle)).toBeInTheDocument();
    expect(screen.getByText(zhCN.common.renderErrorHint)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: zhCN.common.reloadPanel }),
    ).toBeInTheDocument();
    consoleSpy.mockRestore();
  });

  it("子树正常 → 原样渲染,不出现兜底 UI", () => {
    render(
      <ErrorBoundary>
        <p>healthy</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText("healthy")).toBeInTheDocument();
    expect(screen.queryByText(zhCN.common.renderErrorTitle)).not.toBeInTheDocument();
  });
});
