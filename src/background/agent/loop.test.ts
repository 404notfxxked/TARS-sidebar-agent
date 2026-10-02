// runTurns 的收尾守卫:端点没给正文时不许落成空气泡 —— 实况是「什么都没发生」、
// 回放也看不出,属静默失败;必须走 run 的错误路径(AGENT_ERROR + 失败轮 error 行)。
// TurnDeps 把 callChat / dispatchToolCall / port 全做成了入参,不需要 chrome 环境。

import { describe, expect, it } from "vitest";
import { MSG, type AgentEvent } from "../../shared/messages";
import type { ChatResult } from "../provider";
import type { AgentPort, RunLoopState } from "./agent";
import { runTurns, type TurnDeps } from "./loop";
import type { RunCfg } from "./runSetup";

function makeLoop(): RunLoopState {
  return {
    messages: [{ role: "user", content: "问" }],
    persistedSeqs: 0,
    libraryRowsAtStart: 0,
    persistedInCtx: 0,
    savedUpTo: 0,
    memoryMsg: null,
    runImages: [],
    imageBytes: new Map(),
    emergency: null,
    turnNo: 0,
    completed: false,
    truncatedByLength: false,
    lastUsage: undefined,
    persistFailure: null,
  };
}

/** 只给 runTurns 真正读到的字段其余字段与本用例无关 */
const cfg = {
  config: { model: "m1" },
  cur: { id: "p1" },
  modelEntry: undefined,
  toolResultBudgetChars: 4000,
  confirmLevel: "off",
} as unknown as RunCfg;

function makeDeps(reply: ChatResult, events: AgentEvent[]): TurnDeps {
  const port: AgentPort = { postMessage: (e) => events.push(e) };
  return {
    cfg,
    port,
    sessionId: undefined, // 不落盘:本用例只验循环收口口径
    fetchAllowlist: new Set<string>(),
    confirmGate: () => false, // 本用例无工具调用,门不参与
    callChat: async () => reply,
    dispatchToolCall: async () => ({}),
  };
}

describe("runTurns 的空回答守卫", () => {
  it("无工具调用且正文为空:抛错(由 run 的错误路径收口),不落成空气泡", async () => {
    await expect(
      runTurns(makeLoop(), makeDeps({ content: "", toolCalls: [] }, [])),
    ).rejects.toThrow(/没有返回任何正文/);
  });

  it("正文只有空白同样算空(按 trim 判)", async () => {
    await expect(
      runTurns(makeLoop(), makeDeps({ content: "  \n ", toolCalls: [] }, [])),
    ).rejects.toThrow(/没有返回任何正文/);
  });

  it("有正文时照常收束:落 assistant 行 + AGENT_DONE(complete)", async () => {
    const events: AgentEvent[] = [];
    const loop = makeLoop();
    await runTurns(loop, makeDeps({ content: "答", toolCalls: [] }, events));
    expect(loop.completed).toBe(true);
    expect(loop.messages[loop.messages.length - 1]).toMatchObject({
      role: "assistant",
      content: "答",
    });
    expect(events[events.length - 1]).toMatchObject({
      type: MSG.AGENT_DONE,
      reason: "complete",
    });
  });
});
