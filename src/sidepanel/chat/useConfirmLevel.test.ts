// @vitest-environment jsdom
// useConfirmLevel 的 hook 层单测:storage 订阅的生命周期与输入过滤,以及
// pick 的时序契约(先落库、后改本地态 —— 落库未结算前本地档位不动)。
// pill 侧的渲染/菜单/键盘行为在 ConfirmLevelPill.test.tsx(集成壳),
// 这里只测 hook 本身:初值、pick 落档与落库时序、onChanged 的合法值过滤
// 与 area 过滤、卸载移除监听。

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  saved: [] as unknown[],
  /** 挂起中的落库 resolve(测「写未落定前本地态不动」的闸门);afterEach 放行 */
  gates: [] as (() => void)[],
}));

vi.mock("../../shared/configStore", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  saveConfirmLevel: vi.fn((level: unknown) => {
    h.saved.push(level);
    return new Promise<void>((resolve) => {
      h.gates.push(resolve);
    });
  }),
}));

import { useConfirmLevel } from "./useConfirmLevel";

afterEach(() => {
  h.saved.length = 0;
  for (const release of h.gates.splice(0)) release(); // 放行未落定的写,防串场
  vi.restoreAllMocks();
  cleanup();
});

describe("useConfirmLevel", () => {
  it("初值取自存储(confirmLevel: auto)", async () => {
    await chrome.storage.local.set({ confirmLevel: "auto" });
    const { result } = renderHook(() => useConfirmLevel());
    await waitFor(() => expect(result.current.level).toBe("auto"));
  });

  it("存储无键时初值回落 strict(安全默认)", async () => {
    const { result } = renderHook(() => useConfirmLevel());
    await waitFor(() => expect(result.current.level).toBe("strict"));
  });

  it("pick 落库完成才更新本地档位,返回值可 await(hook 契约)", async () => {
    const { result } = renderHook(() => useConfirmLevel());
    await waitFor(() => expect(result.current.level).toBe("strict"));
    let settled = false;
    act(() => {
      void result.current.pick("auto").then(() => {
        settled = true; // 落库 promise 结算后 pick 才 resolve
      });
    });
    h.gates.shift()?.(); // 放行落库
    await waitFor(() => expect(result.current.level).toBe("auto"));
    await waitFor(() => expect(settled).toBe(true));
    expect(h.saved).toEqual(["auto"]);
  });

  it("落库未完成前本地档位不动:UI 不会先于存储改写(消与 run 快照的竞态)", async () => {
    const { result } = renderHook(() => useConfirmLevel());
    await waitFor(() => expect(result.current.level).toBe("strict"));
    // 不发 act 的 await:pick 挂在落库上,act 的作用域结算不得等它
    let settled = false;
    act(() => {
      void result.current.pick("off").then(() => {
        settled = true;
      });
    });
    // 落库还挂着:写已发起,但文案不得先跳 —— 否则 e2e 拿 UI 文案当落库
    // 同步点时,后台 run 快照仍可能读到旧档(strict = 这条消息又被门拦下)
    expect(h.saved).toEqual(["off"]);
    expect(result.current.level).toBe("strict");
    expect(settled).toBe(false); // 未落定 = pick 未 resolve
    h.gates.shift()?.(); // 放行落库
    await waitFor(() => expect(result.current.level).toBe("off"));
    await waitFor(() => expect(settled).toBe(true));
  });

  it("onChanged 只认合法档位值,脏值(如大小写错)不更新", async () => {
    const { result } = renderHook(() => useConfirmLevel());
    await waitFor(() => expect(result.current.level).toBe("strict"));
    await act(async () => {
      await chrome.storage.local.set({ confirmLevel: "STRICT" });
    });
    expect(result.current.level).toBe("strict");
  });

  it("session 区的变化不触发更新(只订阅 local)", async () => {
    const { result } = renderHook(() => useConfirmLevel());
    await waitFor(() => expect(result.current.level).toBe("strict"));
    await act(async () => {
      await chrome.storage.session.set({ confirmLevel: "off" });
    });
    expect(result.current.level).toBe("strict");
  });

  it("卸载时移除 storage 监听(add/remove 各一次)", async () => {
    const addSpy = vi.spyOn(chrome.storage.onChanged, "addListener");
    const removeSpy = vi.spyOn(chrome.storage.onChanged, "removeListener");
    const { unmount } = renderHook(() => useConfirmLevel());
    unmount();
    expect(removeSpy).toHaveBeenCalledWith(addSpy.mock.calls[0][0]);
  });
});
