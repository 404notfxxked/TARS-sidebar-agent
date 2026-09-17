// @vitest-environment jsdom
// ConfirmCard 组件单测:确认卡内容组装(目标页/写入/回车提示/定位)与
// 允许/拒绝出口。此前只有 e2e 慢链路覆盖(2026-09 评审 T6)。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { MSG, type AgentEvent } from "../../shared/messages";
import { zhCN } from "../../shared/i18n/locales/zh-CN";
import { ConfirmCard } from "./ConfirmCard";

// vitest 未开 globals:RTL 的自动 cleanup 不生效,手动清防渲染泄漏
afterEach(cleanup);

type ConfirmReq = Extract<AgentEvent, { type: typeof MSG.AGENT_CONFIRM_REQUEST }>;

const baseReq: ConfirmReq = {
  type: MSG.AGENT_CONFIRM_REQUEST,
  requestId: "r1",
  name: "fill_input",
  args: {
    selector: "#search-q",
    text: "确认门测试写入内容",
    pressEnterAfter: true,
  },
  tabTitle: "搜索页",
  tabUrl: "https://www.example.com/search",
};

const renderCard = (overrides: Partial<ConfirmReq> = {}, onAnswer = vi.fn()) => {
  const req = { ...baseReq, ...overrides };
  render(<ConfirmCard req={req} onAnswer={onAnswer} />);
  return onAnswer;
};

describe("ConfirmCard 确认卡", () => {
  it("标题/目标页(标题+主机名)/写入内容/回车提示/定位齐全", () => {
    renderCard();
    expect(
      screen.getByRole("alertdialog", { name: zhCN.chat.confirmTitle }),
    ).toBeInTheDocument();
    // 目标页面:{title} —— tabTitle + 主机名拼装
    // 期望串全部从字典键派生(含全角标点),措辞/标点改动断言自动跟随;
    // 主机名括号与组件同款全角(ConfirmCard 拼装用(紧))
    expect(
      screen.getByText(
        zhCN.chat.confirmTarget.replace("{title}", "搜索页（www.example.com）"),
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(zhCN.chat.confirmFillText.replace("{text}", "确认门测试写入内容")),
    ).toBeInTheDocument();
    expect(screen.getByText(zhCN.chat.confirmSubmitHint)).toBeInTheDocument();
    expect(
      screen.getByText(zhCN.chat.confirmSelectorLabel.replace("{selector}", "#search-q")),
    ).toBeInTheDocument();
  });

  it("拒绝与允许分别回调 false / true", async () => {
    const user = userEvent.setup();
    const onAnswer = renderCard();
    await user.click(
      screen.getByRole("button", { name: zhCN.chat.confirmDeny }),
    );
    expect(onAnswer).toHaveBeenCalledWith(false);
    await user.click(
      screen.getByRole("button", { name: zhCN.chat.confirmAllow }),
    );
    expect(onAnswer).toHaveBeenCalledWith(true);
    expect(onAnswer).toHaveBeenCalledTimes(2);
  });

  it("非 fill 工具不渲染写入内容与回车提示,仅展示定位", () => {
    renderCard({
      name: "click_element",
      args: { selector: "#submit-btn" },
    });
    expect(screen.queryByText(/将写入:/)).not.toBeInTheDocument();
    expect(screen.queryByText("写入后将回车提交")).not.toBeInTheDocument();
    expect(
      screen.getByText(zhCN.chat.confirmSelectorLabel.replace("{selector}", "#submit-btn")),
    ).toBeInTheDocument();
  });

  it("fill 文本超 80 字截断加省略号", () => {
    const long = "字".repeat(100);
    renderCard({ args: { text: long } });
    expect(
      screen.getByText(zhCN.chat.confirmFillText.replace("{text}", `${"字".repeat(80)}…`)),
    ).toBeInTheDocument();
  });

  it("tabUrl 非法且无 tabTitle 时目标页行整个不渲染(不崩)", () => {
    renderCard({ tabUrl: "::bad-url::", tabTitle: undefined });
    expect(screen.queryByText(/目标页面:/)).not.toBeInTheDocument();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("无 tabTitle 只有合法 tabUrl:目标页只显示主机名", () => {
    renderCard({ tabUrl: "https://cdn.example.org/x", tabTitle: undefined });
    expect(
      screen.getByText(zhCN.chat.confirmTarget.replace("{title}", "cdn.example.org")),
    ).toBeInTheDocument();
  });
});
