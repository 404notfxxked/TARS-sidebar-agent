// @vitest-environment jsdom
// 过程卡「过程文案」行(TextRow)的标签位:直接放正文首行,不再有类别词
// (2026-09-22 定调:同一段文字在流式期是无标签的 assistant 气泡,折进过程卡后
// 不该改名成「过程文案」;类别词在多个文本段时只是重复噪音),并剥掉行首
// markdown 标记(粗体/标题/引用/列表点/围栏),避免行首出现 `**` 这类噪音。
// 断言只认「行首按钮的可访问名」—— 不引用任何文案键,也就不存在文案漂移。

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ReplayProcessCard } from "./trace";
import type { ProcessItem } from "../../shared/messages";

// vitest 未开 globals:RTL 的自动 cleanup 不生效,手动清防渲染泄漏
afterEach(cleanup);

/** 该文本行是否以「行首按钮」形态存在:可访问名 = 标签位文本(chevron 是装饰) */
const hasRowNamed = (name: string) =>
  screen.queryAllByRole("button").some((b) => b.textContent?.trim() === name);

const renderCard = (items: ProcessItem[]) => render(<ReplayProcessCard items={items} />);

describe("过程卡文本行的标签位", () => {
  it("标签位即正文首行,且剥掉行首粗体标记(不再有「过程文案」前缀)", () => {
    renderCard([
      {
        kind: "text",
        text: "**Z.ai Built-in Tool: web_search_prime**\n\n**Input:**\nq1\n**Output:**\n...",
      },
    ]);
    expect(hasRowNamed("Z.ai Built-in Tool: web_search_prime")).toBe(true);
  });

  it("行首是标题/引用/列表点/围栏时同样剥净,只留正文", () => {
    renderCard([
      { kind: "text", text: "## 先看看页面结构\n后续内容" },
      { kind: "text", text: "> 引用起头的说明\n后续内容" },
      { kind: "text", text: "- 列表起头的说明\n后续内容" },
      { kind: "text", text: "```json\n{\"a\":1}\n```" },
    ]);
    expect(hasRowNamed("先看看页面结构")).toBe(true);
    expect(hasRowNamed("引用起头的说明")).toBe(true);
    expect(hasRowNamed("列表起头的说明")).toBe(true);
    // 纯围栏行剥完为空 → 回退原文,不出现空标签位
    expect(hasRowNamed("```json")).toBe(true);
  });

  it("剥标记不吞正文:行内成对强调只去标记字符", () => {
    renderCard([{ kind: "text", text: "**重点:先读设置页** 然后再动手" }]);
    expect(hasRowNamed("重点:先读设置页 然后再动手")).toBe(true);
  });
});
