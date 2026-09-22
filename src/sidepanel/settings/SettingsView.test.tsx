// @vitest-environment jsdom
// SettingsView 配置读取失败回归(需求 REQ-P0-4):此前 loadConfig().then 无
// catch,存储异常时 config 恒 null,整页只剩顶栏(永久空白且无出口)。
// 修复后:失败渲染「读取失败 + 重试」,重试仍失败停在失败态、不崩。
// 刻意不测「重试成功 → 分节渲染」:整页挂载会触发各分节的挂载副作用
// (DataSection 的 storage.estimate、Memory/Skill 的 port 请求),jsdom 无桩,
// 那条路径归 layout e2e 覆盖。期望串经 zhCN 字典键派生(硬规则 1)。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { zhCN } from "../../shared/i18n/locales/zh-CN";

// jsdom 无 matchMedia:SettingsView → AppearanceSection → theme 的静态导入链
// 在模块求值期就读 matchMedia,桩必须先于导入链安装(vi.hoisted 先于 import 执行)
vi.hoisted(() => {
  const w = globalThis as typeof globalThis & {
    window?: typeof window;
  };
  if (typeof w.window !== "undefined" && !w.window.matchMedia) {
    Object.defineProperty(w.window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  }
});

const h = vi.hoisted(() => ({
  // 每次调用的返回(末位生效),用例逐个安装
  impls: [] as (() => Promise<never>)[],
}));

vi.mock("../../shared/configStore", async (importOriginal) => {
  const mod = await importOriginal<
    typeof import("../../shared/configStore")
  >();
  return {
    ...mod,
    loadConfig: vi.fn(() => h.impls[h.impls.length - 1]!()),
  };
});

import SettingsView from "./SettingsView";

afterEach(() => {
  h.impls.length = 0;
  cleanup();
});

const fail = () =>
  h.impls.push(() => Promise.reject(new Error("storage down"))); // i18n-ok 测试种子

describe("SettingsView 配置读取失败", () => {
  it("读取失败 → 渲染失败态 + 重试,而非只剩顶栏的空白页", async () => {
    fail();
    render(
      <SettingsView
        onBack={() => {}}
        onOpenMemory={() => {}}
        onOpenSkills={() => {}}
      />,
    );
    expect(await screen.findByText(zhCN.common.loadFailed)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: zhCN.common.retry }),
    ).toBeInTheDocument();
  });

  it("重试仍失败 → 停在失败态不崩", async () => {
    const user = userEvent.setup();
    fail();
    render(
      <SettingsView
        onBack={() => {}}
        onOpenMemory={() => {}}
        onOpenSkills={() => {}}
      />,
    );
    await screen.findByText(zhCN.common.loadFailed);

    await user.click(screen.getByRole("button", { name: zhCN.common.retry }));
    expect(await screen.findByText(zhCN.common.loadFailed)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: zhCN.common.retry }),
    ).toBeInTheDocument();
  });
});
