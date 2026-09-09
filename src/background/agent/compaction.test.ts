// compaction 纯逻辑单测:窗口公式 / 档位阈值 / 切分与滚动合并(stub provider)/
// 撞窗文案识别 / 摘要消息形状。此前这些只被 verify-compaction 的慢 e2e 覆盖。

import { describe, expect, it } from "vitest";
import {
  THRESHOLDS,
  compactHistory,
  isContextOverflow,
  summaryToMsg,
  shouldCompact,
  usableTokens,
} from "./compaction";
import type { ChatProvider, InternalMsg } from "../provider/types";

const user = (content: string): InternalMsg => ({ role: "user", content });
const assistant = (content: string): InternalMsg => ({ role: "assistant", content });

/** n 轮「一问一答」历史,user 内容带 <user-request> 包裹(与真实 wire 一致) */
function turns(n: number): InternalMsg[] {
  const out: InternalMsg[] = [];
  for (let i = 1; i <= n; i++) {
    out.push(user(`<user-request>问题${i}</user-request>`));
    out.push(assistant(`回答${i}`));
  }
  return out;
}

/** 记录请求并返回定长摘要的 provider 桩 */
function stubSummarizer(summary: string) {
  const requests: InternalMsg[][] = [];
  const provider: ChatProvider = {
    chat: async (req) => {
      requests.push(req.messages);
      return { content: summary, toolCalls: [] };
    },
  };
  return { provider, requests };
}

describe("usableTokens", () => {
  it("窗口 = context − max − 20% 余量", () => {
    expect(usableTokens(10_000, 2_000)).toBe(6_000);
  });

  it("maxTokens 缺省 4096", () => {
    expect(usableTokens(10_000)).toBe(10_000 - 4_096 - 2_000);
  });

  it("下限 1/4 窗口:maxTokens 大得离谱时不再下探", () => {
    expect(usableTokens(1_000, 2_000)).toBe(250);
  });
});

describe("shouldCompact", () => {
  const usable = 1_000;
  it("三档阈值就是 0.6/0.75/0.9", () => {
    expect(THRESHOLDS).toEqual({ early: 0.6, standard: 0.75, late: 0.9 });
  });
  it("严格大于才触发(等于阈值不压)", () => {
    expect(shouldCompact(601, "early", usable)).toBe(true);
    expect(shouldCompact(600, "early", usable)).toBe(false);
    expect(shouldCompact(751, "standard", usable)).toBe(true);
    expect(shouldCompact(750, "standard", usable)).toBe(false);
    expect(shouldCompact(901, "late", usable)).toBe(true);
    expect(shouldCompact(900, "late", usable)).toBe(false);
  });
});

describe("compactHistory", () => {
  it("6 轮历史默认保留最近 4 轮,前 2 轮进摘要", async () => {
    const { provider, requests } = stubSummarizer("前两轮的摘要");
    const history = turns(6);
    const outcome = await compactHistory(provider, history, "");

    expect(outcome.uptoSeq).toBe(3); // 第 3 条(0 基)= 第 2 轮的 assistant
    expect(history.slice(outcome.uptoSeq + 1)).toEqual(history.slice(4));
    // 摘要请求只包含被压缩的前缀转写
    expect(requests).toHaveLength(1);
    const [sys, usr] = requests[0];
    expect(sys.role).toBe("system");
    expect(usr.content).toContain("<conversation>");
    expect(usr.content).toContain("[user] 问题1");
    expect(usr.content).toContain("[user] 问题2");
    expect(usr.content).not.toContain("问题5");
    // 转写解掉了 <user-request> 包裹
    expect(usr.content).not.toContain("<user-request>");
  });

  it("keepTurns 覆盖默认值", async () => {
    const { provider, requests } = stubSummarizer("s");
    const history = turns(6);
    const outcome = await compactHistory(provider, history, "", { keepTurns: 2 });
    expect(outcome.uptoSeq).toBe(7); // 留最后 2 轮,前 4 轮进摘要
    expect(requests[0][1].content).toContain("[user] 问题4");
    expect(requests[0][1].content).not.toContain("[user] 问题5");
  });

  it("滚动压缩:旧摘要进 <previous_summary>,增量走 <new_messages>", async () => {
    const { provider, requests } = stubSummarizer("合并后的摘要");
    await compactHistory(provider, turns(6), "旧摘要内容", { keepTurns: 2 });
    const usr = requests[0][1].content;
    expect(usr).toContain("<previous_summary>\n旧摘要内容\n</previous_summary>");
    expect(usr).toContain("<new_messages>");
    expect(usr).not.toContain("<conversation>");
  });

  it("不足两轮:没有可压缩的整轮,抛错由调用方回退 trim", async () => {
    const { provider } = stubSummarizer("s");
    await expect(compactHistory(provider, turns(1), "")).rejects.toThrow(
      "没有可压缩的整轮",
    );
  });

  it("模型返回空摘要:抛错不吞", async () => {
    const { provider } = stubSummarizer("   ");
    await expect(compactHistory(provider, turns(4), "")).rejects.toThrow(
      "空摘要",
    );
  });
});

describe("isContextOverflow", () => {
  it("识别各家撞窗文案并集", () => {
    for (const msg of [
      "This model's maximum context length is 4096 tokens",
      "context_length_exceeded",
      "prompt is too long: 200000 tokens > 8192 maximum",
      "input is too long",
      "too many input tokens",
      "tokens exceed the limit",
    ]) {
      expect(isContextOverflow(new Error(msg))).toBe(true);
    }
  });

  it("普通错误不误判", () => {
    for (const msg of ["HTTP 429", "请求超时", "connection refused", "api key 无效"]) {
      expect(isContextOverflow(new Error(msg))).toBe(false);
    }
  });
});

describe("summaryToMsg", () => {
  it("包成 user 角色的 <context-summary> 消息(严格端点拒绝非首位 system)", () => {
    const msg = summaryToMsg("用户在做测试框架");
    expect(msg.role).toBe("user");
    expect(msg.content).toContain("<context-summary>");
    expect(msg.content).toContain("用户在做测试框架");
    expect(msg.content.endsWith("</context-summary>")).toBe(true);
  });
});
