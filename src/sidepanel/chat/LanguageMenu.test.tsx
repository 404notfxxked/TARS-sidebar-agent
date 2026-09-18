// @vitest-environment jsdom
// LanguageMenu 组件单测:开合/当前选中标记/切换即 setLocale+savePrefs/
// 点当前语言不重复落盘/Esc 关菜单。整树刷新与持久化 e2e 已有(probe-locale),
// 这里用毫秒级单测钉交互细节。语言是 i18n 模块级状态:每例后还原 zh-CN。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { zhCN } from "../../shared/i18n/locales/zh-CN";
import { enUS } from "../../shared/i18n/locales/en-US";
import { setLocale } from "../../shared/i18n";
import LanguageMenu from "./LanguageMenu";

const { savePrefsMock } = vi.hoisted(() => ({
  savePrefsMock: vi.fn<(patch: unknown) => Promise<void>>().mockResolvedValue(undefined),
}));

vi.mock("../../shared/configStore", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  savePrefs: (patch: unknown) => savePrefsMock(patch),
}));

// vitest 未开 globals:RTL 的自动 cleanup 不生效,手动清防渲染泄漏
afterEach(() => {
  cleanup();
  setLocale("zh-CN"); // setLocale 改的是模块级单例,不还原会泄漏到下一例
  savePrefsMock.mockClear();
});

const trigger = () => screen.getByRole("button", { name: zhCN.chat.switchLanguage });

async function setup() {
  const user = userEvent.setup();
  render(<LanguageMenu />);
  await user.click(trigger());
  return user;
}

describe("LanguageMenu(首页语言快捷切换)", () => {
  it("展开为两项单选,当前语言带 aria-checked", async () => {
    const user = await setup();
    const zh = screen.getByRole("menuitemradio", { name: zhCN.settings.languageZh });
    const en = screen.getByRole("menuitemradio", { name: zhCN.settings.languageEn });
    expect(zh).toHaveAttribute("aria-checked", "true");
    expect(en).toHaveAttribute("aria-checked", "false");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("选另一语言:setLocale 生效(选中态翻转)且 savePrefs 落盘", async () => {
    const user = await setup();
    await user.click(
      screen.getByRole("menuitemradio", { name: zhCN.settings.languageEn }),
    );
    expect(savePrefsMock).toHaveBeenCalledWith({ locale: "en-US" });
    // useLocale 订阅驱动重渲染:整树文案已随 setLocale 翻到英文,
    // 触发钮要按英文名重找;重开菜单后选中态应停在 English
    await user.click(
      screen.getByRole("button", { name: enUS.chat.switchLanguage }),
    );
    expect(
      screen.getByRole("menuitemradio", { name: zhCN.settings.languageEn }),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("点当前语言:收起菜单,不重复落盘", async () => {
    const user = await setup();
    await user.click(
      screen.getByRole("menuitemradio", { name: zhCN.settings.languageZh }),
    );
    expect(savePrefsMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
