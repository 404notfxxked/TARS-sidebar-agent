// shared/skills.ts 单测:frontmatter 解析、调用 token 解析、历史投影剥离。
// 解析器是技能链路的地基(技能页保存 + SW 调用都靠它),边界钉在这里。

import { describe, expect, it } from "vitest";
import {
  parseSkillMarkdown,
  parseSkillInvocation,
  renderSkillBlock,
  renderSkillMarkdown,
  isValidSkillName,
} from "./skills";

const validDoc = [
  "---",
  "name: pdf-review",
  'description: "Review PDF forms and extract fields."',
  "metadata:",
  "  author: example-org",
  '  version: "1.0"',
  "---",
  "",
  "# Steps",
  "1. Read the form",
].join("\n");

describe("parseSkillMarkdown", () => {
  it("parses frontmatter, nested metadata and body", () => {
    const p = parseSkillMarkdown(validDoc);
    expect(p.name).toBe("pdf-review");
    expect(p.description).toBe("Review PDF forms and extract fields.");
    expect(p.body).toBe("# Steps\n1. Read the form");
  });

  it("accepts minimal frontmatter without quotes and no metadata", () => {
    const p = parseSkillMarkdown("---\nname: a1\ndescription: ok\n---\nbody");
    expect(p.name).toBe("a1");
    expect(p.description).toBe("ok");
    expect(p.body).toBe("body");
  });

  it("skips comments and blank lines", () => {
    const raw = [
      "---",
      "# a comment",
      "",
      "name: tidy",
      "description: fine",
      "---",
      "body",
    ].join("\n");
    expect(parseSkillMarkdown(raw).name).toBe("tidy");
  });

  it("parses literal block scalars (|) into multi-line description", () => {
    // humanizer 的真实形状:块标量多行 description + 块后还有顶层键
    const raw = [
      "---",
      "name: humanizer",
      "description: |",
      "  Rewrite AI-sounding text so it reads naturally.",
      "  Use when editing or reviewing prose.",
      "  Based on Wikipedia's \"Signs of AI writing.\"",
      "license: MIT",
      "metadata:",
      '  version: "2.11.2"',
      "---",
      "body here",
    ].join("\n");
    const p = parseSkillMarkdown(raw);
    expect(p.description).toBe(
      "Rewrite AI-sounding text so it reads naturally.\nUse when editing or reviewing prose.\nBased on Wikipedia's \"Signs of AI writing.\"",
    );
    expect(p.body).toBe("body here");
  });

  it("parses folded block scalars (>) with space-joined lines and blank-line breaks", () => {
    const raw = [
      "---",
      "name: folded",
      "description: >",
      "  First line continues",
      "  on this second line.",
      "",
      "  New paragraph here.",
      "---",
      "b",
    ].join("\n");
    expect(parseSkillMarkdown(raw).description).toBe(
      "First line continues on this second line.\nNew paragraph here.",
    );
  });

  it("accepts chomping indicators (|-, >-) and stops at shallower lines", () => {
    for (const marker of ["|-", ">-"]) {
      const p = parseSkillMarkdown(
        `---\nname: x\ndescription: ${marker}\n  text line\nnext: value\n---\nb`,
      );
      expect(p.description).toBe("text line");
    }
  });

  it("rejects missing frontmatter / unclosed frontmatter", () => {
    expect(() => parseSkillMarkdown("name: x\n---")).toThrow(/must start/);
    expect(() => parseSkillMarkdown("---\nname: x")).toThrow(/not closed/);
  });

  it("rejects missing name / description / empty body", () => {
    expect(() => parseSkillMarkdown("---\ndescription: d\n---\nb")).toThrow(/"name"/);
    expect(() => parseSkillMarkdown("---\nname: x\n---\nb")).toThrow(/"description"/);
    expect(() =>
      parseSkillMarkdown("---\nname: x\ndescription: d\n---\n"),
    ).toThrow(/empty/);
  });

  it("rejects invalid names", () => {
    for (const name of ["PDF", "-pdf", "pdf--x", "pdf-", "a b"]) {
      expect(() =>
        parseSkillMarkdown(`---\nname: ${name}\ndescription: d\n---\nb`),
      ).toThrow(/Invalid skill name/);
    }
  });

  it("rejects oversized description and body", () => {
    expect(() =>
      parseSkillMarkdown(
        `---\nname: x\ndescription: ${"d".repeat(1025)}\n---\nb`,
      ),
    ).toThrow(/description/);
    expect(() =>
      parseSkillMarkdown(`---\nname: x\ndescription: d\n---\n${"b".repeat(30001)}`),
    ).toThrow(/at most 30000/);
  });
});

describe("isValidSkillName", () => {
  it("accepts standard names and rejects violations", () => {
    expect(isValidSkillName("pdf-review")).toBe(true);
    expect(isValidSkillName("a")).toBe(true);
    expect(isValidSkillName("")).toBe(false);
    expect(isValidSkillName("Pdf")).toBe(false);
    expect(isValidSkillName("a--b")).toBe(false);
    expect(isValidSkillName(`${"a".repeat(65)}`)).toBe(false);
  });
});

describe("parseSkillInvocation", () => {
  it("parses token with rest / without rest", () => {
    expect(parseSkillInvocation("/pdf-review 帮我审表单")).toEqual({
      name: "pdf-review",
      rest: "帮我审表单",
    });
    expect(parseSkillInvocation("/pdf")).toEqual({ name: "pdf", rest: "" });
    expect(parseSkillInvocation("/pdf\nnext line")).toEqual({
      name: "pdf",
      rest: "next line",
    });
  });

  it("does not fire mid-text or on lookalikes", () => {
    expect(parseSkillInvocation("看看 /pdf 这个词")).toBeNull();
    expect(parseSkillInvocation("／pdf 中文全角")).toBeNull();
    expect(parseSkillInvocation("/pdf-review帮我")).toBeNull(); // 无空白分隔
    expect(parseSkillInvocation("https://x.com/a/b 2026/09/11")).toBeNull();
    expect(parseSkillInvocation("")).toBeNull();
  });

  it("keeps token case for lookup, trims rest", () => {
    expect(parseSkillInvocation("/PDF   ")).toEqual({ name: "PDF", rest: "" });
  });
});

describe("renderSkillBlock / renderSkillMarkdown", () => {
  it("renders an invocable skill block with instruction line", () => {
    const block = renderSkillBlock("pdf-review", "step one");
    expect(block).toContain('<skill name="pdf-review">');
    expect(block).toContain("explicitly invoked");
    expect(block).toContain("step one");
    expect(block.endsWith("</skill>")).toBe(true);
  });

  it("renderSkillMarkdown output re-parses to the same fields", () => {
    const raw = renderSkillMarkdown("pdf-review", 'Has "quotes" and: colons', "# Body\ntext");
    const p = parseSkillMarkdown(raw);
    expect(p.name).toBe("pdf-review");
    expect(p.description).toBe('Has "quotes" and: colons');
    expect(p.body).toBe("# Body\ntext");
  });

  it("renderSkillMarkdown round-trips a multi-line (block scalar) description", () => {
    const desc = "Line one.\nLine two with: colon and \"quotes\".";
    const p = parseSkillMarkdown(renderSkillMarkdown("multi", desc, "b"));
    expect(p.description).toBe(desc);
  });
});
