// diagramLint 的纯逻辑单测:提取器只认 mermaid/echarts 白名单(嵌套围栏
// 是外层块的内容,不误吞;未闭合围栏按剩余文本成块,与渲染端行为同向);
// validateDiagrams 全通过返回 null、坏块回喂 note 以 SYSTEM_NOTE_PREFIX
// 开头(压缩轮切分契约)且逐块列语言与错误。callOffscreenParser 整体
// mock:offscreen 链路归 e2e(verify-diagrams)。

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../shared/docBridge", () => ({
  callOffscreenParser: vi.fn(),
  ensureOffscreenDocument: vi.fn(),
}));

import { callOffscreenParser } from "../../shared/docBridge";
import { SYSTEM_NOTE_PREFIX } from "./compaction";
import { extractDiagramBlocks, validateDiagrams } from "./diagramLint";

const parserMock = vi.mocked(callOffscreenParser);

describe("extractDiagramBlocks", () => {
  it("多块提取:mermaid 与 echarts 各取源码,块外文本不掺入", () => {
    const md = [
      "架构如下:",
      "",
      "```mermaid",
      "flowchart TD",
      "  A --> B",
      "```",
      "",
      "数据如下:",
      "",
      "```echarts",
      '{"series":[]}',
      "```",
    ].join("\n");
    expect(extractDiagramBlocks(md)).toEqual([
      { lang: "mermaid", source: "flowchart TD\n  A --> B" },
      { lang: "echarts", source: '{"series":[]}' },
    ]);
  });

  it("非图表语言忽略:js 与无语言围栏都不成块", () => {
    const md = [
      "```js",
      "const a = 1;",
      "```",
      "",
      "```",
      "plain text",
      "```",
    ].join("\n");
    expect(extractDiagramBlocks(md)).toEqual([]);
  });

  it("嵌套围栏:四反引号块内的三反引号 mermaid 是外层内容,不误吞", () => {
    const md = [
      "````markdown",
      "看这个例子:",
      "",
      "```mermaid",
      "flowchart TD",
      "  A --> B",
      "```",
      "````",
    ].join("\n");
    expect(extractDiagramBlocks(md)).toEqual([]);
  });

  it("未闭合围栏:按剩余文本成块(与渲染端把残段当代码同向)", () => {
    const md = ["```mermaid", "flowchart TD", "  A --> B"].join("\n");
    expect(extractDiagramBlocks(md)).toEqual([
      { lang: "mermaid", source: "flowchart TD\n  A --> B" },
    ]);
  });
});

describe("validateDiagrams", () => {
  beforeEach(() => {
    parserMock.mockReset();
  });

  it("全通过(echarts 合法 JSON + mermaid 桩 ok)→ null", async () => {
    parserMock.mockResolvedValue({ ok: true });
    const md = [
      "```mermaid",
      "flowchart TD",
      "  A --> B",
      "```",
      "",
      "```echarts",
      '{"series":[]}',
      "```",
    ].join("\n");
    expect(await validateDiagrams(md)).toBeNull();
    expect(parserMock).toHaveBeenCalledTimes(1);
    expect(parserMock).toHaveBeenCalledWith(
      "diagram_validate",
      { source: "flowchart TD\n  A --> B" },
      15_000,
    );
  });

  it("echarts 坏 JSON → note 以 SYSTEM_NOTE_PREFIX 开头且点名语言", async () => {
    const note = await validateDiagrams(
      ["```echarts", '{"series":[}', "```"].join("\n"),
    );
    expect(note).not.toBeNull();
    expect(note!.startsWith(SYSTEM_NOTE_PREFIX)).toBe(true);
    expect(note).toContain("echarts");
  });

  it("mermaid 坏块(校验器 {ok:false,error})→ note 列语言与错误摘要 + 重发指示", async () => {
    parserMock.mockResolvedValue({
      ok: false,
      error: "Parse error on line 2",
    });
    const note = await validateDiagrams(
      ["```mermaid", "flowchat TD", "  A --> B", "```"].join("\n"),
    );
    expect(note).not.toBeNull();
    expect(note!.startsWith(SYSTEM_NOTE_PREFIX)).toBe(true);
    expect(note).toContain("mermaid");
    expect(note).toContain("Parse error on line 2");
    expect(note).toContain("```mermaid");
    expect(note!.toLowerCase()).toContain("resend");
  });

  it("校验基础设施不可用(parser reject)→ 该 mermaid 块按无法判定跳过,不算坏块", async () => {
    parserMock.mockRejectedValue(new Error("offscreen request timeout"));
    const note = await validateDiagrams(
      ["```mermaid", "flowchart TD", "  A --> B", "```"].join("\n"),
    );
    expect(note).toBeNull();
  });

  it("note 有显式长度上限:超长错误被截,多块列出有上限并注明剩余", async () => {
    const blocks = Array.from({ length: 10 }, (_, i) =>
      ["```echarts", `{"bad-${i}":`, "```"].join("\n"),
    );
    const note = await validateDiagrams(blocks.join("\n\n"));
    expect(note).not.toBeNull();
    expect(note!.length).toBeLessThanOrEqual(2000);
    expect(note).toContain("and 2 more");
  });
});
