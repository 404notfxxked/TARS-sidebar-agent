// hostAccess 决策逻辑单测:grantableOriginOf 的边角 + hasOriginAccess 的
// 授权态判定。vitest.setup 的 chrome.permissions 桩默认恒真 ——这里按桩头注
// 的约定逐用例覆写,覆盖「未授权」分支(评审:权限模型拒绝路径零覆盖)。

import { afterEach, describe, expect, it, vi } from "vitest";
import { grantableOriginOf, hasOriginAccess } from "./hostAccess";

afterEach(() => {
  vi.restoreAllMocks();
});

/** 覆写 setup 桩:只有列出的 pattern 返回 true */
const grant = (allowed: string[]) => {
  (globalThis as { chrome: { permissions: { contains: (r: { origins: string[] }) => Promise<boolean> } } })
    .chrome.permissions.contains = vi.fn((req: { origins: string[] }) =>
    Promise.resolve(req.origins.some((p) => allowed.includes(p))),
  );
};

describe("grantableOriginOf", () => {
  it("http(s) → origin;其余一律 null", () => {
    expect(grantableOriginOf("https://api.example.com/v1/chat")).toBe(
      "https://api.example.com",
    );
    expect(grantableOriginOf("http://localhost:3000/x")).toBe(
      "http://localhost:3000",
    );
    expect(grantableOriginOf("chrome://version")).toBeNull();
    expect(grantableOriginOf("ftp://files.example.com/")).toBeNull();
    expect(grantableOriginOf("::not-a-url::")).toBeNull();
    expect(grantableOriginOf("")).toBeNull();
  });
});

describe("hasOriginAccess", () => {
  it("按域授权命中:origin/* 形态", async () => {
    grant(["https://api.example.com/*"]);
    await expect(hasOriginAccess("https://api.example.com/v1/chat")).resolves.toBe(
      true,
    );
  });

  it("<all_urls> 总授权命中任意域", async () => {
    grant(["<all_urls>"]);
    await expect(hasOriginAccess("https://anything.example.net/")).resolves.toBe(
      true,
    );
  });

  it("未授权 → false(拒绝路径:页面工具/搜索通道/web_fetch 的共同前提)", async () => {
    grant([]);
    await expect(hasOriginAccess("https://mock.test/hello")).resolves.toBe(false);
  });

  it("权限查询抛异常按未授权处理(fail-closed)", async () => {
    (globalThis as unknown as { chrome: { permissions: { contains: () => Promise<boolean> } } })
      .chrome.permissions.contains = vi.fn(() => Promise.reject(new Error("boom")));
    await expect(hasOriginAccess("https://mock.test/")).resolves.toBe(false);
  });

  it("已是 origin 形态的输入直接比对", async () => {
    grant(["https://mock.test/*"]);
    await expect(hasOriginAccess("https://mock.test")).resolves.toBe(true);
  });
});
