// 撞窗紧急压缩纯决策单测:重试门的三条件与投影索引算术(+2 换算)。
// 此前这段逻辑内联在 callChat 闭包里,e2e 才能碰到(2026-09 评审 T8)。

import { describe, expect, it } from "vitest";
import type { InternalMsg } from "../provider";
import { projectEmergency, shouldEmergencyCompact } from "./overflow";

const sys = (t: string): InternalMsg => ({ role: "system", content: t });
const user = (t: string): InternalMsg => ({ role: "user", content: t });
const assistant = (t: string): InternalMsg => ({
  role: "assistant",
  content: t,
});
const overflowErr = new Error(
  "This model's maximum context length is 4096 tokens",
);

describe("shouldEmergencyCompact 重试门", () => {
  it("三条件齐备才重试:未压过 + 有窗口声明 + 撞窗文案", () => {
    expect(shouldEmergencyCompact(overflowErr, null, 8192)).toBe(true);
  });
  it("已压过仍撞窗(emergency 非空)不再重试", () => {
    expect(
      shouldEmergencyCompact(overflowErr, { summaryMsg: user("s"), afterIdx: 3 }, 8192),
    ).toBe(false);
  });
  it("模型未声明 contextTokens 不重试(无从估算目标窗口)", () => {
    expect(shouldEmergencyCompact(overflowErr, null, undefined)).toBe(false);
  });
  it("非撞窗错误(429/鉴权/断连)不误入紧急压缩路径", () => {
    expect(shouldEmergencyCompact(new Error("HTTP 429"), null, 8192)).toBe(false);
    expect(shouldEmergencyCompact(new Error("HTTP 401"), null, 8192)).toBe(false);
    expect(shouldEmergencyCompact(new Error("connection refused"), null, 8192)).toBe(
      false,
    );
  });
});

describe("projectEmergency 发送投影", () => {
  const messages = [
    sys("system prompt"),
    user("问1"),
    assistant("答1"),
    user("问2"),
    assistant("答2"),
    user("问3"),
  ];

  it("摘要插在 system 后,真实消息从 afterIdx 起,原数组不被 mutate", () => {
    // compactHistory 吃 slice(1),uptoSeq=1(问1/答1 进摘要)→ +2 = 3
    const summaryMsg = user("<context-summary>问1答1的摘要</context-summary>");
    const out = projectEmergency(messages, summaryMsg, 3);
    expect(out).toHaveLength(5);
    expect(out[0]).toBe(messages[0]); // system 原位
    expect(out[1]).toBe(summaryMsg); // 摘要紧随
    expect(out.slice(2)).toEqual(messages.slice(3)); // 问2 起
    expect(messages).toHaveLength(6); // 原数组不动(持久化锚点依赖)
  });

  it("afterIdx 越界(全量进摘要)时只剩 system + 摘要", () => {
    const summaryMsg = user("<context-summary>全部</context-summary>");
    const out = projectEmergency(messages, summaryMsg, 99);
    expect(out).toEqual([messages[0], summaryMsg]);
  });
});
