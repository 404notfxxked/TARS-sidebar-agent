// @vitest-environment jsdom
// 气泡复制回归:用户气泡此前没有复制动作行,消息只能手选复制;同时
// 复制到剪贴板的文本原样携带模型原文尾部的换行 —— markdown 渲染下
// 不可见,粘贴端却多出空行。剪贴板写入统一走 useCopyFlash,尾部空白
// 在该钩子收口,assistant/用户/代码块三条复制路径同享。

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { AssistantBubble, UserBubble } from "./bubbles";
import { cacheImgUrl, failPendingImages } from "./images";
import { zhCN } from "../../shared/i18n/locales/zh-CN";

// jsdom 没有剪贴板实现:挂最小镇桩,捕获写入内容供断言。
// 必须在 userEvent.setup() 之后挂 —— user-event 自带剪贴板桩会顶掉
// 模块级挂载,click 触发的写入就落到它的内部桩上,断言扑空
const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
const stubClipboard = () =>
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });

afterEach(cleanup);

describe("气泡复制", () => {
  it("用户气泡带复制按钮:点击把消息文本写入剪贴板", async () => {
    const user = userEvent.setup();
    stubClipboard();
    render(<UserBubble text="帮我查下今天的天气" />);

    const btn = screen.getByRole("button", { name: zhCN.common.copy });
    await user.click(btn);
    expect(writeText).toHaveBeenCalledWith("帮我查下今天的天气");
  });

  it("复制不携带尾部换行:模型原文的尾部空白在写入前截掉", async () => {
    const user = userEvent.setup();
    stubClipboard();
    render(<AssistantBubble text={"答案正文\n\n\n"} actions="copy" />);

    await user.click(screen.getByRole("button", { name: zhCN.common.copy }));
    expect(writeText).toHaveBeenCalledWith("答案正文");
  });
});

// tars-img 引用渲染:隐私红线 —— markdown 里任何非 tars-img: 前缀的图片
// 引用(https 外链等)一律不得渲染成 <img>,面板不因模型随手写的外链向
// 第三方图床发请求;只有 tars-img: 引用经 images.ts 缓存取本地字节。
describe("tars-img 引用渲染", () => {
  it("https 远程图一律不渲染(隐私边界)", () => {
    render(<AssistantBubble text="![x](https://a/b.png)" />);
    expect(document.querySelector("img")).toBeNull();
  });

  it("tars-img 引用从缓存渲染成图", () => {
    cacheImgUrl("img1", "blob:x");
    render(<AssistantBubble text="![x](tars-img:img1)" />);
    expect(document.querySelector("img[src='blob:x']")).not.toBeNull();
  });

  it("相邻图片引用成单个横滑行;图 + 文混排保持普通段落且不丢内容", () => {
    cacheImgUrl("g1", "blob:g1");
    cacheImgUrl("g2", "blob:g2");
    render(
      <AssistantBubble text={"![a](tars-img:g1)\n![b](tars-img:g2)"} />,
    );
    const galleries = document.querySelectorAll(".media-gallery");
    expect(galleries).toHaveLength(1);
    expect(galleries[0].querySelectorAll("img")).toHaveLength(2);

    cleanup();
    render(
      <AssistantBubble text={"![a](tars-img:g1)\n附一段说明文字"} />,
    );
    expect(document.querySelectorAll(".media-gallery")).toHaveLength(0);
    const paras = [...document.querySelectorAll("p")];
    expect(paras.some((p) => p.textContent?.includes("附一段说明文字"))).toBe(
      true,
    );
  });

  it("字节取不到 → 失效占位", async () => {
    render(<AssistantBubble text="![x](tars-img:gone)" />);
    failPendingImages();
    expect(await screen.findByText(zhCN.chat.imageExpired)).not.toBeNull();
  });
});
