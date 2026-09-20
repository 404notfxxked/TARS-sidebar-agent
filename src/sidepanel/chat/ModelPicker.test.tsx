// @vitest-environment jsdom
// ModelPicker 组件单测:开合/键盘导航(↑↓ 环绕、Home/End、Enter/Tab 选中、
// Esc 关闭)/选中标记/引用失效回退。键盘路径 e2e 已有(probe-focus),这里
// 用毫秒级单测把映射规则钉死。

import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { zhCN } from "../../shared/i18n/locales/zh-CN";
import type { ProviderEntry } from "../../shared/configStore";
import ModelPicker from "./ModelPicker";

// vitest 未开 globals:RTL 的自动 cleanup 不生效,手动清防渲染泄漏
afterEach(cleanup);

beforeAll(() => {
  // jsdom 没有 scrollIntoView(高亮项滚可见),桩掉
  Element.prototype.scrollIntoView = vi.fn();
});

const providers: ProviderEntry[] = [
  {
    id: "p1",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "k",
    models: [
      { id: "m1", alias: "深度思索" },
      { id: "m2" },
    ],
  },
  {
    id: "p2",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "k",
    models: [{ id: "m3" }],
  },
];

/** 以当前引用 p1/m2 渲染并返回 onPick 桩;用例自行点开弹层 */
function setup(modelProvider = "p1", modelId = "m2") {
  const onPick = vi.fn();
  const user = userEvent.setup();
  render(
    <ModelPicker
      providers={providers}
      modelProvider={modelProvider}
      modelId={modelId}
      onPick={onPick}
    />,
  );
  return { onPick, user };
}

const trigger = () =>
  screen.getByRole("button", { name: zhCN.chat.selectModel });
const listbox = () => screen.getByRole("listbox");
const activeId = () => listbox().getAttribute("aria-activedescendant");

describe("ModelPicker 模型选择器", () => {
  it("pill 显示当前模型 alias,点击开合(aria-expanded 跟随)", async () => {
    const { user } = setup("p1", "m1");
    expect(trigger()).toHaveTextContent("深度思索");
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    await user.click(trigger());
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    expect(listbox()).toBeInTheDocument();
  });

  it("打开时高亮落在当前选中模型,选中项带 ✓ 标记", async () => {
    const { user } = setup();
    await user.click(trigger());
    expect(activeId()).toBe("mp-opt-1"); // 扁平序:p1m1=0,p1m2=1
    expect(screen.getByRole("option", { name: "m2 ✓" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("↑↓ 在扁平序内环绕,Home/End 跳两端", async () => {
    const { user } = setup();
    await user.click(trigger());
    await user.keyboard("{ArrowDown}");
    expect(activeId()).toBe("mp-opt-2");
    await user.keyboard("{ArrowDown}");
    expect(activeId()).toBe("mp-opt-0"); // 环绕回首
    await user.keyboard("{End}");
    expect(activeId()).toBe("mp-opt-2");
    await user.keyboard("{Home}");
    expect(activeId()).toBe("mp-opt-0");
  });

  it("Enter 选中高亮项:onPick(供应商, 模型) 且弹层关闭", async () => {
    const { onPick, user } = setup();
    await user.click(trigger());
    await user.keyboard("{ArrowDown}"); // 1 → 2(p2/m3)
    await user.keyboard("{Enter}");
    expect(onPick).toHaveBeenCalledWith("p2", "m3");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("Esc 关闭且不触发 onPick;点击选项直接选中", async () => {
    const { onPick, user } = setup("p1", "m1");
    await user.click(trigger());
    await user.keyboard("{Escape}");
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    await user.click(trigger());
    await user.click(screen.getByRole("option", { name: "深度思索 ✓" }));
    expect(onPick).toHaveBeenCalledWith("p1", "m1");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("modelProvider 引用失效时回退第一供应商(过渡态不空弹)", async () => {
    const { user } = setup("gone", "m9");
    // 当前模型查不到:pill 兜底显示原始 modelId(供应商回退到 providers[0])
    expect(trigger()).toHaveTextContent("m9");
    await user.click(trigger());
    expect(screen.getByRole("option", { name: "深度思索" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    expect(activeId()).toBe("mp-opt-0"); // 引用失效落首项
  });
});
