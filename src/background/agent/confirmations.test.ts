// 确认门判定单测:三档(confirmLevel)× 判定矩阵与 web_fetch 参数级底线
// (私网目标/来源域白名单)。门与批次屏障的对应关系也在此锁 —— 对同一
// 调用,过门(gate === true)的必自成单批(确认卡单槽约束),免门的
// 并行安全工具可并批(契约点 1)。出站判定本体在 ../web/outboundGuard
// (纯模块),那里有独立单测;这里测 needsConfirmation 的接入与档位裁剪。

import { describe, expect, it, vi } from "vitest";
import {
  deniedMessage,
  needsConfirmation,
  requestConfirmation,
  resolveConfirmation,
  type ConfirmGate,
} from "./confirmations";
import type { AgentPort } from "./agent";
import type { ConfirmLevel } from "../../shared/configStore";
import {
  PARALLEL_SAFE_TOOLS,
  partitionToolBatches,
} from "./toolBatch";

const LEVELS: ConfirmLevel[] = ["strict", "auto", "off"];

/** 与 agent.ts 装配处同构的共享门闭包(dispatch 与屏障必须用同一个) */
function makeGate(
  level: ConfirmLevel,
  allowlist?: ReadonlySet<string>,
): ConfirmGate {
  return (name, args) => needsConfirmation(name, args, level, allowlist);
}

describe("三档 × 判定矩阵", () => {
  // 五类判定路径各至少一个代表工具(类别缺失 = 矩阵不完整,即红);
  // want 按方案矩阵表:[strict, auto, off]
  const MATRIX: {
    category: string;
    name: string;
    args?: unknown;
    allowlist?: ReadonlySet<string>;
    want: [boolean, boolean, boolean];
  }[] = [
    { category: "页面写", name: "click_element", want: [true, false, false] },
    {
      category: "页面写(提交型,pressEnterAfter 不单开分类)",
      name: "fill_input",
      args: { text: "x", pressEnterAfter: true },
      want: [true, false, false],
    },
    {
      category: "标签页关闭(page-nav:auto 档仍过门,不可逆且不受授权约束)",
      name: "close_tab",
      args: { tabId: 3 },
      want: [true, true, false],
    },
    {
      category: "页面跳转(page-nav:auto 档仍过门,可达集=全网络)",
      name: "navigate_tab",
      args: { url: "https://example.com" },
      want: [true, true, false],
    },
    {
      category: "记忆持久写",
      name: "memory_save",
      args: { content: "x" },
      want: [true, true, false],
    },
    { category: "记忆持久写", name: "memory_delete", args: { match: "x" }, want: [true, true, false] },
    { category: "MCP 外部工具(语义未知)", name: "mcp_x_tool", args: {}, want: [true, true, false] },
    {
      category: "web_fetch 私网目标",
      name: "web_fetch",
      args: { url: "http://192.168.1.1/a" },
      want: [true, true, false],
    },
    {
      category: "web_fetch 白名单命中域",
      name: "web_fetch",
      args: { url: "https://example.com/a" },
      allowlist: new Set(["example.com"]),
      want: [false, false, false],
    },
    {
      category: "web_fetch 白名单外公开域(子域不通配)",
      name: "web_fetch",
      args: { url: "https://api.example.com/x" },
      allowlist: new Set(["example.com"]),
      want: [true, true, false],
    },
    {
      category: "web_fetch 畸形输入(不误触发,交工具自身报错)",
      name: "web_fetch",
      args: { url: "not a url" },
      want: [false, false, false],
    },
    { category: "只读工具", name: "page_read", args: {}, want: [false, false, false] },
    { category: "只读工具", name: "web_search", args: {}, want: [false, false, false] },
    { category: "只读工具", name: "scroll_page", args: {}, want: [false, false, false] },
  ];

  it("每个类别的三档结果与方案矩阵一致", () => {
    const categories = new Set(MATRIX.map((r) => r.category));
    // 五类判定路径:页面写 / 记忆持久写 / MCP / web_fetch / 只读
    expect(categories.size).toBeGreaterThanOrEqual(5);
    for (const { category, name, args, allowlist, want } of MATRIX) {
      LEVELS.forEach((level, i) => {
        expect(
          needsConfirmation(name, args, level, allowlist),
          `${category} · ${name} · ${level}`,
        ).toBe(want[i]);
      });
    }
  });
});

describe("批次屏障与门判定一致(契约点 1)", () => {
  const allow = new Set(["example.com"]);
  const search = (id: string) => ({ id, name: "web_search", args: {} });
  const fetchCalls = {
    private: { id: "f1", name: "web_fetch", args: { url: "http://192.168.1.1/a" } },
    allowed: { id: "f2", name: "web_fetch", args: { url: "https://example.com/a" } },
    outside: { id: "f3", name: "web_fetch", args: { url: "https://other.tld/a" } },
  };

  it("过门的调用必自成单批(屏障打断相邻只读并批)", () => {
    const gate = makeGate("strict", allow);
    const batches = partitionToolBatches(
      [search("s1"), fetchCalls.private, search("s2")],
      (tc) => gate(tc.name, tc.args),
    );
    expect(batches).toHaveLength(3);
    expect(batches[1]).toEqual([fetchCalls.private]);
  });

  it("免门的并行安全调用可与相邻只读并批", () => {
    const gate = makeGate("strict", allow);
    expect(gate("web_fetch", fetchCalls.allowed.args)).toBe(false);
    const batches = partitionToolBatches(
      [search("s1"), fetchCalls.allowed, search("s2")],
      (tc) => gate(tc.name, tc.args),
    );
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
  });

  it("三档 × 三形态:partition 行为始终与门判定一致", () => {
    expect(PARALLEL_SAFE_TOOLS.has("web_fetch")).toBe(true);
    for (const level of LEVELS) {
      const gate = makeGate(level, allow);
      for (const tc of [fetchCalls.private, fetchCalls.allowed, fetchCalls.outside]) {
        const gated = gate(tc.name, tc.args);
        const batches = partitionToolBatches(
          [search("s1"), tc, search("s2")],
          (t) => gate(t.name, t.args),
        );
        if (gated) {
          expect(batches, `${level} · ${tc.args.url} 过门必单批`).toHaveLength(3);
        } else {
          expect(batches, `${level} · ${tc.args.url} 免门可并批`).toHaveLength(1);
        }
      }
    }
  });
});

