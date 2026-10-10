// passesDomainFilter 单测:结果后置域名过滤——allow/block 双名单、
// 子域语义(单向:名单项匹配其子域)、非法 URL 判不通过。

import { describe, expect, it } from "vitest";
import { passesDomainFilter } from "./domainFilter";

describe("passesDomainFilter", () => {
  it("双名单皆空:全部通过", () => {
    expect(passesDomainFilter("https://a.example/x", [], [])).toBe(true);
  });

  it("allow 命中:同域与子域通过,外域不通过", () => {
    const allowed = ["example.com"];
    expect(passesDomainFilter("https://example.com/", allowed, [])).toBe(true);
    expect(passesDomainFilter("https://www.example.com/", allowed, [])).toBe(true);
    expect(passesDomainFilter("https://api.example.com/", allowed, [])).toBe(true);
    expect(passesDomainFilter("https://other.com/", allowed, [])).toBe(false);
  });

  it("子域语义有方向:notexample.com 不因 example.com 在名单而通过", () => {
    expect(passesDomainFilter("https://notexample.com/", ["example.com"], [])).toBe(false);
  });

  it("block 优先:命中 allow 也被 block 拦", () => {
    expect(
      passesDomainFilter("https://www.example.com/", ["example.com"], ["www.example.com"]),
    ).toBe(false);
  });

  it("block:子域与域名本体都拦,不在名单的外域放行", () => {
    expect(passesDomainFilter("https://bad.example.com/", [], ["example.com"])).toBe(false);
    expect(passesDomainFilter("https://example.com/", [], ["example.com"])).toBe(false);
    expect(passesDomainFilter("https://goodother.com/", [], ["example.com"])).toBe(true);
  });

  it("非法 URL:视为不通过", () => {
    expect(passesDomainFilter("not a url", [], [])).toBe(false);
  });

  it("hostname 大小写归一后匹配", () => {
    expect(passesDomainFilter("https://WWW.Example.COM/", ["example.com"], [])).toBe(true);
  });
});
