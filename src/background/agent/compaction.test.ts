// compaction 纯逻辑单测:窗口公式 / 档位阈值 / 切分与滚动合并(stub provider)/
// 撞窗文案识别 / 摘要消息形状。此前这些只被 verify-compaction 的慢 e2e 覆盖。

import { describe, expect, it } from "vitest";
import {
  THRESHOLDS,
  TRANSCRIPT_BUDGET_CHARS,
  compactHistory,
  isContextOverflow,
  summaryToMsg,
  shouldCompact,
  toTranscript,
  usableTokens,
} from "./compaction";
import type { ChatProvider, InternalMsg } from "../provider/types";

const user = (content: string): InternalMsg => ({ role: "user", content });
const assistant = (content: string): InternalMsg => ({ role: "assistant", content });
const tool = (content: string): InternalMsg => ({
  role: "tool",
  toolCallId: "t1",
  content,
});

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

describe("toTranscript 转写预算", () => {
  it("预算内:tool 正文原样进转写", () => {
    const transcript = toTranscript([
      user("<user-request>总结这页</user-request>"),
      tool("页面正文不多"),
      assistant("结论"),
    ]);
    expect(transcript).toBe(
      "[user] 总结这页\n\n[tool result] 页面正文不多\n\n[assistant] 结论",
    );
  });

  it("超预算:旧 tool 正文打桩,最新 tool 与 user/assistant 行保留", () => {
    const big = "x".repeat(80_000);
    const transcript = toTranscript([
      user("<user-request>q1</user-request>"),
      tool(big), // 最旧的大结果 → 打桩
      assistant("第一轮结论"),
      tool(big), // 较新的结果 → 累计后预算也耗尽?不:预算 120k,两个 80k
      tool("y".repeat(30_000)), // 最新结果保留
      user("<user-request>q2</user-request>"),
    ]);
    // 从最新往回:30k 保留(余 90k)→ 80k 保留(余 10k)→ 最旧 80k 打桩
    expect(transcript).toContain("[user] q1");
    expect(transcript).toContain("[assistant] 第一轮结论");
    expect(transcript).toContain(`[tool result] ${"y".repeat(30_000)}`);
    expect(transcript).toContain(`[tool result] ${"x".repeat(80_000)}`);
    expect(transcript).toContain(
      "[tool result omitted — 80000 chars of stale page/fetch content",
    );
    // 打桩只发生一次(最旧的);打桩后转写总量收敛进预算 —— 压缩请求
    // 本身不再可能撞 summarizer 的窗口
    expect(transcript.match(/omitted/g)).toHaveLength(1);
    expect(transcript.length).toBeLessThan(TRANSCRIPT_BUDGET_CHARS);
  });

  it("超长 user/assistant 行超预算:从最旧行截起并注记省略数,总量进预算", () => {
    // tool 打桩只约束工具正文:两条各 7 万字符的正文合起来就超预算
    const old = "a".repeat(70_000);
    const transcript = toTranscript([
      user(`<user-request>${old}</user-request>`),
      assistant(old),
      user("<user-request>最近一问</user-request>"),
      assistant("b".repeat(70_000)),
    ]);
    expect(transcript).not.toContain("aaaa"); // 最旧两行整行丢
    expect(transcript).toContain("最近一问");
    expect(transcript).toContain(`[assistant] ${"b".repeat(70_000)}`);
    expect(transcript).toContain(
      "[2 earlier message(s) omitted to fit the summarizer window]",
    );
    expect(transcript.length).toBeLessThanOrEqual(TRANSCRIPT_BUDGET_CHARS);
  });

  it("单条自身超预算:截断该条尾部,而不是把整份转写清空", () => {
    const transcript = toTranscript([
      user(`<user-request>${"u".repeat(200_000)}</user-request>`),
    ]);
    expect(transcript.startsWith("[user] ")).toBe(true);
    expect(transcript).toContain("[truncated to fit the summarizer window]");
    // 只留一句省略注记 = 摘要输入为空,压缩等于静默失忆 —— 正是要防的事
    expect(transcript).not.toContain("earlier message(s) omitted");
    expect(transcript.length).toBeLessThanOrEqual(TRANSCRIPT_BUDGET_CHARS);
  });

  it("注记与保留行仍放不下:截断最旧的保留行,其余原样", () => {
    const transcript = toTranscript([
      user("<user-request>旧问</user-request>"),
      assistant("旧答"),
      assistant("z".repeat(200_000)),
    ]);
    expect(transcript).toContain(
      "[2 earlier message(s) omitted to fit the summarizer window]",
    );
    expect(transcript).toContain("[truncated to fit the summarizer window]");
    // 截断只削到预算线为止,不是把最新一条也压成短头
    expect(transcript.length).toBeLessThanOrEqual(TRANSCRIPT_BUDGET_CHARS);
    expect(transcript.length).toBeGreaterThan(TRANSCRIPT_BUDGET_CHARS - 200);
  });
});