// ---- 确认决定流:面板答复/超时/取消 → 决定对象(拒绝可附言,超时≠用户拒绝) ----
// AgentPort 只用 postMessage;无 tabId 可解析时 resolveTargetTab 直接空回,
// 不触 chrome API,单测无需 mock 浏览器全局

/** 记录型假 port:捕获发往面板的确认请求 */
function makeFakePort() {
  const sent: unknown[] = [];
  return { port: { postMessage: (m: unknown) => sent.push(m) } as AgentPort, sent };
}

describe("确认决定流(答复 → 决定对象)", () => {
  it("allow_once 答复 → {kind:'allow'},请求载荷带 requestId 与超时口径", async () => {
    const { port, sent } = makeFakePort();
    const pending = requestConfirmation(port, { name: "click_element", args: {} });
    // postMessage 在 resolveTargetTab 的 await 之后,等载荷到达再断言
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const req = sent[0] as { requestId: string; name: string; timeoutMs: number };
    expect(req.name).toBe("click_element");
    expect(req.requestId).toBeTruthy();
    expect(req.timeoutMs).toBe(120_000);
    resolveConfirmation(req.requestId, "allow_once");
    expect(await pending).toEqual({ kind: "allow" });
  });

  it("deny 答复附言 → feedback 透传;不附言则无 feedback 字段", async () => {
    const { port, sent } = makeFakePort();
    const withText = requestConfirmation(port, { name: "fill_input", args: {} });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const req1 = sent[0] as { requestId: string };
    resolveConfirmation(req1.requestId, "deny", "姓氏拼错了,改成 Li");
    expect(await withText).toEqual({
      kind: "deny",
      reason: "user",
      feedback: "姓氏拼错了,改成 Li",
    });

    const noText = requestConfirmation(port, { name: "fill_input", args: {} });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    const req2 = sent[1] as { requestId: string };
    resolveConfirmation(req2.requestId, "deny");
    expect(await noText).toEqual({ kind: "deny", reason: "user" });
  });

  it("超时未答复 → deny/timeout(宁慢勿错,不给人不在场放行写动作的口子)", async () => {
    vi.useFakeTimers();
    try {
      const { port } = makeFakePort();
      const pending = requestConfirmation(port, { name: "memory_save", args: {} });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await pending).toEqual({ kind: "deny", reason: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("run 取消(abort)→ deny/abort,等待不阻塞取消", async () => {
    const { port } = makeFakePort();
    const ac = new AbortController();
    const pending = requestConfirmation(port, { name: "close_tab", args: {} }, ac.signal);
    ac.abort();
    expect(await pending).toEqual({ kind: "deny", reason: "abort" });
  });

  it("未知 requestId 的迟到答复被静默忽略(面板刷新/SW 回收后的兜底)", async () => {
    const { port, sent } = makeFakePort();
    const pending = requestConfirmation(port, { name: "click_element", args: {} });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const req = sent[0] as { requestId: string };
    resolveConfirmation("not-a-real-id", "deny");
    // 迟到答复不打穿:真正的答复仍按 id 命中结算
    resolveConfirmation(req.requestId, "allow_once");
    expect(await pending).toEqual({ kind: "allow" });
  });
});

// ---- 拒绝回填文案:结构化 JSON,status "declined" 是 e2e 的断言锚点 ----

describe("拒绝回填文案(deniedMessage)", () => {
  it("用户拒绝附言:declined + reason:user + feedback 透传 + 行为指引", () => {
    const raw = deniedMessage({
      kind: "deny",
      reason: "user",
      feedback: "姓氏拼错了,改成 Li",
    });
    expect(raw).toContain("declined"); // e2e /declined/ 断言链路
    const parsed = JSON.parse(raw);
    expect(parsed.status).toBe("declined");
    expect(parsed.reason).toBe("user");
    expect(parsed.feedback).toBe("姓氏拼错了,改成 Li");
    expect(parsed.guidance).toContain("Do not retry verbatim");
  });

  it("超时/取消/无附言拒绝:不造空 feedback 字段,reason 如实区分", () => {
    const cases = [
      { kind: "deny", reason: "timeout" },
      { kind: "deny", reason: "abort" },
      { kind: "deny", reason: "user" },
    ] as const;
    for (const d of cases) {
      const parsed = JSON.parse(deniedMessage(d));
      expect(parsed).not.toHaveProperty("feedback");
      expect(parsed.reason).toBe(d.reason);
      expect(parsed.status).toBe("declined");
    }
  });
});
