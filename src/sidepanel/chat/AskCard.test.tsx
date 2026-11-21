// @vitest-environment jsdom
// AskCard 组件单测:交互态(点选后卡片级提交 —— 单选同款防误触/其他自由
// 输入/提交门控/提交后锁定)与收起态(已答默认收起为摘要行、展开回看高亮
// 选项/未答徽记/等待态)。回放与实况同一渲染路径,不另测。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { zhCN } from "../../shared/i18n/locales/zh-CN";
import { AskCard, parseAskResult } from "./AskCard";

afterEach(cleanup);

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

const answeredResult = JSON.stringify({
  answers: [{ question: "要操作哪个标签页?", selected: ["结算页"] }],
});

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
  it("单问单选:点选仅选中,提交后才作答;单问不带进度标示", async () => {
    const user = userEvent.setup();
    const onAnswer = renderInteractive(ONE_Q);
    expect(screen.getByText("要操作哪个标签页?")).toBeInTheDocument();
    expect(screen.getByText("目标页" /* i18n-ok mock 数据回显,非字典断言 */)).toBeInTheDocument();
    // 单问 1/1 是噪音:进度标示只在多问时出现
    expect(
      screen.queryByText(zhCN.chat.askProgress.replace("{i}", "1").replace("{n}", "1")),
    ).not.toBeInTheDocument();
    const submit = screen.getByRole("button", { name: zhCN.chat.askSubmit });
    expect(submit).toBeDisabled(); // 未作答不可提交
    await user.click(screen.getByRole("button", { name: /结算页/ }));
    expect(onAnswer).not.toHaveBeenCalled();
    expect(submit).toBeEnabled();
    await user.click(submit);
    expect(onAnswer).toHaveBeenCalledWith([{ selected: ["结算页"] }]);
  });

  it("单选可改选:后点的覆盖先点的", async () => {
    const user = userEvent.setup();
    const onAnswer = renderInteractive(ONE_Q);
    await user.click(screen.getByRole("button", { name: /结算页/ }));
    await user.click(screen.getByRole("button", { name: /商品列表/ }));
    await user.click(screen.getByRole("button", { name: zhCN.chat.askSubmit }));
    expect(onAnswer).toHaveBeenCalledWith([{ selected: ["商品列表"] }]);
  });

  it("「其他」展开自由输入,随提交作答(text 通道)", async () => {
    const user = userEvent.setup();
    const onAnswer = renderInteractive(ONE_Q);
    await user.click(screen.getByRole("button", { name: zhCN.chat.askOther }));
    await user.type(
      screen.getByRole("textbox", { name: zhCN.chat.askOtherPlaceholder }),
      "都不对,用第三个",
    );
    await user.click(screen.getByRole("button", { name: zhCN.chat.askSubmit }));
    expect(onAnswer).toHaveBeenCalledWith([
      { selected: [], text: "都不对,用第三个" },
    ]);
  });

  it("多问逐题展示:进度 1/2、答完确认才进下一题、末题提交一并回填", async () => {
    const user = userEvent.setup();
    const onAnswer = renderInteractive(TWO_Q_MULTI);
    // 仅当前题在场:第二问不渲染
    expect(screen.getByText("先做什么?")).toBeInTheDocument();
    expect(screen.queryByText("偏好哪些?")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        zhCN.chat.askProgress.replace("{i}", "1").replace("{n}", "2"),
      ),
    ).toBeInTheDocument();
    // 「下一题」按钮:当前题未答时禁用
    const next = screen.getByRole("button", { name: zhCN.chat.askNext });
    expect(next).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /^A1/ }));
    expect(next).toBeEnabled();
    await user.click(next);
    // 进入第二题:第一问退场,进度推进,按钮换回「提交」
    expect(screen.queryByText("先做什么?")).not.toBeInTheDocument();
    expect(screen.getByText("偏好哪些?")).toBeInTheDocument();
    expect(
      screen.getByText(
        zhCN.chat.askProgress.replace("{i}", "2").replace("{n}", "2"),
      ),
    ).toBeInTheDocument();
    const submit = screen.getByRole("button", { name: zhCN.chat.askSubmit });
    expect(submit).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /^X/ }));
    await user.click(screen.getByRole("button", { name: /^Y/ }));
    await user.click(submit);
    // 逐题答案一并回填,顺序对齐请求
    expect(onAnswer).toHaveBeenCalledWith([
      { selected: ["A1"] },
      { selected: ["X", "Y"] },
    ]);
  });

  it("提交后进入已提交态,不再重复作答", async () => {
    const user = userEvent.setup();
    const onAnswer = renderInteractive(ONE_Q);
    await user.click(screen.getByRole("button", { name: /结算页/ }));
    await user.click(screen.getByRole("button", { name: zhCN.chat.askSubmit }));
    expect(screen.getByText(zhCN.chat.askSubmitted)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /结算页/ }));
    expect(onAnswer).toHaveBeenCalledTimes(1);
  });

  it("超时口径随载荷展示(分钟)", () => {
    renderInteractive(ONE_Q, vi.fn(), 300_000);
    expect(
      screen.getByText(zhCN.chat.askTimeoutHint.replace("{n}", "5")),
    ).toBeInTheDocument();
  });
});

