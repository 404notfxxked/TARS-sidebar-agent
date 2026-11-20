// @vitest-environment jsdom
// 媒体放大查看器:图表/图片点击出面板内全屏覆盖层(侧栏不支持原生
// Fullscreen,这是「放大看」的主通道)、Esc 关闭、滚轮缩放(向光标锚定)、
// 双击复位、图片经 window.open 走新标签页出口。mermaid 与剪贴板同款以
// mock 替身注入;期望文案从 zhCN 字典键派生。

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import mermaid from "mermaid";
import { AssistantBubble, UserBubble } from "./bubbles";
import { cacheImgUrl } from "./images";
import { MediaViewer } from "./MediaViewer";
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** 打开一张已渲染的 mermaid 图的查看器 */
async function openDiagramViewer() {
  render(
    <AssistantBubble text={"```mermaid\nflowchart TD\n  A-->B\n```"} />,
  );
  await waitFor(() => {
    expect(document.querySelector(".diagram-body svg")).not.toBeNull();
  });
  fireEvent.click(document.querySelector(".diagram-body") as HTMLElement);
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
}

describe("媒体放大查看器", () => {
  it("图表点击出覆盖层,Esc 关闭", async () => {
    await openDiagramViewer();
    expect(
      within(screen.getByRole("dialog")).getByRole("img"),
    ).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("滚轮缩放改变变换,双击复位", async () => {
    await openDiagramViewer();
    const stage = document.querySelector(
      ".media-stage",
    ) as HTMLElement;
    const transform = () => stage.style.transform;
    fireEvent(
      stage.parentElement as HTMLElement,
      new WheelEvent("wheel", {
        deltaY: -120,
        clientX: 60,
        clientY: 60,
        bubbles: true,
        cancelable: true,
      }),
    );
    await waitFor(() => {
      expect(transform()).toContain("scale(1.25)");
    });
    fireEvent.dblClick(stage.parentElement as HTMLElement);
    await waitFor(() => {
      expect(transform()).toContain("scale(1)");
    });
  });

  it("聊天图片点击进查看器,新标签页出口走 window.open", async () => {
    cacheImgUrl("img-vt", "blob:mock-url");
    render(
      <UserBubble
        text="配图"
        images={[{ id: "img-vt", mime: "image/png", w: 800, h: 600 }]}
      />,
    );
    const link = document.querySelector(
      'a[href="blob:mock-url"]',
    ) as HTMLAnchorElement;
    expect(link).not.toBeNull();
    fireEvent.click(link);
    const dlg = screen.getByRole("dialog");
    expect(within(dlg).getByRole("img")).toHaveAttribute(
      "src",
      "blob:mock-url",
    );
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    fireEvent.click(
      within(dlg).getByRole("button", { name: zhCN.chat.media.openTab }),
    );
    expect(openSpy).toHaveBeenCalledWith("blob:mock-url", "_blank", "noreferrer");
  });

  it("图表的新标签页是 HTML 包装文档(裸 SVG 会因未闭合标签被 XML 解析拒收)", async () => {
    await openDiagramViewer();
    const dlg = screen.getByRole("dialog");
    const captured: { b: Blob | null } = { b: null };
    Object.defineProperty(URL, "createObjectURL", {
      value: (b: Blob) => {
        captured.b = b;
        return "blob:svg-mock";
      },
      configurable: true,
    });
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    fireEvent.click(
      within(dlg).getByRole("button", { name: zhCN.chat.media.openTab }),
    );
    expect(openSpy).toHaveBeenCalledWith("blob:svg-mock", "_blank", "noreferrer");
    // 类型必须是 text/html:mermaid htmlLabels 的未闭合 <br> 只在 HTML 解析器下合法
    expect(captured.b).not.toBeNull();
    expect(captured.b!.type).toBe("text/html");
    const text = await captured.b!.text();
    expect(text.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(text).toContain("<svg");
    expect(text).toContain("</html>");
  });

  it("底部步进缩放胶囊:±25 个百分点、下限 50%、点百分数复位", async () => {
    await openDiagramViewer();
    const dlg = screen.getByRole("dialog");
    const transform = () =>
      (document.querySelector(".media-stage") as HTMLElement).style.transform;
    const minus = within(dlg).getByRole("button", {
      name: zhCN.chat.media.zoomOut,
    });
    const plus = within(dlg).getByRole("button", {
      name: zhCN.chat.media.zoomIn,
    });
    fireEvent.click(minus);
    await waitFor(() => {
      expect(transform()).toContain("scale(0.75)");
    });
    expect(within(dlg).getByText("75%")).toBeInTheDocument();
    fireEvent.click(minus);
    await waitFor(() => {
      expect(transform()).toContain("scale(0.5)");
    });
    fireEvent.click(plus);
    await waitFor(() => {
      expect(transform()).toContain("scale(0.75)");
    });
    fireEvent.click(within(dlg).getByTitle(zhCN.chat.media.reset));
    await waitFor(() => {
      expect(transform()).toContain("scale(1)");
    });
    expect(within(dlg).getByText("100%")).toBeInTheDocument();
  });

  it("保存到本地:SVG 经 XML 序列化,未闭合标签自闭合且可被 XML 解析", async () => {
    renderMock.mockImplementationOnce(
      async () => ({
        // 夹具带空 xmlns="":序列化补正规 xmlns 后同名并存即非法 XML,
        // 必须先被清掉(与未闭合 <br> 同属「存出的文件要能打开」)
        svg: `<svg viewBox="0 0 10 10"><foreignObject><div xmlns=""><p>a<br>b</p></div></foreignObject></svg>`,
        diagramType: "flowchart",
      }),
    );
    // 源码必须独有:与其它用例同串会命中模块级渲染缓存,毒株 mock 不被消费
    render(
      <AssistantBubble text={"```mermaid\nflowchart TD\n  S-->T\n```"} />,
    );
    await waitFor(() => {
      expect(document.querySelector(".diagram-body svg")).not.toBeNull();
    });
    fireEvent.click(document.querySelector(".diagram-btn") as HTMLElement);
    const dlg = await screen.findByRole("dialog");
    const captured: { b: Blob | null } = { b: null };
    Object.defineProperty(URL, "createObjectURL", {
      value: (b: Blob) => {
        captured.b = b;
        return "blob:save-mock";
      },
      configurable: true,
    });
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    fireEvent.click(
      within(dlg).getByRole("button", { name: zhCN.chat.media.save }),
    );
    expect(clickSpy).toHaveBeenCalled();
    expect(captured.b).not.toBeNull();
    expect(captured.b!.type).toBe("image/svg+xml");
    const xml = await captured.b!.text();
    // 未闭合 <br> 必须已自闭合(序列化会补 xmlns,断言只看自闭合形态),
    // 且整体能过 XML 解析(裸存会重演报错页事故)
    expect(/<br\b[^>]*\/>/.test(xml)).toBe(true);
    const parsed = new DOMParser().parseFromString(xml, "image/svg+xml");
    expect(parsed.querySelector("parsererror")).toBeNull();
  });

  it("data: URL 图片(图表快照)的新标签页出口:先转 objectURL 再开(Chrome 拦 data: 顶层导航)", async () => {
    render(
      <MediaViewer
        content={{ kind: "image", url: "data:image/png;base64,QUJD", alt: "x" }}
        onClose={() => {}}
      />,
    );
    const dlg = screen.getByRole("dialog");
    let blobArg: Blob | null = null;
    Object.defineProperty(URL, "createObjectURL", {
      value: (b: Blob) => {
        blobArg = b;
        return "blob:from-data";
      },
      configurable: true,
    });
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    fireEvent.click(
      within(dlg).getByRole("button", { name: zhCN.chat.media.openTab }),
    );
    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith(
        "blob:from-data",
        "_blank",
        "noreferrer",
      );
    });
    expect(blobArg).not.toBeNull();
    expect(blobArg!.type).toBe("image/png");
  });
});
