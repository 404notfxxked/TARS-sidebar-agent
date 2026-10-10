// @vitest-environment jsdom
// SessionsView 列表读取失败(REQ-P0-3 收尾):SESSIONS 回包带 error(存储
// 异常)时必须走错误态而非「还没有会话」空态 —— 存储异常呈现成数据消失是
// 恐慌性误报;重试重发 LIST_SESSIONS,成功后错误态退场、列表出现。
// 空会话(无 error)仍走既有空态,不误报。

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { MSG } from "../../shared/messages";
import { zhCN } from "../../shared/i18n/locales/zh-CN";
import SessionsView from "./SessionsView";

type PortListener = (evt: unknown) => void;

function installPort() {
  const listeners: PortListener[] = [];
  const port = {
    onMessage: { addListener: (l: PortListener) => listeners.push(l) },
    postMessage: vi.fn(),
    disconnect: vi.fn(),
  };
  (chrome.runtime as unknown as Record<string, unknown>).connect = vi.fn(
    () => port,
  );
  return { port, listeners };
}

const emit = (listeners: PortListener[], evt: unknown) => {
  for (const l of listeners) l(evt);
};

const meta = (id: string, title: string) => ({
  id,
  title,
  updatedAt: Date.now(),
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

function renderView() {
  return render(
    <SessionsView onBack={() => {}} onPick={() => {}} onNew={() => {}} activeId="" />,
  );
}

describe("SessionsView 列表读取失败(REQ-P0-3 回归)", () => {
  it("SESSIONS 回包带 error → 错误态而非空态;重试重发 LIST_SESSIONS,成功后列表出现", async () => {
    const user = userEvent.setup();
    const { port, listeners } = installPort();
    renderView();

    expect(port.postMessage).toHaveBeenCalledWith({ type: MSG.LIST_SESSIONS });
    await act(async () => {
      emit(listeners, {
        type: MSG.SESSIONS,
        sessions: [],
        error: "会话存储打开失败",
      }); // i18n-ok 测试种子(后台错误原文)
    });
    expect(await screen.findByText("会话存储打开失败")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: zhCN.common.retry }),
    ).toBeInTheDocument();
    expect(screen.queryByText(zhCN.sessions.empty)).not.toBeInTheDocument();

    // 重试 → 重新拉列表;回包成功 → 错误态退场
    await user.click(screen.getByRole("button", { name: zhCN.common.retry }));
    expect(port.postMessage).toHaveBeenCalledTimes(2);
    await act(async () => {
      emit(listeners, {
        type: MSG.SESSIONS,
        sessions: [meta("s1", "旧会话")],
      });
    });
    await screen.findByText("旧会话");
    expect(screen.queryByText("会话存储打开失败")).not.toBeInTheDocument();
  });

  it("空列表且无 error → 仍走既有空态(不误报为错误)", async () => {
    const { listeners } = installPort();
    renderView();
    await act(async () => {
      emit(listeners, { type: MSG.SESSIONS, sessions: [] });
    });
    expect(await screen.findByText(zhCN.sessions.empty)).toBeInTheDocument();
    expect(screen.queryByText(zhCN.common.loadFailed)).not.toBeInTheDocument();
  });
});
