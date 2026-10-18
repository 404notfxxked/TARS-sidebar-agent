// 标签页生命周期三件套的纯逻辑与守卫单测:chrome.tabs 全套在此文件内
// stub(vitest.setup 只给事件桩);waitForTabComplete 用假定时器。
// execute 经注册表 getTool(...).execute 调起,与生产同一条路径。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTool, waitForTabComplete } from "./tools";
import {
  setToolExecutionContext,
  type ToolExecutionContext,
} from "./toolContext";

/** 每个用例的 tabs 行为由用例自己改 makeTabs 返回的桩;
 *  返回类型放宽到 unknown,用例里按场景给部分形状的 mock 值 */
let tabs: ReturnType<typeof makeTabs>;
function makeTabs() {
  return {
    get: vi.fn(async (): Promise<unknown> => ({ id: 5, windowId: 1, status: "complete", title: "T", url: "https://a.b/" })),
    query: vi.fn(async (): Promise<unknown> => []),
    update: vi.fn(async (): Promise<unknown> => ({})),
    create: vi.fn(async (): Promise<unknown> => ({ id: 9 })),
    remove: vi.fn(async (): Promise<unknown> => undefined),
  };
}

beforeEach(() => {
  tabs = makeTabs();
  vi.stubGlobal("chrome", {
    tabs,
    runtime: { lastError: null, onMessage: { addListener: () => {} }, sendMessage: () => {} },
    permissions: { contains: () => Promise.resolve(true) },
  });
});

describe("waitForTabComplete", () => {
  it("status 变为 complete 即返回 complete(轮询,不再等到 deadline)", async () => {
    vi.useFakeTimers();
    tabs.get.mockResolvedValueOnce({ status: "loading" }).mockResolvedValue({ status: "complete" });
    const p = waitForTabComplete(5, undefined, 15_000);
    await vi.advanceTimersByTimeAsync(300);
    await expect(p).resolves.toBe("complete");
    expect(tabs.get.mock.calls.length).toBeGreaterThanOrEqual(2);
    vi.useRealTimers();
  });

  it("deadline 内始终未 complete 返回 timeout", async () => {
    vi.useFakeTimers();
    tabs.get.mockResolvedValue({ status: "loading" });
    const p = waitForTabComplete(5, undefined, 500);
    await vi.advanceTimersByTimeAsync(800);
    await expect(p).resolves.toBe("timeout");
    vi.useRealTimers();
  });

  it("已中止即抛(由 loop 的 abort 分支静默退出)", async () => {
    vi.useFakeTimers();
    const ctl = new AbortController();
    ctl.abort();
    tabs.get.mockResolvedValue({ status: "loading" });
    await expect(waitForTabComplete(5, ctl.signal, 15_000)).rejects.toThrow("cancelled");
    vi.useRealTimers();
  });

  it("连续 get 失败(3 次 ≈ 450ms)判 tab 已死,早退返回 gone 而不是空耗到 deadline", async () => {
    vi.useFakeTimers();
    tabs.get.mockRejectedValue(new Error("No tab with id"));
    const p = waitForTabComplete(5, undefined, 15_000);
    await vi.advanceTimersByTimeAsync(800);
    await expect(p).resolves.toBe("gone");
    expect(tabs.get.mock.calls.length).toBe(3);
    vi.useRealTimers();
  });

  it("偶发失败后恢复轮询(fails 计数清零),不误判死 tab", async () => {
    vi.useFakeTimers();
    tabs.get
      .mockRejectedValueOnce(new Error("transient"))
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue({ status: "complete" });
    const p = waitForTabComplete(5, undefined, 15_000);
    await vi.advanceTimersByTimeAsync(800);
    await expect(p).resolves.toBe("complete");
    vi.useRealTimers();
  });
});

