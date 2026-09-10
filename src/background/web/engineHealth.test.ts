// engineHealth 单测:动态排序(dead 沉底)/ 被动回写 / 启动探测的 TTL 节流。
// vitest.setup.ts 提供 chrome.storage 内存桩;探测用的 fetch 在用例内打桩。

import { describe, expect, it, vi } from "vitest";
import {
  getOrderedEngines,
  maybeProbeEngines,
  orderEnginesByHealth,
  probeEngines,
  recordEngineReachability,
} from "./engineHealth";

const ENGINES = [{ id: "ddg" }, { id: "bing" }, { id: "google" }, { id: "baidu" }];

describe("engineHealth(引擎健康表)", () => {
  it("dead 引擎沉底,健康/未知保持静态质量序", () => {
    const health = {
      ddg: { reach: "dead" as const, checkedAt: Date.now() },
      google: { reach: "dead" as const, checkedAt: Date.now() },
    };
    expect(orderEnginesByHealth(ENGINES, health).map((e) => e.id)).toEqual([
      "bing",
      "baidu",
      "ddg",
      "google",
    ]);
    expect(orderEnginesByHealth(ENGINES, {}).map((e) => e.id)).toEqual([
      "ddg",
      "bing",
      "google",
      "baidu",
    ]);
  });

  it("被动回写超时 → dead 沉底;成功 → 回到静态位置;一分钟内去重", async () => {
    await recordEngineReachability("ddg", "dead");
    expect((await getOrderedEngines(ENGINES)).map((e) => e.id)).toEqual([
      "bing",
      "google",
      "baidu",
      "ddg",
    ]);

    const first = await chrome.storage.local.get("webSearch:engineHealth");
    const firstCheckedAt = first["webSearch:engineHealth"].ddg.checkedAt;
    await recordEngineReachability("ddg", "dead");
    const second = await chrome.storage.local.get("webSearch:engineHealth");
    expect(second["webSearch:engineHealth"].ddg.checkedAt).toBe(firstCheckedAt);

    await recordEngineReachability("ddg", "ok");
    expect((await getOrderedEngines(ENGINES)).map((e) => e.id)).toEqual([
      "ddg",
      "bing",
      "google",
      "baidu",
    ]);
  });

  it("启动探测:健康表为空才发探测,结果整表落盘;新鲜表跳过", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("bing") || u.includes("baidu")) return new Response("ok");
      throw new Error("timeout");
    });
    vi.stubGlobal("fetch", fetchMock);

    // maybeProbeEngines 的探测是 fire-and-forget,落盘断言直接 await 探测本体
    await maybeProbeEngines();
    await probeEngines();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const health = (await chrome.storage.local.get("webSearch:engineHealth"))[
      "webSearch:engineHealth"
    ];
    expect(health.ddg.reach).toBe("dead");
    expect(health.bing.reach).toBe("ok");
    expect((await getOrderedEngines(ENGINES)).map((e) => e.id)).toEqual([
      "bing",
      "baidu",
      "ddg",
      "google",
    ]);

    fetchMock.mockClear();
    await maybeProbeEngines();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
