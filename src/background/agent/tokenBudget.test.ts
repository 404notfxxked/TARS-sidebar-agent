// 压缩触发基线的口径回归(审计 §1.1):基线 = 实测 promptTokens +
// 「测量之后新增的库行」估算 + 固定开销。旧实现用 prompt 消息条数(msgs)
// 当切分点 —— 一旦上一轮压缩过,prompt 里的合成消息(摘要)与被裁前缀
// 让 msgs ≠ 库行口径,estimateRange 从过早的下标起算,把摘要已覆盖的行
// 重复计入,基线系统性虚高 → 下一轮过早触发压缩。ctx.rows = 测量时刻
// (run 收口)的库总行数,切分点与压缩与否无关;旧行无 rows(或越界)
// 回落全量估算 —— 粗一点,但不继承错基线。

import { describe, expect, it } from "vitest";
import type { InternalMsg } from "../provider";
import { coveredLibraryRows, estimateBaselineTokens, estimateRange } from "./tokenBudget";

// 20 行库历史;上一轮把前 16 行压成摘要,tail 只剩 4 行,user 收尾。
// promptTokens = 2000 是该轮实测,覆盖摘要 + 尾部 + 提问(即全部 20 行)。
const history: InternalMsg[] = Array.from({ length: 20 }, (_, i) => ({
  role: i % 2 === 0 ? "user" : "assistant",
  content: `row-${i}: ${"x".repeat(30)}`,
}));
const FIXED = 100;

function newRows(n: number): InternalMsg[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `new-${i}: ${"y".repeat(30)}`,
  }));
}

describe("estimateBaselineTokens 压缩基线口径(审计 §1.1 回归)", () => {
  it("压缩过的会话:全库已被上一轮实测覆盖,基线不再计入任何库行", () => {
    const ctx = { promptTokens: 2000, msgs: 6, rows: 20 };
    // rows = 20 = history.length → 测量后新增 0 行;正确基线 = 2000 + 100
    expect(estimateBaselineTokens(ctx, history, FIXED)).toBe(2100);
  });

  it("测量后追加了新行:只估新增的那几行", () => {
    const grown = [...history, ...newRows(3)];
    const ctx = { promptTokens: 2000, msgs: 6, rows: 20 };
    expect(estimateBaselineTokens(ctx, grown, FIXED)).toBe(
      2000 + estimateRange(grown, 20) + FIXED,
    );
  });

  it("旧格式基线(无 rows):回落全量估算,不继承 msgs 口径", () => {
    const ctx = { promptTokens: 2000, msgs: 6 };
    expect(estimateBaselineTokens(ctx, history, FIXED)).toBe(
      estimateRange(history, 0) + FIXED,
    );
  });

  it("rows 越界(库被清理/损坏):回落全量估算", () => {
    const ctx = { promptTokens: 2000, msgs: 6, rows: 99 };
    expect(estimateBaselineTokens(ctx, history, FIXED)).toBe(
      estimateRange(history, 0) + FIXED,
    );
  });

  it("未压缩过的普通会话:rows 口径与旧行为等价(全量已覆盖 → 实测+固定)", () => {
    const ctx = { promptTokens: 2000, msgs: 20, rows: 20 };
    expect(estimateBaselineTokens(ctx, history, FIXED)).toBe(2100);
  });

  it("含错误行的会话:rows 存已滤计数,实测基线仍被采用(审计 §1.1 残留)", () => {
    // 会话 22 条落库行,其中 2 条 error 行不回灌模型;上一轮实测覆盖全部
    // 20 行有效历史,之后又落 1 条新行(最终回答)。消费端拿到的是已滤
    // history = 21 行;若生产端按未滤库行数存 rows(22+1=23),
    // rows > history.length 恒成立 → 实测被整轮丢弃、回落全量估算
    // (压缩过的会话上 = 原 bug 症状复现)。修后生产端存
    // 已滤起点(20)+ 本轮新落盘(1)= 21,与消费端同空间,实测被采用。
    const filtered = [...history, ...newRows(1)];
    const ctx = { promptTokens: 2000, msgs: 6, rows: 20 + 1 };
    // rows=21 → 从 21 起估,新增估算 0:本轮新落的最后一行(最终回答)
    // 未被实测覆盖,量级由粗估算口径吸收(5c 起的既定取舍,不逐行找补)
    expect(estimateBaselineTokens(ctx, filtered, FIXED)).toBe(2100);
  });

  it("生产者契约 coveredLibraryRows:只认已滤起点,退回未滤口径即红(§1.1)", () => {
    // 同一含错误行场景,这次钉**生产端**:runSetup 会同时记下
    // persistedSeqs=22(未滤,error 行也占 seq)与 libraryRowsAtStart=20
    // (已滤)。coveredLibraryRows 的算式只准用后者 —— persistedSeqs 一旦
    // 混进来(函数签名收下它并参与计算 = 退回未滤口径),本用例连同
    // 下面的消费端组合断言一起红。
    const loopAnchors: {
      libraryRowsAtStart: number;
      persistedSeqs: number;
      savedUpTo: number;
      persistedInCtx: number;
    } = { libraryRowsAtStart: 20, persistedSeqs: 22, savedUpTo: 12, persistedInCtx: 11 };
    expect(coveredLibraryRows(loopAnchors)).toBe(21);
    // 组合消费端:实测 + 新增的路径,而不是回落全量估算(est(filtered,0)+FIXED=310)
    const filtered = [...history, ...newRows(1)];
    const rows = coveredLibraryRows(loopAnchors);
    const ctx = { promptTokens: 2000, msgs: 6, rows };
    expect(estimateBaselineTokens(ctx, filtered, FIXED)).toBe(2100);
  });
});
