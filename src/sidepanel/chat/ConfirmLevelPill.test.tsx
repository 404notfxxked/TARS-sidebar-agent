// @vitest-environment jsdom
// composer 档位 pill:hook(useConfirmLevel 的 storage 订阅)+ pill 组件
// 的集成测试(Shell = hook + pill,真话链路不过 mock)。覆盖:短标与
// aria 长标、菜单三档同权(2026-10-04 决策:off 入菜单单击落档)、
// 点选落档(strict/auto/off)、off 态 warning 色、onChanged 跟随、
// 键盘导航与 Esc。

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { zhCN } from "../../shared/i18n/locales/zh-CN";

const h = vi.hoisted(() => ({ saved: [] as unknown[] }));

vi.mock("../../shared/configStore", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  saveConfirmLevel: vi.fn((level: unknown) => {
    h.saved.push(level);
    return Promise.resolve();
  }),
}));

import ConfirmLevelPill from "./ConfirmLevelPill";
import { useConfirmLevel } from "./useConfirmLevel";

/** 集成壳:hook + pill 同渲染,storage 与 saveConfirmLevel 都走真链路 */
function Shell() {
  const { level, pick } = useConfirmLevel();
  return <ConfirmLevelPill level={level} pick={pick} />;
}

const pillName = (longLabel: string) =>
  zhCN.chat.confirmPillAria.replace("{level}", longLabel);
const openMenu = async (longLabel: string) => {
  render(<Shell />);
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: pillName(longLabel) }),
  );
  return user;
};

afterEach(() => {
  h.saved.length = 0;
  cleanup();
});

describe("确认档位 pill", () => {
  it("strict 态:pill 短标正确,aria 名带当前档长标", async () => {
    render(<Shell />);
    const btn = await screen.findByRole("button", {
      name: pillName(zhCN.security.confirmLevelStrict),
    });
    expect(btn).toHaveTextContent(zhCN.chat.confirmPillStrict);
  });

  it("菜单三档同权:strict/auto/off 都在,off 排尾带 warning 色", async () => {
    await openMenu(zhCN.security.confirmLevelStrict);
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(3);
    expect(screen.getByText(zhCN.chat.confirmPillStrict)).toBeInTheDocument();
    expect(screen.getByText(zhCN.chat.confirmPillAuto)).toBeInTheDocument();
    const offOption = screen.getByRole("option", {
      name: new RegExp(zhCN.chat.confirmPillOff),
    });
    expect(options[2]).toBe(offOption);
    // off 项标示走 warning(危险相邻但非错误),不走 error
    expect(offOption.querySelector("span")).toHaveClass("text-warning");
    // 知情由 desc 全量承载:off 的 desc 在场
    expect(screen.getByText(zhCN.chat.confirmPillOffDesc)).toBeInTheDocument();
  });

  it("点选 auto 调 saveConfirmLevel(auto)", async () => {
    const user = await openMenu(zhCN.security.confirmLevelStrict);
    await user.click(screen.getByRole("option", { name: /页面放行/ }));
    expect(h.saved).toEqual(["auto"]);
  });

  it("点选 off 单击即落档(三档同权,无二次确认)", async () => {
    const user = await openMenu(zhCN.security.confirmLevelStrict);
    await user.click(screen.getByRole("option", { name: /全部放行/ }));
    expect(h.saved).toEqual(["off"]);
  });

  it("off 态:pill 带 text-warning 常驻标示", async () => {
    await act(async () => {
      await chrome.storage.local.set({ confirmLevel: "off" });
    });
    render(<Shell />);
    const btn = await screen.findByRole("button", {
      name: pillName(zhCN.security.confirmLevelOff),
    });
    expect(btn).toHaveClass("text-warning");
    expect(btn).toHaveTextContent(zhCN.chat.confirmPillOff);
  });

  it("直写 chrome.storage 后 pill 文案跟随变化(onChanged 路径)", async () => {
    render(<Shell />);
    await screen.findByRole("button", {
      name: pillName(zhCN.security.confirmLevelStrict),
    });
    await act(async () => {
      await chrome.storage.local.set({ confirmLevel: "auto" });
    });
    await waitFor(() => {
      expect(
        screen.getByRole("button", {
          name: pillName(zhCN.security.confirmLevelAuto),
        }),
      ).toHaveTextContent(zhCN.chat.confirmPillAuto);
    });
  });

  it("键盘:方向键移动高亮,Enter 选中;Esc 关闭菜单", async () => {
    const user = await openMenu(zhCN.security.confirmLevelStrict);
    const menu = screen.getByRole("listbox");
    expect(menu.getAttribute("aria-activedescendant")).toMatch(/cl-opt-0$/);
    await user.keyboard("{ArrowDown}");
    expect(menu.getAttribute("aria-activedescendant")).toMatch(/cl-opt-1$/);
    await user.keyboard("{Enter}");
    expect(h.saved).toEqual(["auto"]);
    await openMenu(zhCN.security.confirmLevelStrict);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });
});
