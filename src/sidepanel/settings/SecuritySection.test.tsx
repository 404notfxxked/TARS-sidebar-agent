// @vitest-environment jsdom
// SecuritySection 确认档位:三档 Segmented + off 档两步确认(第一击 arm 只
// 显示提示不落 prefs,第二击落档;8s 超窗自动复位)。value 不许乐观更新
// ——键盘路径「方向键连按两次落在同一目标才提交」依赖 Segmented 的 value
// 仍指旧档。文案断言一律整值取字典键(check-test-strings 子串漂移纪律)。

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { zhCN } from "../../shared/i18n/locales/zh-CN";

const h = vi.hoisted(() => ({
  saved: [] as unknown[],
  prefWrites: [] as Record<string, unknown>[],
  perms: { requested: 0, revoked: 0, granted: true },
}));

vi.mock("../../shared/configStore", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  saveConfirmLevel: vi.fn((level: unknown) => {
    h.saved.push(level);
    return Promise.resolve();
  }),
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

const seg = () => screen.getByRole("radiogroup", {
  name: zhCN.security.confirmLevel,
});
const option = (label: string) =>
  screen.getByRole("radio", { name: label });

afterEach(() => {
  h.saved.length = 0;
  h.prefWrites.length = 0;
  h.perms = { requested: 0, revoked: 0, granted: true };
  cleanup();
  vi.useRealTimers();
});

function renderSection(initial: "strict" | "auto" | "off") {
  render(
    <SecuritySection initialConfirmLevel={initial} initialNotifyDone={false} run={() => {}} />,
  );
  return act(async () => {}); // hasPageAccess 回包落定
}

describe("确认档位 Segmented(三档)", () => {
  it("三档渲染且选中态来自 props(初始 auto)", async () => {
    await renderSection("auto");
    expect(seg()).toBeInTheDocument();
    expect(option(zhCN.security.confirmLevelAuto)).toBeChecked();
  });

  it("选 auto 直接落档(两步确认只属于 off)", async () => {
    const user = userEvent.setup();
    await renderSection("strict");
    await user.click(option(zhCN.security.confirmLevelAuto));
    expect(h.saved).toEqual(["auto"]);
  });

  it("off 两步确认:第一击不落 prefs,第二击落档", async () => {
    const user = userEvent.setup();
    await renderSection("auto");
    await user.click(option(zhCN.security.confirmLevelOff));
    expect(h.saved).toEqual([]); // 第一击只 arm,不写
    expect(screen.getByText(zhCN.security.confirmLevelArm)).toBeInTheDocument();
    // 选中段仍显示旧档(value 不乐观更新)
    expect(option(zhCN.security.confirmLevelAuto)).toBeChecked();
    await user.click(option(zhCN.security.confirmLevelOff));
    expect(h.saved).toEqual(["off"]);
    expect(
      screen.queryByText(zhCN.security.confirmLevelArm),
    ).not.toBeInTheDocument();
  });

  it("arm 超窗(8s)自动复位:再单击 off 需重新 arm,不会一击落档", async () => {
    vi.useFakeTimers();
    await renderSection("auto");
    fireEvent.click(option(zhCN.security.confirmLevelOff));
    expect(screen.getByText(zhCN.security.confirmLevelArm)).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(8000);
    });
    expect(
      screen.queryByText(zhCN.security.confirmLevelArm),
    ).not.toBeInTheDocument();
    fireEvent.click(option(zhCN.security.confirmLevelOff));
    expect(h.saved).toEqual([]); // 复位后一击不落
  });

  it("键盘路径:方向键连按两次落在 off 才提交(value 不乐观更新的依赖)", async () => {
    const user = userEvent.setup();
    await renderSection("auto");
    // 焦点置于选中段(roving tabindex 的可停留段),方向键经冒泡进 radiogroup
    option(zhCN.security.confirmLevelAuto).focus();
    await user.keyboard("{ArrowRight}");
    expect(h.saved).toEqual([]); // 第一次到 off:只 arm
    await user.keyboard("{ArrowRight}");
    expect(h.saved).toEqual(["off"]); // 第二次仍解析到 off(若乐观更新会绕到 strict)
  });
});

describe("档位说明文案(常驻)", () => {
  it("auto 档明示范围口径与提交类免问", async () => {
    await renderSection("auto");
    expect(
      screen.getByText(zhCN.security.confirmLevelScope),
    ).toBeInTheDocument();
    expect(
      screen.getByText(zhCN.security.confirmLevelSubmit),
    ).toBeInTheDocument();
  });

  it("off 档常驻警示含记忆写入与 MCP 调用口径", async () => {
    await renderSection("off");
    expect(
      screen.getByText(zhCN.security.confirmLevelOffWarning),
    ).toBeInTheDocument();
  });

  it("hint 常驻生效时点说明(切换对进行中任务不生效)", async () => {
    await renderSection("strict");
    expect(screen.getByText(zhCN.security.confirmLevelHint)).toBeInTheDocument();
  });
});

describe("站点授权行(读页/搜索/读网页的总闸)", () => {
  it("已授权态:显示撤销钮,点击走 revokePageAccess", async () => {
    const user = userEvent.setup();
    await renderSection("strict");
    await user.click(
      screen.getByRole("button", { name: zhCN.security.hostAccessRevoke }),
    );
    expect(h.perms.revoked).toBe(1);
  });

  it("未授权态:显示授权钮,点击走 requestPageAccess", async () => {
    h.perms.granted = false;
    const user = userEvent.setup();
    await renderSection("strict");
    await user.click(
      screen.getByRole("button", { name: zhCN.security.hostAccessGrant }),
    );
    expect(h.perms.requested).toBe(1);
  });

  it("未授权态:展开「了解更多」显示授权覆盖范围详情", async () => {
    h.perms.granted = false;
    const user = userEvent.setup();
    await renderSection("strict");
    await user.click(
      screen.getByRole("button", { name: zhCN.common.learnMore }),
    );
    expect(
      screen.getByText(zhCN.security.hostAccessDetail),
    ).toBeInTheDocument();
  });

  it("任务完成通知开关切换落 prefs", async () => {
    const user = userEvent.setup();
    await renderSection("strict");
    await user.click(
      screen.getByRole("switch", { name: zhCN.security.notifyDone }),
    );
    expect(h.prefWrites).toContainEqual({ notifyDone: true });
  });
});
