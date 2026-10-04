// @vitest-environment jsdom
// SecuritySection:站点授权行(读页/搜索/读网页的总闸)+ 任务完成通知。
// 确认档位已迁 composer 的档位 pill(2026-10-04 决策,见 SecuritySection
// 头注),本文件不再覆盖档位 UI —— pill 侧见 ConfirmLevelPill.test。
// 文案断言一律整值取字典键(check-test-strings 子串漂移纪律)。

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { zhCN } from "../../shared/i18n/locales/zh-CN";

const h = vi.hoisted(() => ({
  prefWrites: [] as Record<string, unknown>[],
  perms: { requested: 0, revoked: 0, granted: true },
}));

vi.mock("../../shared/configStore", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  savePrefs: vi.fn((prefs: Record<string, unknown>) => {
    h.prefWrites.push(prefs);
    return Promise.resolve();
  }),
}));

vi.mock("../permissions", () => ({
  hasPageAccess: vi.fn(async () => h.perms.granted),
  requestPageAccess: vi.fn(async () => {
    h.perms.requested += 1;
    return true;
  }),
  revokePageAccess: vi.fn(async () => {
    h.perms.revoked += 1;
    return undefined;
  }),
}));

import SecuritySection from "./SecuritySection";

afterEach(() => {
  h.prefWrites.length = 0;
  h.perms = { requested: 0, revoked: 0, granted: true };
  cleanup();
});

function renderSection() {
  render(<SecuritySection initialNotifyDone={false} run={() => {}} />);
  return act(async () => {}); // hasPageAccess 回包落定
}

describe("站点授权行(读页/搜索/读网页的总闸)", () => {
  it("已授权态:显示撤销钮,点击走 revokePageAccess", async () => {
    const user = userEvent.setup();
    await renderSection();
    await user.click(
      screen.getByRole("button", { name: zhCN.security.hostAccessRevoke }),
    );
    expect(h.perms.revoked).toBe(1);
  });

  it("未授权态:显示授权钮,点击走 requestPageAccess", async () => {
    h.perms.granted = false;
    const user = userEvent.setup();
    await renderSection();
    await user.click(
      screen.getByRole("button", { name: zhCN.security.hostAccessGrant }),
    );
    expect(h.perms.requested).toBe(1);
  });

  it("未授权态:展开「了解更多」显示授权覆盖范围详情", async () => {
    h.perms.granted = false;
    const user = userEvent.setup();
    await renderSection();
    await user.click(screen.getByRole("button", { name: zhCN.common.learnMore }));
    expect(
      screen.getByText(zhCN.security.hostAccessDetail),
    ).toBeInTheDocument();
  });

  it("任务完成通知开关切换落 prefs", async () => {
    const user = userEvent.setup();
    await renderSection();
    await user.click(
      screen.getByRole("switch", { name: zhCN.security.notifyDone }),
    );
    expect(h.prefWrites).toContainEqual({ notifyDone: true });
  });

  it("确认档位已迁出:分节内不再出现档位选项(反向断言)", async () => {
    await renderSection();
    // confirmLevelStrict 键仍存(pill 的 aria 长标在用),但设置页不应渲染
    expect(
      screen.queryByText(zhCN.security.confirmLevelStrict),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("radio", {
        name: zhCN.security.confirmLevelOff,
      }),
    ).not.toBeInTheDocument();
  });

  it("授权回包前卸载:alive 守卫拦住迟到回包,不落状态", async () => {
    const { unmount } = render(<SecuritySection initialNotifyDone={false} run={() => {}} />);
    unmount(); // hasPageAccess 微任务回包前卸载
    await act(async () => {}); // 回包落定:alive=false 分支
    // 卸载后无渲染可断状态,本条盖的是「不抛错、不写已卸载组件」的路径
  });
});
