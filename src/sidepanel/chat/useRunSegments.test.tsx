// @vitest-environment jsdom
// useRunSegments 纯状态 hook 单测:落段 / 缓冲合帧 / 收口 / 归档 / 断连兜底
// 的状态机此前只有 e2e 慢链路覆盖,这里把转移规则钉死。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { MSG } from "../../shared/messages";
import { useRunSegments } from "./useRunSegments";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** 过掉 ~10Hz 合帧节拍(100ms) */
const flush = () => act(() => vi.advanceTimersByTime(120));

const toolCall = (id: string, name = "web_search") =>
  ({ type: MSG.AGENT_TOOL_CALL, id, name, args: { q: 1 } }) as const;
const toolResult = (id: string, ok: boolean) =>
  ({ type: MSG.AGENT_TOOL_RESULT, id, name: "web_search", ok, result: "r" }) as const;

describe("useRunSegments 段状态机", () => {
  it("文本首块立即上屏,尾部 delta 经 ~10Hz 节拍合并进同段不丢字", () => {
    const { result } = renderHook(() => useRunSegments(vi.fn()));
    act(() => result.current.onMessageDelta("你"));
    expect(result.current.runSegs).toHaveLength(1);
    expect(result.current.runSegs[0]).toMatchObject({ kind: "text", text: "你" });

    act(() => {
      result.current.onMessageDelta("好");
      result.current.onMessageDelta("呀");
    });
    flush();
    expect(result.current.runSegs).toHaveLength(1);
    expect(result.current.runSegs[0]).toMatchObject({ kind: "text", text: "你好呀" });
  });

  it("thinking 事件切断文本段:后续 delta 开新段而非续接", () => {
    const { result } = renderHook(() => useRunSegments(vi.fn()));
    act(() => {
      result.current.onMessageDelta("第一段");
      result.current.onThinking();
      result.current.onMessageDelta("第二段");
    });
    const kinds = result.current.runSegs.map((s) => s.kind);
    expect(kinds).toEqual(["text", "text"]);
    flush();
    expect(result.current.runSegs[0]).toMatchObject({ text: "第一段" });
    expect(result.current.runSegs[1]).toMatchObject({ text: "第二段" });
  });

  it("同轮内思考段插进文本流:尾部缓冲仍归属前一段,不丢字", () => {
    const { result } = renderHook(() => useRunSegments(vi.fn()));
    act(() => {
      result.current.onMessageDelta("叙述1"); // 首 delta 立即上屏
      result.current.onMessageDelta("-尾巴"); // 进缓冲(还没到 ~10Hz 节拍)
      result.current.onReasoningDelta("想2"); // 服务端工具轮:同轮第二个思考块
      result.current.onMessageDelta("叙述2");
    });
    flush();
    expect(
      result.current.runSegs.map((s) => (s.kind === "tool" ? s.name : s.text)),
    ).toEqual(["叙述1-尾巴", "想2", "叙述2"]);
  });

  it("思考段独立落段,消息 delta 到达时收口(active=false)", () => {
    const { result } = renderHook(() => useRunSegments(vi.fn()));
    act(() => result.current.onReasoningDelta("我在想"));
    expect(result.current.runSegs[0]).toMatchObject({
      kind: "reasoning",
      text: "", // 段先出现,文本由节拍供给
      active: true,
    });
    flush();
    expect(result.current.runSegs[0]).toMatchObject({ text: "我在想" });

    act(() => result.current.onMessageDelta("答"));
    expect(result.current.runSegs[0]).toMatchObject({
      kind: "reasoning",
      active: false,
    });
    expect(result.current.runSegs[1]).toMatchObject({ kind: "text" });
  });

  it("工具段落段为 running,结果按 ok 归位 done/error;未知 id 无副作用", () => {
    const { result } = renderHook(() => useRunSegments(vi.fn()));
    act(() => result.current.onToolCall(toolCall("t1")));
    expect(result.current.runSegs[0]).toMatchObject({
      kind: "tool",
      id: "t1",
      status: "running",
    });

    act(() => result.current.onToolResult(toolResult("ghost", true)));
    expect(result.current.runSegs[0]).toMatchObject({ status: "running" });

    act(() => result.current.onToolResult(toolResult("t1", false)));
    expect(result.current.runSegs[0]).toMatchObject({ status: "error" });
  });

  it("onSettled 收口:冲刷缓冲、残留 running 工具归一 done、阶段转 settled", () => {
    const { result } = renderHook(() => useRunSegments(vi.fn()));
    act(() => {
      result.current.onToolCall(toolCall("t1"));
      result.current.onMessageDelta("没写完的尾");
    });
    act(() => result.current.onSettled());
    expect(result.current.runSegs).toHaveLength(2);
    expect(result.current.runSegs[0]).toMatchObject({ kind: "tool", status: "done" });
    expect(result.current.runSegs[1]).toMatchObject({ kind: "text", text: "没写完的尾" });
    expect(result.current.runPhase).toBe("settled");
    expect(result.current.runEndedAt).not.toBeNull();
  });

  it("archiveTexts:非空文本段转出口回调并移除,工具段保留,空白段不归档", () => {
    const archive = vi.fn();
    const { result } = renderHook(() => useRunSegments(archive));
    act(() => {
      result.current.onMessageDelta("答案A");
      result.current.onToolCall(toolCall("t1"));
      result.current.onMessageDelta("  "); // 空白段:与渲染侧同规则跳过
      result.current.onThinking(); // 切断,下一 delta 开新段
      result.current.onMessageDelta("答案B");
    });
    flush();
    act(() => result.current.archiveTexts());
    expect(archive).toHaveBeenCalledWith(["答案A", "答案B"]);
    expect(result.current.runSegs.map((s) => s.kind)).toEqual(["tool"]);
  });

  it("onStarted:先归档上一轮文本,再开新一轮(清段、转 live)", () => {
    const archive = vi.fn();
    const { result } = renderHook(() => useRunSegments(archive));
    act(() => {
      result.current.onMessageDelta("上一轮答案");
      result.current.onSettled();
    });
    act(() => result.current.onStarted());
    expect(archive).toHaveBeenCalledWith(["上一轮答案"]);
    expect(result.current.runSegs).toEqual([]);
    expect(result.current.runPhase).toBe("live");
    expect(result.current.runEndedAt).toBeNull();
  });

  it("onPortDisconnected:live 中断则收口兜底;settled 回看态不动", () => {
    const { result } = renderHook(() => useRunSegments(vi.fn()));
    act(() => {
      result.current.onStarted(); // live
      result.current.onToolCall(toolCall("t1"));
    });
    expect(result.current.runPhase).toBe("live");
    act(() => result.current.onPortDisconnected());
    expect(result.current.runPhase).toBe("settled");
    expect(result.current.runSegs[0]).toMatchObject({ status: "done" });

    const endedAt = result.current.runEndedAt;
    act(() => result.current.onPortDisconnected());
    expect(result.current.runEndedAt).toBe(endedAt); // 已结束的展示不被扰动
  });

  it("toggleGroup 以段下标为键开合回看卡", () => {
    const { result } = renderHook(() => useRunSegments(vi.fn()));
    act(() => result.current.toggleGroup(2));
    expect(result.current.openGroups.has(2)).toBe(true);
    act(() => result.current.toggleGroup(2));
    expect(result.current.openGroups.has(2)).toBe(false);
  });
});
