// @vitest-environment jsdom
// MessageList 的错误气泡挂线回归:两种「重试」语义必须分流——
//  - 历史读取失败气泡(historyError):挂 onRetryLoadHistory(重新拉历史)
//  - run 错误气泡(末条普通 error):挂 regenerate(重跑上一问)
// 历史失败气泡曾被误挂 regenerate:点「重试」静默截库重跑上一问
// (花 token、改库),与按钮文案「重试」的语义相悖。

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { RefObject } from "react";
import type { ChatMsg } from "./useAgentChannel";
import MessageList from "./MessageList";
import { zhCN } from "../../shared/i18n/locales/zh-CN";

afterEach(cleanup);

const baseMsg = (over: Partial<ChatMsg> = {}): ChatMsg => ({
  role: "assistant",
  content: "出错了",
  sessionId: "s1",
  ...over,
});

function renderList(
  messages: ChatMsg[],
  handlers: { regenerate: () => void; retryLoad: (sessionId: string) => void },
) {
  const listRef: RefObject<HTMLDivElement | null> = { current: null };
  return render(
    <MessageList
      listRef={listRef}
      messages={messages}
      currentSession="s1"
      status="idle"
      compaction={null}
      runSegs={[]}
      runPhase="live"
      runEndedAt={null}
      openGroups={new Set()}
      toggleGroup={() => {}}
      regenerate={handlers.regenerate}
      memorySaved={0}
      onOpenMemory={() => {}}
      onPickEmpty={() => {}}
      onRetryLoadHistory={handlers.retryLoad}
      atBottom
      onJumpLatest={() => {}}
    />,
  );
}

describe("MessageList 错误气泡的两种重试语义", () => {
  it("历史读取失败气泡:重试挂 onRetryLoadHistory(带 sessionId),不挂 regenerate", async () => {
    const user = userEvent.setup();
    const regenerate = vi.fn();
    const retryLoad = vi.fn();
    renderList([baseMsg({ error: true, historyError: true })], {
      regenerate: () => regenerate(),
      retryLoad: (id: string) => retryLoad(id),
    });

    await user.click(screen.getByRole("button", { name: zhCN.chat.retry }));
    expect(retryLoad).toHaveBeenCalledWith("s1");
    expect(regenerate).not.toHaveBeenCalled();
  });

  it("run 错误气泡(末条):重试仍挂 regenerate,语义不变", async () => {
    const user = userEvent.setup();
    const regenerate = vi.fn();
    const retryLoad = vi.fn();
    renderList([baseMsg({ error: true })], {
      regenerate: () => regenerate(),
      retryLoad: (id: string) => retryLoad(id),
    });

    await user.click(screen.getByRole("button", { name: zhCN.chat.retry }));
    expect(regenerate).toHaveBeenCalledTimes(1);
    expect(retryLoad).not.toHaveBeenCalled();
  });
});
