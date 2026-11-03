// ask_user 反问工具单测(SW 侧):参数校验(1–3 问、每问 2–4 选项、
// header ≤12 字)、发卡等答的端口协议、超时=未答(≠拒绝)、取消、迟到
// 答复忽略、不经确认门(反问无安全后果,与写动作的从严语义分流)。
// 注册表与 SYSTEM_PROMPT 纪律的锚点也在此(面板渲染在 AskCard,另测)。

import { describe, expect, it, vi } from "vitest";
import { requestAskUser, resolveAsk } from "./askUser";
import { needsConfirmation } from "./confirmations";
import { createDispatchToolCall } from "./toolDispatch";
import { listTools } from "../tools/tools";
import { SYSTEM_PROMPT } from "./runSetup";
import type { AgentPort } from "./agent";
import type { ToolExecutionContext } from "../tools/toolContext";

/** 记录型假 port(与 confirmations.test 同款) */
function makeFakePort() {
  const sent: unknown[] = [];
  return { port: { postMessage: (m: unknown) => sent.push(m) } as AgentPort, sent };
}

const ONE_Q = {
  questions: [
    {
      question: "要操作哪个标签页?",
      header: "目标页", // i18n-ok 协议 mock 数据(header 上限用例),非 UI 文案断言
      options: [
        { label: "结算页", description: "example.com 的结算" },
        { label: "商品列表" },
      ],
    },
  ],
};

describe("ask_user 参数校验(工具层硬校验,violation 直接打回)", () => {
  it("合法:1–3 问、每问 2–4 选项、可选 header/multiSelect", async () => {
    const { port, sent } = makeFakePort();
    const pending = requestAskUser(port, {
      questions: [
        { question: "Q1?", options: [{ label: "A" }, { label: "B" }] },
          {
            question: "Q2?",
            header: "偏好", // i18n-ok 协议 mock 数据,非 UI 文案断言
            options: [{ label: "X" }, { label: "Y" }, { label: "Z" }],
            multiSelect: true,
          },
        { question: "Q3?", options: [{ label: "M" }, { label: "N" }] },
      ],
    });
    // 校验失败会在 postMessage 前抛出;载荷到达即校验通过
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const req = sent[0] as { requestId: string };
    resolveAsk(req.requestId, [
      { selected: ["A"] },
      { selected: ["X", "Z"] },
      { selected: ["M"] },
    ]);
    const result = JSON.parse(await pending);
    expect(result.answers).toHaveLength(3);
    expect(result.answers[1].selected).toEqual(["X", "Z"]);
  });

  it("问题数越界(0 / 4)与选项数越界(1 / 5)都打回", async () => {
    const { port } = makeFakePort();
    const q = (n: number, label: string) => ({
      question: "Q?",
      options: Array.from({ length: n }, (_, i) => ({ label: `${label}${i}` })),
    });
    await expect(
      requestAskUser(port, { questions: [] }),
    ).rejects.toThrow(/questions/i);
    await expect(
      requestAskUser(port, { questions: [q(1, "o"), q(2, "p"), q(3, "q"), q(4, "s")] }),
    ).rejects.toThrow(/questions/i);
    await expect(
      requestAskUser(port, { questions: [q(1, "only")] }),
    ).rejects.toThrow(/options/i);
    await expect(
      requestAskUser(port, { questions: [q(5, "over")] }),
    ).rejects.toThrow(/options/i);
  });

  it("空问题文本 / 空 label / header 超 12 字打回", async () => {
    const { port } = makeFakePort();
    await expect(
      requestAskUser(port, {
        questions: [{ question: "  ", options: [{ label: "A" }, { label: "B" }] }],
      }),
    ).rejects.toThrow(/question/i);
    await expect(
      requestAskUser(port, {
        questions: [{ question: "Q?", options: [{ label: "" }, { label: "B" }] }],
      }),
    ).rejects.toThrow(/label/i);
    await expect(
      requestAskUser(port, {
        questions: [
          {
            question: "Q?",
            header: "一二三四五六七八九十一二三",
            options: [{ label: "A" }, { label: "B" }],
          },
        ],
      }),
    ).rejects.toThrow(/header/i);
  });
});

