// @vitest-environment jsdom
// useAgentChannel 的 HISTORY 回包新鲜度判定:回包自带 sessionId,面板只认
// 「响应会话 == 当前会话」的包 —— 快速切会话时迟到的旧回包不得把 A 的转写
// 盖上 B 的 id(串台 bug,此处钉死回归)。

import { cleanup, renderHook, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MSG } from "../../shared/messages";
import { useAgentChannel } from "./useAgentChannel";

afterEach(cleanup);

/** 替换 vitest.setup 的 chrome.runtime.connect 为可控假 port */
function installFakePort() {
  const listeners: ((msg: unknown) => void)[] = [];
  const sent: Record<string, unknown>[] = [];
  const port = {
    onMessage: { addListener: (fn: (msg: unknown) => void) => listeners.push(fn) },
    onDisconnect: { addListener: vi.fn() },
    postMessage: (msg: Record<string, unknown>) => sent.push(msg),
    disconnect: vi.fn(),
  };
  const prevChrome = (globalThis as Record<string, unknown>).chrome as
    | Record<string, unknown>
    | undefined;
  (globalThis as Record<string, unknown>).chrome = {
    ...(prevChrome ?? {}),
    runtime: { lastError: null, connect: vi.fn(() => port) },
  };
  return {
    deliver: (msg: unknown) => {
      for (const fn of listeners) fn(msg);
    },
    sent,
  };
}

const historyEvt = (sessionId: string, texts: string[], resync = false) => ({
  type: MSG.HISTORY,
  sessionId,
  messages: texts.map((content, seq) => ({ role: "user" as const, content, seq })),
  ...(resync ? { resync: true } : {}),
});

describe("useAgentChannel HISTORY 回包新鲜度", () => {
  it("快速切会话:A 的迟到回包不落盘,B 的回包正常填充", () => {
    const io = installFakePort();
    const { result } = renderHook(() =>
      useAgentChannel({ resumeSessionId: null, onResumeDone: vi.fn() }),
    );

    act(() => result.current.openSession("session-a"));
    act(() => result.current.openSession("session-b"));
    const loads = io.sent.filter((m) => m.type === MSG.LOAD_HISTORY);
    expect(loads.map((m) => (m as { sessionId: string }).sessionId)).toEqual([
      "session-a",
      "session-b",
    ]);

    // A 的回包晚到(此时当前会话已是 B):必须整包作废,不得盖上 B 的 id
    act(() => io.deliver(historyEvt("session-a", ["A 的转写"])));
    expect(result.current.messages).toEqual([]);

    // B 自己的回包随后到:正常填充(串台 bug 下它会被误判「已有」而丢弃)
    act(() => io.deliver(historyEvt("session-b", ["B 的第一问", "B 的第二问"])));
    expect(result.current.messages).toHaveLength(2);
    expect(
      result.current.messages.every((m) => m.sessionId === "session-b"),
    ).toBe(true);
    expect(result.current.currentSession).toBe("session-b");
  });

  it("同会话回包幂等:本地已有该会话记录时保留本地", () => {
    const io = installFakePort();
    const { result } = renderHook(() =>
      useAgentChannel({ resumeSessionId: null, onResumeDone: vi.fn() }),
    );

    act(() => result.current.openSession("session-a"));
    act(() => io.deliver(historyEvt("session-a", ["第一问"])));
    act(() => io.deliver(historyEvt("session-a", ["迟到的另一份"])));
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).toMatchObject({
      sessionId: "session-a",
      content: "第一问",
    });
  });
});
