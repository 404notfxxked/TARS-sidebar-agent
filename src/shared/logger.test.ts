// staleLogKeys 单测:SW 启动期日志 key 清理的纯函数部分。
// 行为背景:content 副本握手成功后切到 log:tab:<id>,遗留的回退键 log:cs
// 无人认领会常驻(导出诊断时重复条目);已关闭 tab 的 log:tab:<id> 同理。

import { describe, expect, it } from "vitest";
import { CONTENT_LOG_FALLBACK_KEY, staleLogKeys } from "./logger";

describe("staleLogKeys(SW 启动期日志 key 清理)", () => {
  it("回退键 log:cs 恒清(握手切走后遗留,仍在回退态的副本下次 flush 重建)", () => {
    const alive = new Set([1, 2]);
    expect(
      staleLogKeys(["log:bg", CONTENT_LOG_FALLBACK_KEY, "log:tab:1"], alive),
    ).toEqual([CONTENT_LOG_FALLBACK_KEY]);
  });

  it("死 tab 的 log:tab:<id> 清,活 tab 保留;无法解析的 key 不动", () => {
    const alive = new Set([3]);
    expect(
      staleLogKeys(["log:tab:3", "log:tab:4", "log:panel", "log:tab:x"], alive),
    ).toEqual(["log:tab:4"]);
  });

  it("空输入与全活:无清理项", () => {
    const alive = new Set([1]);
    expect(staleLogKeys([], alive)).toEqual([]);
    expect(staleLogKeys(["log:tab:1", "log:bg"], alive)).toEqual([]);
  });
});