describe("close_tab 守卫与清位", () => {
  it("最后一个标签页:拒绝并语义化报错,不调 remove", async () => {
    tabs.get.mockResolvedValue({ id: 5, windowId: 1, title: "T", url: "x" });
    tabs.query.mockResolvedValue([{ id: 5 }]);
    await expect(getTool("close_tab")!.execute({ tabId: 5 })).rejects.toThrow(/last tab/i);
    expect(tabs.remove).not.toHaveBeenCalled();
  });

  it("正常关闭:remove 调用 + lastOperatedTabId 清位", async () => {
    tabs.get.mockResolvedValue({ id: 5, windowId: 1, title: "T", url: "x" });
    tabs.query.mockResolvedValue([{ id: 5 }, { id: 6 }]);
    const ctx: ToolExecutionContext = { tabId: 5, sessionId: "s", lastOperatedTabId: 5 };
    setToolExecutionContext(ctx);
    const r = await getTool("close_tab")!.execute({ tabId: 5 });
    expect(r).toMatchObject({ closed: 5, title: "T" });
    expect(tabs.remove).toHaveBeenCalledWith(5);
    expect(ctx.lastOperatedTabId).toBeUndefined();
  });

  it("缺 tabId:必填报错", async () => {
    await expect(
      getTool("close_tab")!.execute({} as never),
    ).rejects.toThrow(/requires tabId/i);
  });

  it("目标 tab 已不存在:语义化报错", async () => {
    tabs.get.mockResolvedValue(null);
    await expect(getTool("close_tab")!.execute({ tabId: 7 })).rejects.toThrow(/not found/i);
  });
});

describe("navigate_tab 参数闸", () => {
  it("非 http/https URL 拒绝", async () => {
    await expect(
      getTool("navigate_tab")!.execute({ url: "javascript:alert(1)" }),
    ).rejects.toThrow(/http\/https/i);
  });

  it("newTab 与 tabId 互斥", async () => {
    await expect(
      getTool("navigate_tab")!.execute({ url: "https://a.b/", newTab: true, tabId: 3 }),
    ).rejects.toThrow(/mutually exclusive/i);
  });

  it("newTab 路径:create 新 tab 并写 lastOperatedTabId", async () => {
    const ctx: ToolExecutionContext = { tabId: 1, sessionId: "s" };
    setToolExecutionContext(ctx);
    const r = await getTool("navigate_tab")!.execute({ url: "https://a.b/", newTab: true });
    expect(tabs.create).toHaveBeenCalledWith({ url: "https://a.b/" });
    expect(r).toMatchObject({ url: "https://a.b/", tabId: 9, newTab: true, loaded: true });
    expect(ctx.lastOperatedTabId).toBe(9);
  });

  it("跳转路径:update 目标 tab,loaded 反映 status", async () => {
    const ctx: ToolExecutionContext = { tabId: 5, sessionId: "s" };
    setToolExecutionContext(ctx);
    const r = await getTool("navigate_tab")!.execute({ url: "https://a.b/", tabId: 5 });
    expect(tabs.update).toHaveBeenCalledWith(5, { url: "https://a.b/" });
    expect(r).toMatchObject({ url: "https://a.b/", tabId: 5, loaded: true });
    expect(ctx.lastOperatedTabId).toBe(5);
  });

  it("等待期间 tab 被关:语义化报错(不返回 loaded=false 的误导性结果)", async () => {
    const ctx: ToolExecutionContext = { tabId: 5, sessionId: "s" };
    setToolExecutionContext(ctx);
    tabs.get.mockRejectedValue(new Error("No tab with id"));
    await expect(
      getTool("navigate_tab")!.execute({ url: "https://a.b/", tabId: 5 }),
    ).rejects.toThrow(/was closed while waiting/i);
  });
});

describe("tab_activate", () => {
  it("缺 tabId 必填报错;显式 tabId 激活并写 lastOperatedTabId", async () => {
    await expect(getTool("tab_activate")!.execute({} as never)).rejects.toThrow(/requires tabId/i);
    const ctx: ToolExecutionContext = { tabId: 1, sessionId: "s" };
    setToolExecutionContext(ctx);
    const r = await getTool("tab_activate")!.execute({ tabId: 5 });
    expect(tabs.update).toHaveBeenCalledWith(5, { active: true });
    expect(r).toEqual({ tabId: 5, active: true });
    expect(ctx.lastOperatedTabId).toBe(5);
  });
});
