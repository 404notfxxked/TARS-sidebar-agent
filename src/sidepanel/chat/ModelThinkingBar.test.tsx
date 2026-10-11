// @vitest-environment jsdom
// ModelThinkingBar 折叠契约:默认收起(仅摘要栏)、点开展开模型/思考两行、
// 选中即收起、无思考档位时思考行不出现、无可用模型整区不渲染。
// 弹层内部交互(键盘/点外关闭)由各自 picker 的单测钉死,此处不重复。

import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { zhCN } from "../../shared/i18n/locales/zh-CN";
import type { ProviderEntry } from "../../shared/configStore";
import ModelThinkingBar from "./ModelThinkingBar";

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
    baseUrl: "https://api.deepseek.com/v1", // i18n-ok:供应商 fixture wire 端点,非 UI 断言
    apiKey: "k",
    models: [
      { id: "m1", alias: "深度思索" },
      { id: "m2" },
    ],
  },
];

/** 以当前引用 p1/m1 渲染并返回 onPick 桩;摘要栏可按模型名定位 */
function setup(over: Partial<Parameters<typeof ModelThinkingBar>[0]> = {}) {
  const onPickModel = vi.fn();
  const onPickThinking = vi.fn();
  const user = userEvent.setup();
  render(
    <ModelThinkingBar
      providers={providers}
      modelProvider="p1"
      modelId="m1"
      onPickModel={onPickModel}
      showThinking
      thinkingOptions={["off", "low", "high"]}
      thinkingDefault="medium"
      onPickThinking={onPickThinking}
      {...over}
    />,
  );
  return { onPickModel, onPickThinking, user };
}

const bar = () =>
  screen.getByRole("button", { name: zhCN.chat.modelThinkingAria });
const modelRow = () =>
  screen.queryByRole("button", { name: zhCN.chat.selectModel });
const thinkingRow = () =>
  screen.queryByRole("button", { name: zhCN.chat.thinkingLevel });

describe("ModelThinkingBar 折叠选择区", () => {
  it("默认收起:仅摘要栏;点开展开模型/思考两行,档位显示解析后的默认档", async () => {
    const { user } = setup();
    expect(modelRow()).not.toBeInTheDocument();
    expect(thinkingRow()).not.toBeInTheDocument();
    expect(bar()).toHaveTextContent("深度思索");
    await user.click(bar());
    expect(modelRow()).toBeInTheDocument();
    expect(thinkingRow()).toBeInTheDocument();
    // reasoningEffort 未设置 → 落 thinkingDefault(medium)
    expect(thinkingRow()).toHaveTextContent(zhCN.chat.thinkMedium);
  });

  it("选中模型即收起:onPickModel 调用且两行缩回", async () => {
    const { onPickModel, user } = setup();
    await user.click(bar());
    await user.click(
      screen.getByRole("button", { name: zhCN.chat.selectModel }),
    );
    await user.click(screen.getByRole("option", { name: "m2" }));
    expect(onPickModel).toHaveBeenCalledWith("p1", "m2");
    expect(modelRow()).not.toBeInTheDocument();
  });

  it("无思考档位(showThinking=false):展开只有模型行,摘要栏无档位", async () => {
    const { user } = setup({ showThinking: false });
    await user.click(bar());
    expect(modelRow()).toBeInTheDocument();
    expect(thinkingRow()).not.toBeInTheDocument();
  });

  it("无可用模型:整区不渲染", () => {
    setup({
      providers: [
        { id: "p1", name: "P", baseUrl: "", apiKey: "k", models: [] },
      ],
    });
    expect(
      screen.queryByRole("button", { name: zhCN.chat.modelThinkingAria }),
    ).not.toBeInTheDocument();
  });
});
