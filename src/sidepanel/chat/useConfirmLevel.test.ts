// @vitest-environment jsdom
// useConfirmLevel 的 hook 层单测:storage 订阅的生命周期与输入过滤。
// pill 侧的渲染/菜单/键盘行为在 ConfirmLevelPill.test.tsx(集成壳),
// 这里只测 hook 本身:初值、pick 落档、onChanged 的合法值过滤与
// area 过滤、卸载移除监听。

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({ saved: [] as unknown[] }));

vi.mock("../../shared/configStore", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  saveConfirmLevel: vi.fn((level: unknown) => {
    h.saved.push(level);
    return Promise.resolve();
  }),
}));

import { useConfirmLevel } from "./useConfirmLevel";

afterEach(() => {
  h.saved.length = 0;
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

  it("pick 调 saveConfirmLevel 并即时更新本地档位", async () => {
    const { result } = renderHook(() => useConfirmLevel());
    await waitFor(() => expect(result.current.level).toBe("strict"));
    act(() => result.current.pick("auto"));
    expect(result.current.level).toBe("auto");
    expect(h.saved).toEqual(["auto"]);
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
