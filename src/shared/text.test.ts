// oneLine 纯字符串操作,node 环境直接跑。

import { describe, expect, it } from "vitest";
import { oneLine } from "./text";

describe("oneLine", () => {
  it("压平空白并截断补省略号", () => {
    expect(oneLine("  a \n b  ", 10)).toBe("a b");
    expect(oneLine("abcdef", 3)).toBe("abc…");
  });

  it("截断不劈开代理对:切点落在代理对中间时回退一位(回归)", () => {
    // 😀 = U+1F600,UTF-16 占两个码元;旧实现 slice(0, max) 会把孤立高代理
    // 喂给模型(searchParse 的标题/摘要走这里,模型可见烂字符)
    const s = `${"a".repeat(9)}😀b`;
    const out = oneLine(s, 10);
    expect(out).toBe(`${"a".repeat(9)}…`);
    expect(out.includes("\uD83D")).toBe(false); // 不残留孤立高代理
  });

  it("切点完整包含代理对时不回退:省略号前是完整的 emoji", () => {
    // max=11 恰好容纳 9a + 整个代理对:末位是低代理,不是高代理,不触发回退
    const s = `${"a".repeat(9)}😀b`;
    expect(oneLine(s, 11)).toBe(`${"a".repeat(9)}😀…`);
  });
});
