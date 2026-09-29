// @vitest-environment jsdom
// Segmented 组件单测:radiogroup 键盘契约(方向键移动即选中 + roving
// tabindex,焦点跟到新选中段)与 aria 语义。此前无组件级覆盖。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import Segmented from "./Segmented";

// vitest 未开 globals:RTL 的自动 cleanup 不生效,手动清防渲染泄漏
afterEach(cleanup);

type Lvl = "low" | "mid" | "high";

const OPTIONS: { value: Lvl; label: string }[] = [
  { value: "low", label: "甲" },
  { value: "mid", label: "乙" },
  { value: "high", label: "丙" },
];

function setup(value: Lvl, onChange = vi.fn()) {
  const utils = render(
    <Segmented<Lvl>
      value={value}
      options={OPTIONS}
      onChange={onChange}
      ariaLabel="档位"
    />,
  );
  return { onChange, ...utils };
}

const press = (container: HTMLElement, key: string) =>
  fireEvent.keyDown(within(container).getByRole("radiogroup"), { key });

describe("Segmented radiogroup 契约", () => {
  it("仅选中段可 Tab 停留(roving tabindex),其余 tabIndex=-1", () => {
    setup("mid");
    expect(screen.getByRole("radio", { name: "乙" })).toHaveProperty(
      "tabIndex",
      0,
    );
    expect(screen.getByRole("radio", { name: "甲" })).toHaveProperty(
      "tabIndex",
      -1,
    );
    expect(screen.getByRole("radio", { name: "丙" })).toHaveProperty(
      "tabIndex",
      -1,
    );
  });

  it("ArrowRight 移动即选中并聚焦,选中态与 aria-checked 跟随", () => {
    const onChange = vi.fn();
    const { container, rerender } = setup("mid", onChange);
    press(container, "ArrowRight");
    expect(onChange).toHaveBeenCalledWith("high");
    // 受控重渲染:选中移到「丙」,焦点已在处理器里同步落位
    rerender(
      <Segmented<Lvl>
        value="high"
        options={OPTIONS}
        onChange={onChange}
        ariaLabel="档位"
      />,
    );
    expect(screen.getByRole("radio", { name: "丙" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("radio", { name: "乙" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "丙" }));
    expect(screen.getByRole("radio", { name: "丙" })).toHaveProperty(
      "tabIndex",
      0,
    );
  });

  it("ArrowLeft 反向,首项循环回末项", () => {
    const onChange = vi.fn();
    const { container } = setup("low", onChange);
    press(container, "ArrowLeft");
    expect(onChange).toHaveBeenCalledWith("high");
  });

  it("ArrowUp/ArrowDown 与左右同义", () => {
    const a = vi.fn();
    const setupA = setup("low", a);
    press(setupA.container, "ArrowDown");
    expect(a).toHaveBeenCalledWith("mid");

    const b = vi.fn();
    const setupB = setup("mid", b);
    press(setupB.container, "ArrowUp");
    expect(b).toHaveBeenCalledWith("low");
  });

  it("无关按键不拦截不选中", () => {
    const onChange = vi.fn();
    const { container } = setup("mid", onChange);
    press(container, "Enter");
    press(container, "a");
    expect(onChange).not.toHaveBeenCalled();
  });
});
