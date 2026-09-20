// 出站判定单测:私网/内网目标(含 IPv4-mapped IPv6)无条件
// 确认;会话来源域白名单命中直抓、未命中确认。判定是「知情放行」底线,
// 不是沙箱 —— DNS 解析绕行不在覆盖内,见 outboundGuard 头注。

import { describe, expect, it } from "vitest";
import {
  allowlistDomainOf,
  hostKey,
  isPrivateNetworkTarget,
  reviewRedirectTarget,
  webFetchNeedsConfirm,
} from "./outboundGuard";

const allow = (domains: string[]) => new Set(domains.map((d) => d));

describe("isPrivateNetworkTarget", () => {
  it("私网 IPv4 段与环回", () => {
    for (const h of [
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.200",
      "127.0.0.1",
      "0.0.0.0",
      "169.254.10.10",
      "100.64.0.1",
    ]) {
      expect(isPrivateNetworkTarget(h), h).toBe(true);
    }
  });

  it("公网 IPv4 不过", () => {
    for (const h of ["8.8.8.8", "172.32.0.1", "100.20.30.40", "192.169.0.1"]) {
      expect(isPrivateNetworkTarget(h), h).toBe(false);
    }
  });

  it("惯例主机名与 IPv6 本地段", () => {
    for (const h of [
      "localhost",
      "api.localhost",
      "nas.local",
      "printer.internal",
      "::1",
      "[fe80::1]",
      "[fc00::abcd]",
      "[fd12:3456::1]",
    ]) {
      expect(isPrivateNetworkTarget(h), h).toBe(true);
    }
  });

  it("IPv4-mapped IPv6 按映射的 IPv4 判定(点分与十六进制形态)", () => {
    // URL 规范化会把 [::ffff:127.0.0.1] 写成 [::ffff:7f00:1],两种都要命中
    for (const h of [
      "::ffff:127.0.0.1",
      "[::ffff:127.0.0.1]",
      "[::ffff:7f00:1]",
      "[::ffff:192.168.1.1]",
      "[::ffff:c0a8:101]",
    ]) {
      expect(isPrivateNetworkTarget(h), h).toBe(true);
    }
    expect(isPrivateNetworkTarget("::ffff:8.8.8.8")).toBe(false);
    expect(isPrivateNetworkTarget("[::ffff:0808:0808]")).toBe(false);
  });

  it("公网域名与公网 IPv6 不过", () => {
    for (const h of ["example.com", "a.public.example.org", "2606:4700::1111"]) {
      expect(isPrivateNetworkTarget(h), h).toBe(false);
    }
  });
});

describe("hostKey / allowlistDomainOf", () => {
  it("归一:小写、去尾点、去一层 www.,子域不通配", () => {
    expect(hostKey("WWW.Example.COM.")).toBe("example.com");
    expect(hostKey("api.example.com")).toBe("api.example.com");
    expect(hostKey("www.api.example.com")).toBe("api.example.com");
    expect(allowlistDomainOf("https://www.example.com/a?b=1")).toBe("example.com");
    expect(allowlistDomainOf("http://[::ffff:127.0.0.1]/x")).toBe(
      "::ffff:7f00:1",
    );
    expect(allowlistDomainOf("chrome://version")).toBeNull();
    expect(allowlistDomainOf("not a url")).toBeNull();
  });
});

describe("reviewRedirectTarget 重定向复核", () => {
  it("同 host 跳转(http→https、站内路径、www 归一)原样返回落点", () => {
    expect(reviewRedirectTarget("https://example.com/a", "https://example.com/b")).toBe(
      "https://example.com/b",
    );
    expect(
      reviewRedirectTarget("http://example.com/x", "https://example.com/x"),
    ).toBe("https://example.com/x");
    expect(
      reviewRedirectTarget("https://example.com/", "https://www.example.com/x"),
    ).toBe("https://www.example.com/x");
  });

  it("落点是私网/内网 → 抛模型可读错误(一个字节正文都不读)", () => {
    for (const [req, res] of [
      ["https://evil.tld/entry", "http://192.168.1.1/admin"],
      ["https://mock.test/redir", "http://10.0.0.5/private"],
      ["https://mock.test/redir", "http://127.0.0.1:9222/json"],
      // IPv4-mapped 形态的落点同样拦
      ["https://mock.test/redir", "http://[::ffff:7f00:1]/x"],
    ] as const) {
      expect(() => reviewRedirectTarget(req, res), res).toThrowError(/私网地址/);
    }
  });

  it("公开跨站落点放行,但返回请求 URL(白名单不学习重定向带来的新域)", () => {
    expect(
      reviewRedirectTarget("https://example.com/entry", "https://partner.example.org/x"),
    ).toBe("https://example.com/entry");
  });

  it("落点为空/等于请求/不可解析时不炸", () => {
    expect(reviewRedirectTarget("https://example.com/a", "")).toBe("https://example.com/a");
    expect(reviewRedirectTarget("https://example.com/a", "https://example.com/a")).toBe(
      "https://example.com/a",
    );
    expect(reviewRedirectTarget("https://example.com/a", "::broken::")).toBe("::broken::");
  });
});

describe("webFetchNeedsConfirm", () => {
  it("私网目标无条件确认,即使域在白名单内", () => {
    expect(
      webFetchNeedsConfirm({ url: "http://10.0.0.5:8080/internal" }, allow(["10.0.0.5"])),
    ).toBe(true);
    expect(
      webFetchNeedsConfirm({ url: "https://myhost.local/x" }, allow(["myhost.local"])),
    ).toBe(true);
  });

  it("白名单命中直抓(大小写/www 前缀归一后比较),未命中确认", () => {
    const list = allow(["example.com"]);
    expect(webFetchNeedsConfirm({ url: "https://example.com/a/b?c=1" }, list)).toBe(false);
    expect(webFetchNeedsConfirm({ url: "https://WWW.Example.COM/" }, list)).toBe(false);
    expect(webFetchNeedsConfirm({ url: "https://api.example.com/x" }, list)).toBe(true);
    expect(webFetchNeedsConfirm({ url: "https://evil.tld/collect" }, list)).toBe(true);
  });

  it("无白名单时,除私网外一律确认(含路径/子域/短查询载体)", () => {
    expect(webFetchNeedsConfirm({ url: "https://example.com/a/b" })).toBe(true);
    expect(webFetchNeedsConfirm({ url: `https://evil.tld/${"x".repeat(300)}` })).toBe(true);
    expect(webFetchNeedsConfirm({ url: "https://evil.tld/?k=short" })).toBe(true);
  });

  it("畸形输入一律放行给工具自身报错", () => {
    expect(webFetchNeedsConfirm({ url: "not a url" })).toBe(false);
    expect(webFetchNeedsConfirm({ url: "chrome://version" })).toBe(false);
    expect(webFetchNeedsConfirm({ url: "ftp://192.168.0.1/" })).toBe(false);
    expect(webFetchNeedsConfirm({})).toBe(false);
    expect(webFetchNeedsConfirm(undefined)).toBe(false);
    expect(webFetchNeedsConfirm({ url: 42 })).toBe(false);
  });
});
