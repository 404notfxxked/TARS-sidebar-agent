// @vitest-environment jsdom
// parseSearchResults 单测:四引擎选择器定位 + URL 还原(DDG/Bing 跳转包装)、
// 去重、limit 裁剪与字段清洗。jsdom 提供 DOMParser(默认 node 环境没有)。

import { describe, expect, it } from "vitest";
import { parseSearchResults } from "./searchParse";

const DDG_HTML = `
<div class="result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=x">标题 A</a>
  <a class="result__snippet" href="#">摘要 A</a>
</div>
<div class="result">
  <a class="result__a" href="https://example.com/b">标题 B</a>
  <a class="result__snippet" href="#">摘要 B</a>
</div>`;

const BING_HTML = `
<li class="b_algo">
  <h2><a href="https://www.bing.com/ck/a?!&u=a1aHR0cHM6Ly9iaW5nLmNvbQ%3D%3D&ntb=1">包装标题</a></h2>
  <p class="b_lineclamp3">包装摘要</p>
</li>
<li class="b_algo">
  <h2><a href="https://direct.example/d">直链标题</a></h2>
  <p class="b_caption"><p>直链摘要</p></p>
</li>`;

const GOOGLE_HTML = `
<div id="rso">
  <div class="g">
    <a href="https://g.example/x"><h3>谷歌标题</h3></a>
    <span class="VwiC3b">谷歌摘要</span>
  </div>
  <div class="g">
    <a href="/search?q=internal"><h3>内部跳转</h3></a>
  </div>
</div>`;

const BAIDU_HTML = `
<div id="content_left">
  <div class="result c-container">
    <h3><a href="http://www.baidu.com/link?url=enc-1">百度标题</a></h3>
    <span class="content-right">百度摘要</span>
  </div>
</div>`;

const BASE = "https://duckduckgo.com/html/?q=tars";

describe("parseSearchResults", () => {
  it("ddg:跳转包装还原为真实 URL,直链原样", () => {
    const out = parseSearchResults("ddg", DDG_HTML, BASE, 10);
    expect(out).toEqual([
      { title: "标题 A", url: "https://example.com/a", snippet: "摘要 A" },
      { title: "标题 B", url: "https://example.com/b", snippet: "摘要 B" },
    ]);
  });

  it("bing:/ck/a 点击包装按 u=a1<base64url> 还原;非包装直链不动", () => {
    const out = parseSearchResults("bing", BING_HTML, "https://www.bing.com/search?q=x", 10);
    expect(out.map((r) => r.url)).toEqual(["https://bing.com", "https://direct.example/d"]);
    expect(out[0]?.title).toBe("包装标题");
  });

  it("google:非 http(s) 的内部跳转条目直接丢弃", () => {
    const out = parseSearchResults("google", GOOGLE_HTML, "https://www.google.com/search?q=x", 10);
    expect(out).toEqual([
      { title: "谷歌标题", url: "https://g.example/x", snippet: "谷歌摘要" },
    ]);
  });

  it("baidu:/link?url= 加密跳转无法本地还原,保留包装 URL 的绝对形态", () => {
    const out = parseSearchResults("baidu", BAIDU_HTML, "https://www.baidu.com/s?wd=x", 10);
    expect(out).toEqual([
      {
        title: "百度标题",
        url: "http://www.baidu.com/link?url=enc-1",
        snippet: "百度摘要",
      },
    ]);
  });

  it("重复 URL 去重(保留首条)", () => {
    const html = `<div class="result">
      <a class="result__a" href="https://example.com/a">首条</a>
    </div>
    <div class="result">
      <a class="result__a" href="https://example.com/a">重复</a>
    </div>`;
    const out = parseSearchResults("ddg", html, BASE, 10);
    expect(out).toHaveLength(1);
    expect(out[0]?.title).toBe("首条");
  });

  it("limit 裁剪:最多保留 limit 条;未知引擎抛错", () => {
    const out = parseSearchResults("ddg", DDG_HTML, BASE, 1);
    expect(out).toHaveLength(1);
    expect(() => parseSearchResults("ask", DDG_HTML, BASE, 10)).toThrow(
      /unknown search parser/,
    );
  });

  it("空 HTML:返回空数组不抛错", () => {
    expect(parseSearchResults("ddg", "<html><body></body></html>", BASE, 10)).toEqual([]);
  });
});
