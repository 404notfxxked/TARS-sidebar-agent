// @vitest-environment jsdom
// AskCard 组件单测:交互态(单选即点即答/多选与多问卡片级提交/其他自由
// 输入/提交后禁用)与已答态(选中高亮/自由文本/超时未答徽记/回放同款)。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { zhCN } from "../../shared/i18n/locales/zh-CN";
import { AskCard, parseAskResult } from "./AskCard";

afterEach(cleanup);

const answeredResult = JSON.stringify({
  answers: [{ question: "要操作哪个标签页?", selected: ["结算页"] }],
});

const ONE_Q = [
  {
    question: "要操作哪个标签页?",
    header: "目标页", // i18n-ok 协议 mock 数据(SW 侧校验的 header 用例),非 UI 文案断言
    options: [
      { label: "结算页", description: "example.com 的结算" },
      { label: "商品列表" },
    ],
  },
];

const TWO_Q_MULTI = [
  { question: "先做什么?", options: [{ label: "A1" }, { label: "B1" }] },
  {
    question: "偏好哪些?",
    options: [{ label: "X" }, { label: "Y" }, { label: "Z" }],
    multiSelect: true,
  },
];

const renderInteractive = (
  questions: unknown[],
  onAnswer = vi.fn(),
  timeoutMs?: number,
) => {
  render(
    <AskCard
      questions={questions as never}
      interactive
      onAnswer={onAnswer}
      timeoutMs={timeoutMs}
    />,
  );
  return onAnswer;
};

describe("AskCard 交互态", () => {
  it("单问单选:点选项即作答;问题描述与 header 上卡", async () => {
    const onAnswer = renderInteractive(ONE_Q);
    expect(screen.getByText("要操作哪个标签页?")).toBeInTheDocument();
    expect(screen.getByText("目标页" /* i18n-ok mock 数据回显,非字典断言 */)).toBeInTheDocument();
    expect(screen.getByText("example.com 的结算")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /结算页/ }));
    expect(onAnswer).toHaveBeenCalledWith([{ selected: ["结算页"] }]);
  });

  it("「其他」展开自由输入,发送即作答(text 通道)", async () => {
    const user = userEvent.setup();
    const onAnswer = renderInteractive(ONE_Q);
    await user.click(screen.getByRole("button", { name: zhCN.chat.askOther }));
    await user.type(
      screen.getByRole("textbox", { name: zhCN.chat.askOtherPlaceholder }),
      "都不对,用第三个",
    );
    await user.click(screen.getByRole("button", { name: zhCN.chat.askSend }));
    expect(onAnswer).toHaveBeenCalledWith([
      { selected: [], text: "都不对,用第三个" },
    ]);
  });

  it("多选/多问:卡片级提交,未答齐时禁用;多选可逐项勾选", async () => {
    const user = userEvent.setup();
    const onAnswer = renderInteractive(TWO_Q_MULTI);
    const submit = screen.getByRole("button", { name: zhCN.chat.askSubmit });
    expect(submit).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /^A1/ }));
    expect(submit).toBeDisabled(); // 第二问未答
    await user.click(screen.getByRole("button", { name: /^X/ }));
    await user.click(screen.getByRole("button", { name: /^Y/ }));
    expect(submit).toBeEnabled();
    await user.click(submit);
    expect(onAnswer).toHaveBeenCalledWith([
      { selected: ["A1"] },
      { selected: ["X", "Y"] },
    ]);
  });

  it("提交后进入已提交态,不再重复作答", async () => {
    const user = userEvent.setup();
    const onAnswer = renderInteractive(TWO_Q_MULTI);
    await user.click(screen.getByRole("button", { name: /^A1/ }));
    await user.click(screen.getByRole("button", { name: /^Z/ }));
    await user.click(screen.getByRole("button", { name: zhCN.chat.askSubmit }));
    expect(screen.getByText(zhCN.chat.askSubmitted)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^A1/ }));
    expect(onAnswer).toHaveBeenCalledTimes(1);
  });

  it("超时口径随载荷展示(分钟)", () => {
    renderInteractive(ONE_Q, vi.fn(), 300_000);
    expect(
      screen.getByText(zhCN.chat.askTimeoutHint.replace("{n}", "5")),
    ).toBeInTheDocument();
  });
});

describe("AskCard 已答态(实况收口与回放同款)", () => {
  it("选中项高亮、其余仍在场但非按钮", () => {
    render(
      <AskCard questions={ONE_Q as never} interactive={false} result={answeredResult} />,
    );
    expect(screen.getByText("结算页")).toBeInTheDocument();
    expect(screen.getByText("商品列表")).toBeInTheDocument();
    // 已答态不再有可点选项/提交钮
    expect(
      screen.queryByRole("button", { name: zhCN.chat.askSubmit }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /商品列表/ }),
    ).not.toBeInTheDocument();
  });

  it("「其他」自由文本以回答行展示", () => {
    render(
      <AskCard
        questions={ONE_Q as never}
        interactive={false}
        result={JSON.stringify({
          answers: [{ question: "要操作哪个标签页?", selected: [], text: "用第三个" }],
        })}
      />,
    );
    expect(screen.getByText(/用第三个/)).toBeInTheDocument();
  });

  it("超时未答:徽记与口径上卡(未答≠拒绝,模型自行判断)", () => {
    render(
      <AskCard
        questions={ONE_Q as never}
        interactive={false}
        result={JSON.stringify({ status: "unanswered", note: "..." })}
      />,
    );
    expect(screen.getByText(zhCN.chat.askUnansweredBadge)).toBeInTheDocument();
  });

  it("result 缺席(running 但面板已丢请求/SW 回收):等待态不崩", () => {
    render(<AskCard questions={ONE_Q as never} interactive={false} result={undefined} />);
    expect(screen.getByText("要操作哪个标签页?")).toBeInTheDocument();
    expect(screen.getByText(zhCN.chat.askWaiting)).toBeInTheDocument();
  });
});

describe("parseAskResult", () => {
  it("作答/未答/垃圾输入三路", () => {
    expect(parseAskResult(answeredResult)?.answers?.[0].selected).toEqual(["结算页"]);
    expect(parseAskResult('{"status":"unanswered"}')?.unanswered).toBe(true);
    expect(parseAskResult("not json")).toBeNull();
    expect(parseAskResult(undefined)).toBeNull();
  });
});
