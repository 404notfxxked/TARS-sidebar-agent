// @vitest-environment jsdom
// ThinkingPicker 组件单测:pill 当前值显示、弹层选项合成、选择出口、
// 未知 token 原样显示。选项不含隐式状态——「关」与档位都是真实 wire 参数。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { zhCN } from "../../shared/i18n/locales/zh-CN";
import ThinkingPicker from "./ThinkingPicker";

// vitest 未开 globals:RTL 的自动 cleanup 不生效,手动清防渲染泄漏
afterEach(cleanup);

describe("ThinkingPicker", () => {
  const options = ["off", "low", "high", "max"];

  it("pill 显示当前档(思考 · 高)", () => {
    render(<ThinkingPicker options={options} value="high" onPick={vi.fn()} />);
    const btn = screen.getByRole("button", { name: zhCN.chat.thinkingLevel });
    expect(btn).toHaveTextContent(zhCN.chat.thinking);
    expect(btn).toHaveTextContent(zhCN.chat.thinkHigh);
  });

  it("点开弹层:全部档位按序渲染,当前档带勾", () => {
    render(<ThinkingPicker options={options} value="high" onPick={vi.fn()} />);
    fireEvent.click(
      screen.getByRole("button", { name: zhCN.chat.thinkingLevel }),
    );
    const listbox = screen.getByRole("listbox");
    const opts = [...listbox.querySelectorAll("[role='option']")];
    expect(opts.map((o) => o.textContent)).toEqual([
      zhCN.chat.thinkOff,
      zhCN.chat.thinkLow,
      `${zhCN.chat.thinkHigh} ✓`,
      zhCN.chat.thinkMax,
    ]);
  });

  it("点「关」→ onPick 收到 off,弹层关闭", () => {
    const onPick = vi.fn();
    render(<ThinkingPicker options={options} value="high" onPick={onPick} />);
    fireEvent.click(
      screen.getByRole("button", { name: zhCN.chat.thinkingLevel }),
    );
    fireEvent.click(screen.getByRole("option", { name: zhCN.chat.thinkOff }));
    expect(onPick).toHaveBeenCalledWith("off");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("点档位 → onPick 收到对应 token", () => {
    const onPick = vi.fn();
    render(<ThinkingPicker options={options} value="low" onPick={onPick} />);
    fireEvent.click(
      screen.getByRole("button", { name: zhCN.chat.thinkingLevel }),
    );
    fireEvent.click(screen.getByRole("option", { name: zhCN.chat.thinkMax }));
    expect(onPick).toHaveBeenCalledWith("max");
  });

  it("纯开关模型(off/on)按 开/关 渲染", () => {
    const onPick = vi.fn();
    render(<ThinkingPicker options={["off", "on"]} value="on" onPick={onPick} />);
    fireEvent.click(
      screen.getByRole("button", { name: zhCN.chat.thinkingLevel }),
    );
    const opts = [...screen.getByRole("listbox").querySelectorAll("[role='option']")];
    expect(opts.map((o) => o.textContent)).toEqual([
      zhCN.chat.thinkOff,
      `${zhCN.chat.thinkOn} ✓`,
    ]);
  });

  it("未知 token 原样显示(目录新增档位不崩 UI)", () => {
    render(
      <ThinkingPicker options={["turbo"]} value="turbo" onPick={vi.fn()} />,
    );
    expect(
      screen.getByRole("button", { name: zhCN.chat.thinkingLevel }),
    ).toHaveTextContent("turbo");
  });
});