describe("AskCard 收起态(作答后/回放同款)", () => {
  it("已答默认收起:问题 + 所选摘要 chip,无选项列表与提交钮", () => {
    render(
      <AskCard questions={ONE_Q as never} interactive={false} result={answeredResult} />,
    );
    expect(screen.getByText("要操作哪个标签页?")).toBeInTheDocument();
    expect(screen.getByText("结算页")).toBeInTheDocument();
    // 收起即折叠:未选中的选项不渲染
    expect(screen.queryByText("商品列表")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: zhCN.chat.askSubmit }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /商品列表/ }),
    ).not.toBeInTheDocument();
  });

  it("展开回看全部选项:选中高亮、其余非按钮,可收起", async () => {
    const user = userEvent.setup();
    render(
      <AskCard questions={ONE_Q as never} interactive={false} result={answeredResult} />,
    );
    await user.click(screen.getByRole("button", { name: zhCN.chat.confirmExpand }));
    // 摘要 chip 与选中的选项块都展示「结算页」;高亮契约:摘要 chip 收敛为
    // 中性容器片(正文语境主题色太响),主题色只留给展开态的已选中选项行,
    // 未选项不落在高亮容器里
    const summaries = screen.getAllByText("结算页");
    expect(summaries).toHaveLength(2);
    const [chip, picked] = summaries.map((s) => s.closest("div")?.className ?? "");
    expect(chip).toContain("bg-surface-container-highest");
    expect(chip).not.toContain("bg-primary-container");
    expect(picked).toContain("bg-primary-container");
    const other = screen.getByText("商品列表");
    expect(other.closest("div")?.className).not.toContain("bg-primary-container");
    await user.click(screen.getByRole("button", { name: zhCN.chat.confirmCollapse }));
    expect(screen.queryByText("商品列表")).not.toBeInTheDocument();
  });

  it("自由文本回答:摘要直接展示文本", () => {
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
    expect(screen.queryByText("商品列表")).not.toBeInTheDocument();
  });

  it("超时未答:徽记在场,展开无高亮选项", async () => {
    const user = userEvent.setup();
    render(
      <AskCard
        questions={ONE_Q as never}
        interactive={false}
        result={JSON.stringify({ status: "unanswered", note: "..." })}
      />,
    );
    expect(screen.getByText(zhCN.chat.askUnansweredBadge)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: zhCN.chat.confirmExpand }));
    expect(
      screen.getByText("商品列表").closest("div")?.className,
    ).not.toContain("bg-primary-container");
  });

  it("等待态(result 缺席):等待徽记,不崩", () => {
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