describe("ask_user 端口协议与回填", () => {
  it("发 AGENT_ASK_REQUEST(问题透传 + 5 分钟口径),答复按 id 结算为结构化 JSON", async () => {
    const { port, sent } = makeFakePort();
    const pending = requestAskUser(port, ONE_Q);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const req = sent[0] as {
      type: string;
      requestId: string;
      questions: unknown[];
      timeoutMs: number;
    };
    expect(req.type).toBe("agent_ask_request");
    expect(req.questions).toEqual(ONE_Q.questions);
    expect(req.timeoutMs).toBe(300_000);
    resolveAsk(req.requestId, [{ selected: ["结算页"] }]);
    const result = JSON.parse(await pending);
    expect(result.answers).toEqual([
      { question: "要操作哪个标签页?", selected: ["结算页"] },
    ]);
  });

  it("「其他」自由文本随 text 字段回填(单选也可只给 text)", async () => {
    const { port, sent } = makeFakePort();
    const pending = requestAskUser(port, ONE_Q);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const req = sent[0] as { requestId: string };
    resolveAsk(req.requestId, [{ selected: [], text: "都不对,用第三个" }]);
    const result = JSON.parse(await pending);
    expect(result.answers[0].text).toBe("都不对,用第三个");
    expect(result.answers[0].selected).toEqual([]);
  });

  it("超时(5 分钟)→ 未答而非拒绝:status=unanswered + 让模型自行决断的注记", async () => {
    vi.useFakeTimers();
    try {
      const { port } = makeFakePort();
      const pending = requestAskUser(port, ONE_Q);
      await vi.advanceTimersByTimeAsync(300_000);
      const result = JSON.parse(await pending);
      expect(result.status).toBe("unanswered");
      expect(result.note).toContain("best judgment");
    } finally {
      vi.useRealTimers();
    }
  });

  it("run 取消(abort)→ 未答结算,等待不阻塞取消", async () => {
    const { port } = makeFakePort();
    const ac = new AbortController();
    const pending = requestAskUser(port, ONE_Q, ac.signal);
    ac.abort();
    expect(JSON.parse(await pending).status).toBe("unanswered");
  });

  it("未知 requestId 的迟到答复被静默忽略", async () => {
    const { port, sent } = makeFakePort();
    const pending = requestAskUser(port, ONE_Q);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const req = sent[0] as { requestId: string };
    resolveAsk("not-a-real-id", [{ selected: ["商品列表"] }]);
    resolveAsk(req.requestId, [{ selected: ["结算页"] }]);
    expect(JSON.parse(await pending).answers[0].selected).toEqual(["结算页"]);
  });
});

describe("ask_user 注册表与门控归属", () => {
  it("在注册表、不标 write、schema 必填 questions", () => {
    const tool = listTools().find((t) => t.name === "ask_user");
    expect(tool, "ask_user 必须在注册表").toBeTruthy();
    expect(tool?.write).not.toBe(true);
    expect(tool?.parameters.required).toContain("questions");
  });

  it("不经确认门(三档全 false):反问无安全后果,不与写动作的从严语义混流", () => {
    for (const level of ["strict", "auto", "off"] as const) {
      expect(needsConfirmation("ask_user", ONE_Q, level)).toBe(false);
    }
  });

  it("SYSTEM_PROMPT 含反问纪律(唯一提问通道/不替代确认门/上限)", () => {
    expect(SYSTEM_PROMPT).toContain("ask_user");
    expect(SYSTEM_PROMPT).toMatch(/confirm/i);
    expect(SYSTEM_PROMPT).toMatch(/2-4|2–4/);
  });

  it("dispatch 特判走 ask 通道:确认门不拦、答复可经 resolveAsk 结算", async () => {
    const { port, sent } = makeFakePort();
    const gate = vi.fn(() => false); // ask_user 永不该过门
    const dispatch = createDispatchToolCall(
      gate,
      {} as ToolExecutionContext,
      port,
      undefined,
      new Set<string>(),
    );
    const pending = dispatch("ask_user", ONE_Q);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const req = sent[0] as { requestId: string };
    resolveAsk(req.requestId, [{ selected: ["结算页"] }]);
    const result = JSON.parse(String(await pending));
    expect(result.answers[0].selected).toEqual(["结算页"]);
    expect(gate).not.toHaveBeenCalledWith("ask_user", expect.anything());
  });
});
