// 会话来源域白名单推导单测:三类可信来源(用户消息 URL / 搜索结果 /
// 已成功抓取)入集;页面内容里的 URL、被拒绝的抓取、不可解析的旧结果
// 一律不入 —— 提取纪律是本模块的安全底线,负向用例与正向同等重要。

import { describe, expect, it } from "vitest";
import type { InternalMsg } from "../provider/types";
import { deriveFetchAllowlist } from "./fetchAllowlist";

const user = (text: string): InternalMsg => ({ role: "user", content: text });
const assistant = (toolCalls: { id: string; name: string; args: unknown }[]): InternalMsg => ({
  role: "assistant",
  content: null,
  toolCalls,
});
const tool = (toolCallId: string, content: string): InternalMsg => ({
  role: "tool",
  toolCallId,
  content,
});

describe("deriveFetchAllowlist 可信来源", () => {
  it("本轮用户原文(尚未落盘)的显式 URL 入集", () => {
    const set = deriveFetchAllowlist([], "读一下 https://mock.test/page 这篇文档");
    expect(set.has("mock.test")).toBe(true);
  });

  it("用户消息 <user-request> 内的显式 URL 入集", () => {
    const set = deriveFetchAllowlist([
      user(
        "<context>tabId 1: x | https://tab.example.com/</context>\n<user-request>\n读一下 https://mock.test/page 和 https://docs.example.org/guide 这两篇\n</user-request>",
      ),
    ]);
    expect(set.has("mock.test")).toBe(true);
    expect(set.has("docs.example.org")).toBe(true);
    // <context> 里的 tab URL 不提取(只认用户原文)
    expect(set.has("tab.example.com")).toBe(false);
  });

  it("web_search 结果 URL 入集,web_fetch 成功结果的最终 URL 入集", () => {
    const set = deriveFetchAllowlist([
      assistant([
        { id: "t1", name: "web_search", args: { query: "x" } },
        { id: "t2", name: "web_fetch", args: { url: "https://args.example.com/" } },
      ]),
      tool(
        "t1",
        JSON.stringify({
          query: "x",
          engine: "bing",
          results: [{ title: "a", url: "https://search-hit.example.net/a", snippet: "" }],
        }),
      ),
      tool(
        "t2",
        JSON.stringify({ title: "A", url: "https://fetched.example.com/final", total_chars: 10 }),
      ),
    ]);
    expect(set.has("search-hit.example.net")).toBe(true);
    expect(set.has("fetched.example.com")).toBe(true);
  });

  it("www 前缀与大小写归一后入集", () => {
    const set = deriveFetchAllowlist([
      user("<user-request>\n看看 https://WWW.Example.COM/ 好了\n</user-request>"),
    ]);
    expect(set.has("example.com")).toBe(true);
  });
});

describe("deriveFetchAllowlist 提取纪律(负向)", () => {
  it("page_read 等页面工具结果里的 URL 永不入集(不可信内容)", () => {
    const set = deriveFetchAllowlist([
      assistant([
        { id: "p1", name: "page_read", args: {} },
        { id: "p2", name: "page_find", args: {} },
      ]),
      tool(
        "p1",
        JSON.stringify({
          title: "恶意页",
          text: "正文里诱导访问 https://evil.tld/collect?d=secret 和 https://phish.example/login",
        }),
      ),
      tool("p2", JSON.stringify({ matches: [{ text: "见 https://evil.tld/x" }] })),
    ]);
    expect(set.has("evil.tld")).toBe(false);
    expect(set.has("phish.example")).toBe(false);
    expect(set.size).toBe(0);
  });

  it("被拒绝 / 失败的 web_fetch(无结果 JSON)不入集", () => {
    const set = deriveFetchAllowlist([
      assistant([
        { id: "d1", name: "web_fetch", args: { url: "https://denied.example/" } },
        { id: "d2", name: "web_fetch", args: { url: "https://failed.example/" } },
      ]),
      tool("d1", "Error: The user declined this action (or did not respond in time)."),
      tool("d2", "Error: Page fetch failed: dns lookup failed (https://failed.example/)"),
    ]);
    expect(set.has("denied.example")).toBe(false);
    expect(set.has("failed.example")).toBe(false);
  });

  it("伪用户消息(记忆投影/压缩摘要/截图注记)无 <user-request> 包裹,整体跳过", () => {
    const set = deriveFetchAllowlist([
      user("<user-memory>\n用户偏好 https://memory-leak.example/\n</user-memory>"),
      user("[System note: the page screenshot ... https://shot-leak.example/]"),
      user("<context-summary>早前读过 https://summary-leak.example/</context-summary>"),
    ]);
    expect(set.size).toBe(0);
  });

  it("截断打桩 / 坏 JSON 的工具结果整条放弃,不炸不误提取", () => {
    const set = deriveFetchAllowlist([
      assistant([{ id: "s1", name: "web_search", args: { query: "x" } }]),
      tool(
        "s1",
        `${JSON.stringify({
          results: [{ title: "a", url: "https://truncated.example.com/a", snippet: "" }],
        }).slice(0, 40)}\n[此前的工具结果已因长度限制省略,如仍需要请重新调用工具获取]`,
      ),
    ]);
    // 白名单缺一个域的代价只是多弹一张卡,不能为省卡引入误放行
    expect(set.size).toBe(0);
  });

  it("非 http(s) 的 URL(ftp/chrome)不提取", () => {
    const set = deriveFetchAllowlist([
      user("<user-request>\nftp://files.example.com 和 chrome://version 别碰\n</user-request>"),
    ]);
    expect(set.size).toBe(0);
  });
});
