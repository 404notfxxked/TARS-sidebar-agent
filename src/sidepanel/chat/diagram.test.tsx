// @vitest-environment jsdom
// mermaid 图表块渲染:语言分派(mermaid 块进图表管线而非普通代码块)、
// 坏源码回退源码态并带失败注记、按 (主题, 源码) 缓存同图只渲一次、
// data-theme 翻转换主题重渲。mermaid 库以 mock 替身注入(jsdom 跑不了
// 真渲染);期望文案从 zhCN 字典键派生。

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import mermaid from "mermaid";
import { AssistantBubble } from "./bubbles";
import { zhCN } from "../../shared/i18n/locales/zh-CN";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async (_id: string, code: string) => ({
      svg: `<svg data-diagram>${code}</svg>`,
    })),
  },
}));
const renderMock = vi.mocked(mermaid.render);
const initializeMock = vi.mocked(mermaid.initialize);

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
  renderMock.mockClear();
  initializeMock.mockClear();
});

describe("mermaid 图表块", () => {
  it("走图表管线:渲出图体而非普通代码块,源码原样交给 mermaid", async () => {
    render(
      <AssistantBubble text={"前言\n\n```mermaid\nflowchart TD\n  A-->B\n```"} />,
    );
    await waitFor(() => {
      expect(document.querySelector(".diagram-body svg")).not.toBeNull();
    });
    expect(renderMock).toHaveBeenCalledWith(
      expect.any(String),
      "flowchart TD\n  A-->B\n",
    );
  });

  it("坏源码回退:代码块仍在、源码可见,静置后出注记", async () => {
    renderMock.mockRejectedValueOnce(new Error("parse error"));
    render(
      <AssistantBubble text={"```mermaid\nsequenceDiagram\n  A->>B: hi\n```"} />,
    );
    await waitFor(
      () => {
        expect(screen.getByText(zhCN.chat.diagram.renderFailed)).toBeInTheDocument();
      },
      { timeout: 2500 },
    );
    expect(screen.getByText(/A->>B: hi/)).toBeInTheDocument();
  });

  it("行内 max-width 被剥除:宽图不会被钉死尺寸(查看器塌 0×0 的回归)", async () => {
    renderMock.mockImplementationOnce(
      async () => ({
        svg: `<svg width="100%" height="550" style="max-width: 2372px;" viewBox="0 0 2372 550"><g/></svg>`,
        diagramType: "flowchart",
      }),
    );
    render(<AssistantBubble text={"```mermaid\nflowchart LR\n  A-->B\n```"} />);
    await waitFor(() => {
      expect(document.querySelector(".diagram-body svg")).not.toBeNull();
    });
    const svg = document.querySelector(".diagram-body svg") as SVGSVGElement;
    expect(svg.getAttribute("style")).toBeNull();
    expect(svg.getAttribute("width")).toBe("100%");
    expect(svg.getAttribute("height")).toBeNull();
  });

  it("同源码命中缓存:两处同图只渲一次", async () => {
    const md = "```mermaid\nflowchart LR\n  X-->Y\n```";
    const { unmount } = render(<AssistantBubble text={md} />);
    await waitFor(() => {
      expect(document.querySelector(".diagram-body svg")).not.toBeNull();
    });
    unmount();
    render(<AssistantBubble text={md} />);
    await waitFor(() => {
      expect(document.querySelectorAll(".diagram-body svg")).toHaveLength(1);
    });
    expect(renderMock).toHaveBeenCalledTimes(1);
  });

  it("主题翻转换主题重渲", async () => {
    document.documentElement.dataset.theme = "dark";
    render(
      <AssistantBubble text={"```mermaid\nstateDiagram-v2\n  s1 --> s2\n```"} />,
    );
    await waitFor(() => {
      expect(initializeMock).toHaveBeenCalledWith(
        expect.objectContaining({ theme: "dark" }),
      );
    });
    document.documentElement.dataset.theme = "light";
    await waitFor(() => {
      expect(initializeMock).toHaveBeenCalledWith(
        expect.objectContaining({ theme: "default" }),
      );
    });
  });
});
