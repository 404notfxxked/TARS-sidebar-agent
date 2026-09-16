// @vitest-environment jsdom
// buildVirtualDoc 依赖 DOMParser/Range/turndown,vitest 默认 node 环境跑不了,
// 本文件单独切 jsdom;其余纯逻辑(page_read/page_find)顺带在此当集成断言用。

import { describe, expect, it } from "vitest";
import {
  buildVirtualDoc,
  runPageFind,
  runPageOutline,
  runPageRead,
  type CaptureMeta,
} from "./pipeline";

function capture(html: string, url = "https://item.example.com/1"): CaptureMeta {
  return { html, baseURI: url, url, title: "t" };
}

describe("buildVirtualDoc 分节策略", () => {
  it("无标题的 div/span 页不再丢内容(淘宝商品页价格事故回归)", () => {
    // 旧块收集模式只认 p/li 等语义标签:导航(li)和评论(p)在、
    // span 汤里的商品名/价格整体蒸发,整页只剩纯导航
    const html = `<body>
      <ul>
        <li><a href="/a">账号管理</a></li>
        <li><a href="/b">购物车</a></li>
      </ul>
      <div class="sku-panel">
        <div><span>雎安水杨酸精华</span></div>
        <div><span>¥</span><span>99.8</span></div>
      </div>
      <p>回购第二次了,还是一如既往的好用</p>
    </body>`;
    const doc = buildVirtualDoc(capture(html));
    expect(doc.headings.length).toBe(0);
    expect(doc.md).toContain("雎安水杨酸精华");
    expect(doc.md).toContain("99.8");
    expect(doc.md).toContain("回购第二次了");
    // 事故现场的第二幕:模型 page_find「价格」全页零命中
    const found = runPageFind(doc, "价格 99.8", 5);
    expect(found.total_matches).toBeGreaterThanOrEqual(1);
  });

  it("有标题页:首个标题之前的内容进前置节,位于首个标题行之前", () => {
    const html = `<body>
      <div><span>到手价 ¥199</span></div>
      <h1>商品详情</h1>
      <p>第一节正文</p>
      <h2>参数</h2>
      <p>参数正文</p>
    </body>`;
    const doc = buildVirtualDoc(capture(html));
    expect(doc.md).toContain("到手价 ¥199");
    expect(doc.md).toContain("# 商品详情");
    expect(doc.md).toContain("## 参数");
    expect(doc.md.indexOf("到手价 ¥199")).toBeLessThan(doc.md.indexOf("# 商品详情"));
  });

  it("首个标题前没有内容时不产生空前置节", () => {
    const doc = buildVirtualDoc(capture("<body><h1>标题</h1><p>正文</p></body>"));
    expect(doc.md.startsWith("# 标题")).toBe(true);
  });

  it("标题锚点偏移体系不回归:headings[0].offset 可直接作 page_read 起点", () => {
    const html = `<body>
      <div><span>前置信息</span></div>
      <h1>商品详情</h1>
      <p>第一节正文</p>
    </body>`;
    const doc = buildVirtualDoc(capture(html));
    expect(doc.headings.length).toBe(1);
    const read = runPageRead(doc, doc.headings[0].offset, 200);
    expect(read.text.startsWith("# 商品详情")).toBe(true);
  });

  it("采样根契约:main 优先于 body,根外内容不进 md", () => {
    const html = `<body>
      <div>body 杂物</div>
      <main><p>正文在 main</p></main>
    </body>`;
    const doc = buildVirtualDoc(capture(html));
    expect(doc.md).toContain("正文在 main");
    expect(doc.md).not.toContain("body 杂物");
  });

  it("剪枝先于转换:隐藏内容在无标题全文路径下也不进 md", () => {
    const html = `<body>
      <div style="display:none">秘密库存 3 件</div>
      <div aria-hidden="true">装饰文本</div>
      <p>可见正文</p>
    </body>`;
    const doc = buildVirtualDoc(capture(html));
    expect(doc.md).toContain("可见正文");
    expect(doc.md).not.toContain("秘密库存");
    expect(doc.md).not.toContain("装饰文本");
  });

  it("病态大页:md 截到 DOC_MAX_CHARS,truncatedTotal 透出到 page_outline", () => {
    const html = `<body><p>${"字".repeat(200_000)}</p></body>`;
    const doc = buildVirtualDoc(capture(html));
    expect(doc.md.length).toBeLessThanOrEqual(160_000);
    expect(doc.truncatedTotal).toBe(true);
    expect(runPageOutline(doc).truncated_total).toBe(true);
  });

  it("内容全被剪枝的空文档不炸,md 为空", () => {
    const doc = buildVirtualDoc(capture(`<body><div style="display:none">x</div></body>`));
    expect(doc.md).toBe("");
    expect(doc.totalChars).toBe(0);
  });
});

describe("空壳页 hint(管线自报,京东/淘宝壳页案)", () => {
  it("有标题但正文近零:outline 仍出条目,连同 page_read 都带逃生 hint", () => {
    const doc = buildVirtualDoc(capture(`<body><h1>登录</h1><p>请先登录后查看</p></body>`));
    expect(doc.headings.length).toBe(1);
    const outline = runPageOutline(doc);
    expect(outline.items.length).toBe(1);
    expect(outline.hint).toContain("壳页");
    const read = runPageRead(doc, 0, 6000);
    expect(read.done).toBe(true);
    expect(read.hint).toContain("壳页");
  });

  it("零标题的极小页:hint 走空壳指引而不是 page_find 定位(没有内容可定位)", () => {
    const doc = buildVirtualDoc(capture(`<body><div><span>Access Denied</span></div></body>`));
    expect(doc.headings.length).toBe(0);
    expect(doc.totalChars).toBeLessThan(200);
    expect(runPageOutline(doc).hint).toContain("壳页");
  });

  it("正文充足的有标题页:不带 hint 字段", () => {
    const html = `<body><h1>标题</h1><p>${"正文内容".repeat(60)}</p></body>`;
    const doc = buildVirtualDoc(capture(html));
    expect(doc.totalChars).toBeGreaterThanOrEqual(200);
    expect(runPageOutline(doc).hint).toBeUndefined();
    expect(runPageRead(doc, 0, 6000).hint).toBeUndefined();
  });
});
