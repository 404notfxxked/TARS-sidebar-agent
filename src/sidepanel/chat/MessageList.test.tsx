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
  compaction: { uptoSeq: number } | null = null,
) {
  const listRef: RefObject<HTMLDivElement | null> = { current: null };
  return render(
    <MessageList
      listRef={listRef}
      messages={messages}
      currentSession="s1"
      status="idle"
      compaction={compaction}
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

describe("压缩分隔条落点(库 seq 口径)", () => {
  // 契约的消费端一半:落库的 uptoSeq 是库 seq(未滤错误行),面板拿
  // ChatRecord.seq 直接比对。生产端的映射锚在 sessionHistory.test.ts
  // (saveCompaction 落库前换算),两半钉的是同一份口径
  it("含错误行的回放:分隔条画在库 seq 超过压缩点的首条之前,不被错误行挤偏", () => {
    // seq 2 是失败轮错误行(prompt/压缩空间滤掉它);压缩点落在「答一」
    // (库 seq 1)时,首条 seq > 1 的记录是错误行自己
    const messages: ChatMsg[] = [
      { role: "user", content: "问一", sessionId: "s1", seq: 0 },
      { role: "assistant", content: "答一", sessionId: "s1", seq: 1 },
      {
        role: "assistant",
        content: "Error: quota",
        sessionId: "s1",
        seq: 2,
        error: true,
      },
      { role: "user", content: "问二", sessionId: "s1", seq: 3 },
      { role: "assistant", content: "答二", sessionId: "s1", seq: 4 },
    ];
    renderList(messages, { regenerate: () => {}, retryLoad: () => {} }, {
      uptoSeq: 1,
    });

    const divider = screen.getByRole("note", {
      name: zhCN.chat.compactionNote,
    });
    const kids = [...divider.parentElement!.children];
    const di = kids.indexOf(divider);
    // 前一段是最后一条被压缩的消息(答一),后一段是压缩点后首条(错误行)
    expect(kids[di - 1].textContent).toContain("答一");
    expect(kids[di + 1].textContent).toContain("quota");
  });
});
