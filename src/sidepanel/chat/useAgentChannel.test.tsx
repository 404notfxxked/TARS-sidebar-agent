// @vitest-environment jsdom
// useAgentChannel 的 hook 层单测,三块:
// 1) HISTORY 回包新鲜度:回包自带 sessionId,只认「响应会话 == 当前会话」
//    —— 快速切会话时迟到的旧回包不得串台(回归钉死)
// 2) 提交失败护栏(REQ-P0-2):postMessage 同步抛错 = 消息未抵达后台,
//    断言返回 false / 气泡转未送达 / retrySubmit 重发同路径
// 3) HISTORY 兜底回包:历史读取失败必须可见,不得伪装成空会话

import { cleanup, renderHook, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MSG } from "../../shared/messages";
import { useAgentChannel, type SubmitArgs } from "./useAgentChannel";

afterEach(cleanup);

/** 替换 vitest.setup 的 chrome.runtime.connect 为可控假 port;
 *  failSend = postMessage 同步抛错(端口断开形态) */
function installFakePort(opts: { failSend?: boolean } = {}) {
  const listeners: ((msg: unknown) => void)[] = [];
  const sent: Record<string, unknown>[] = [];
  const port = {
    onMessage: { addListener: (fn: (msg: unknown) => void) => listeners.push(fn) },
    onDisconnect: { addListener: vi.fn() },
    postMessage: vi.fn((msg: Record<string, unknown>) => {
      if (opts.failSend) throw new Error("Extension context invalidated.");
      sent.push(msg);
    }),
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
    postMessage: port.postMessage,
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

describe("useAgentChannel 提交失败护栏(REQ-P0-2)", () => {
  const baseArgs = (): SubmitArgs => ({ sessionId: "s1", text: "你好" });

  it("发送成功:返回 true,乐观气泡正常入列,无未送达标记", () => {
    installFakePort();
    const { result } = renderHook(() =>
      useAgentChannel({ resumeSessionId: null, onResumeDone: vi.fn() }),
    );
    let delivered = false;
    act(() => {
      delivered = result.current.submitUserMessage(baseArgs());
    });
    expect(delivered).toBe(true);
    expect(result.current.messages[0]).toMatchObject({
      role: "user",
      content: "你好",
    });
    expect(result.current.messages[0]?.sendFailed).toBeUndefined();
  });

  it("postMessage 抛错:返回 false,乐观气泡转未送达并携带原参数", () => {
    installFakePort({ failSend: true });
    const { result } = renderHook(() =>
      useAgentChannel({ resumeSessionId: null, onResumeDone: vi.fn() }),
    );
    let delivered = true;
    act(() => {
      delivered = result.current.submitUserMessage(baseArgs());
    });
    expect(delivered).toBe(false);
    expect(result.current.messages[0]).toMatchObject({
      role: "user",
      content: "你好",
      sendFailed: true,
    });
  });

  it("retrySubmit 重发原参数:成功后墓碑移除、消息按新提交入列", () => {
    const args = baseArgs();
    const io = installFakePort({ failSend: true });
    const { result } = renderHook(() =>
      useAgentChannel({ resumeSessionId: null, onResumeDone: vi.fn() }),
    );
    act(() => {
      result.current.submitUserMessage(args);
    });
    expect(result.current.messages[0]?.sendFailed).toBe(true);
    // 连接恢复:重发应送达
    io.postMessage.mockImplementation(() => {});
    let delivered = false;
    act(() => {
      delivered = result.current.retrySubmit(args);
    });
    expect(delivered).toBe(true);
    const ms = result.current.messages;
    expect(ms.filter((m) => m.sendFailed).length).toBe(0);
    expect(ms[0]).toMatchObject({ role: "user", content: "你好" });
    // 重发走的仍是 USER_MESSAGE 同一路径,且 payload 原样(首呼抛错前也已计数)
    const userMsgs = io.postMessage.mock.calls
      .map((c) => c[0] as { type?: string; payload?: { text?: string } })
      .filter((m) => m.type === MSG.USER_MESSAGE);
    expect(userMsgs.length).toBe(2);
    expect(userMsgs[1]?.payload?.text).toBe("你好");
  });

  it("重试再次失败:墓碑仍在(携带原参数可继续重试)", () => {
    const args = baseArgs();
    installFakePort({ failSend: true });
    const { result } = renderHook(() =>
      useAgentChannel({ resumeSessionId: null, onResumeDone: vi.fn() }),
    );
    act(() => {
      result.current.submitUserMessage(args);
    });
    act(() => {
      expect(result.current.retrySubmit(args)).toBe(false);
    });
    const failed = result.current.messages.filter((m) => m.sendFailed);
    expect(failed.length).toBe(1);
    expect(failed[0]?.failedSubmit).toBe(args);
  });

  it("图片附件随原参数重发(USER_MESSAGE payload 原样携带)", () => {
    const args: SubmitArgs = {
      ...baseArgs(),
      images: [{ id: "i1", mime: "image/png", w: 10, h: 10, base64: "AA", url: "blob:x" }],
    };
    const io = installFakePort({ failSend: true });
    const { result } = renderHook(() =>
      useAgentChannel({ resumeSessionId: null, onResumeDone: vi.fn() }),
    );
    act(() => {
      result.current.submitUserMessage(args);
    });
    io.postMessage.mockImplementation(() => {});
    act(() => {
      expect(result.current.retrySubmit(args)).toBe(true);
    });
    const sent = io.postMessage.mock.calls
      .map((c) => c[0] as { type?: string; payload?: { images?: unknown[] } })
      .find((m) => m.type === MSG.USER_MESSAGE);
    expect(sent?.payload?.images?.length).toBe(1);
  });
});

describe("useAgentChannel HISTORY 兜底回包(读取失败可见)", () => {
  it("当前会话的历史读取失败:落一条错误气泡,不伪装成空会话", () => {
    const io = installFakePort();
    const { result } = renderHook(() =>
      useAgentChannel({ resumeSessionId: null, onResumeDone: vi.fn() }),
    );
    // 先让 sessionRef 指向 s1(提交路径会设置;送达形态)
    act(() => {
      result.current.submitUserMessage({ sessionId: "s1", text: "第一问" });
    });
    act(() => {
      io.deliver({
        type: MSG.HISTORY,
        sessionId: "s1",
        messages: [],
        error: "历史存储打开失败", // i18n-ok 测试种子(后台错误原文)
      });
    });
    const errBubble = result.current.messages.find((m) => m.error);
    expect(errBubble).toMatchObject({
      role: "assistant",
      content: "历史存储打开失败",
      sessionId: "s1",
    });
  });

  it("非当前会话的错误回包不串台;resync 失败静默(断连提示已在场)", () => {
    const io = installFakePort();
    const { result } = renderHook(() =>
      useAgentChannel({ resumeSessionId: null, onResumeDone: vi.fn() }),
    );
    act(() => {
      result.current.submitUserMessage({ sessionId: "s1", text: "第一问" });
    });
    act(() => {
      io.deliver({
        type: MSG.HISTORY,
        sessionId: "other", // i18n-ok 测试种子(会话 id,非 UI 文案)
        messages: [],
        error: "旧会话的错",
      });
    });
    expect(result.current.messages.find((m) => m.error)).toBeUndefined();
    // resync 失败:不加气泡也不清视图
    act(() => {
      io.deliver({
        type: MSG.HISTORY,
        sessionId: "s1",
        messages: [],
        resync: true,
        error: "重同步失败",
      });
    });
    expect(result.current.messages.find((m) => m.error)).toBeUndefined();
    expect(
      result.current.messages.filter((m) => m.role === "user").length,
    ).toBe(1);
  });

  it("retryLoadHistory 清场重拉:失败气泡移除、幂等守卫放开,成功回包得以填充", () => {
    const io = installFakePort();
    const { result } = renderHook(() =>
      useAgentChannel({ resumeSessionId: null, onResumeDone: vi.fn() }),
    );
    act(() => {
      result.current.submitUserMessage({ sessionId: "s1", text: "第一问" });
    });
    act(() => {
      io.deliver({
        type: MSG.HISTORY,
        sessionId: "s1",
        messages: [],
        error: "历史存储打开失败",
      });
    });
    expect(
      result.current.messages.some((m) => m.historyError),
    ).toBe(true);
    act(() => {
      result.current.retryLoadHistory("s1");
    });
    // 本地清场:失败气泡与旧视图一并移除(不清场则 applyHistory 的
    // 「本地已有则保留」守卫会丢弃成功回包,重试永远拿到同一条失败)
    expect(
      result.current.messages.filter((m) => m.sessionId === "s1"),
    ).toHaveLength(0);
    // 去重守卫已放开:重新发出 LOAD_HISTORY
    const loads = io.sent.filter((m) => m.type === MSG.LOAD_HISTORY);
    expect(loads.at(-1)).toMatchObject({ sessionId: "s1" });
    // 成功回包正常填充(守卫放开的回归证明)
    act(() => {
      io.deliver(historyEvt("s1", ["恢复的转写"]));
    });
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).toMatchObject({ content: "恢复的转写" });
  });
});
