// @vitest-environment jsdom
// composer 档位 pill:hook(useConfirmLevel 的 storage 订阅)+ pill 组件
// 的集成测试(Shell = hook + pill,真话链路不过 mock)。7 条覆盖工单 §5:
// 短标与 aria 长标、菜单只有 strict/auto(off 的反向断言锁「composer
// 到不了 off」的结构属性)、点选落档、off 态警示、onChanged 跟随、
// 键盘导航与 Esc、底部生效时点提示。

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

  it("菜单只有 strict 与 auto 两项;反向断言:不存在名为 off 的可选档", async () => {
    await openMenu(zhCN.security.confirmLevelStrict);
    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(screen.getByText(zhCN.chat.confirmPillStrict)).toBeInTheDocument();
    expect(screen.getByText(zhCN.chat.confirmPillAuto)).toBeInTheDocument();
    // off 只以指路行出现,不是可选项 —— 「composer 到不了 off」的边界
    expect(
      screen.queryByRole("option", { name: new RegExp(zhCN.chat.confirmPillOff) }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(zhCN.chat.confirmPillOffGoto)).toBeInTheDocument();
  });

  it("点选 auto 调 saveConfirmLevel(auto)", async () => {
    const user = await openMenu(zhCN.security.confirmLevelStrict);
    await user.click(screen.getByRole("option", { name: /页面放行/ }));
    expect(h.saved).toEqual(["auto"]);
  });

  it("off 态:pill 带 text-error,菜单顶部出现「当前:全部放行」提示", async () => {
    await act(async () => {
      await chrome.storage.local.set({ confirmLevel: "off" });
    });
    render(<Shell />);
    const btn = await screen.findByRole("button", {
      name: pillName(zhCN.security.confirmLevelOff),
    });
    expect(btn).toHaveClass("text-error");
    expect(btn).toHaveTextContent(zhCN.chat.confirmPillOff);
    await openMenu(zhCN.security.confirmLevelOff);
    expect(screen.getByText(zhCN.chat.confirmPillOffCurrent)).toBeInTheDocument();
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
    console.log("after Enter: menu open =", document.querySelector('[role="listbox"]') !== null, "saved =", JSON.stringify(h.saved));
    expect(h.saved).toEqual(["auto"]);
    await openMenu(zhCN.security.confirmLevelStrict);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  it("菜单底部出现生效时点提示(复用 security.confirmLevelHint)", async () => {
    await openMenu(zhCN.security.confirmLevelStrict);
    expect(screen.getByText(zhCN.security.confirmLevelHint)).toBeInTheDocument();
  });
});
