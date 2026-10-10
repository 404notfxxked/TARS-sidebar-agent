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

  it("大 HTML 提取失衡:正文哪怕过了壳页阈值也报可疑(淘宝案形状)", () => {
    const html =
      `<body><h1>商品</h1><p>${"内容字符".repeat(60)}</p>` +
      `<!--${"x".repeat(30_000)}--></body>`;
    const doc = buildVirtualDoc(capture(html));
    expect(doc.totalChars).toBeGreaterThanOrEqual(200);
    expect(doc.htmlBytes).toBeGreaterThanOrEqual(20_000);
    expect(runPageOutline(doc).hint).toContain("可疑");
  });

  it("正文 PUA 密集:体量充足也报字体反爬可疑", () => {
    const html =
      `<body><h1>详情</h1>` +
      `<p>${"正常描述文字".repeat(40)}${"\uE0A0".repeat(8)}</p></body>`;
    const doc = buildVirtualDoc(capture(html));
    expect(doc.totalChars).toBeGreaterThanOrEqual(200);
    expect(runPageRead(doc, 0, 6000).hint).toContain("字体反爬");
  });
});

describe("单节/采样截断不再静默(REQ-P0-1)", () => {
  it("单节超 4000 上限被截:read/outline 带 sections_truncated 与 web_fetch 指引", () => {
    const html =
      `<body><h1>第一节</h1><p>${"长".repeat(6000)}</p>` +
      `<h2>第二节</h2><p>短正文</p></body>`;
    const doc = buildVirtualDoc(capture(html));
    expect(doc.truncatedSections).toBe(true);
    const read = runPageRead(doc, 0, 6000);
    expect(read.sections_truncated).toBe(true);
    expect(read.hint).toContain("web_fetch");
    const outline = runPageOutline(doc);
    expect(outline.sections_truncated).toBe(true);
    expect(outline.hint).toContain("web_fetch");
  });

  it("指引不指向 refresh:重建快照对单节上限无效,指了就是让模型空耗 turn", () => {
    const html = `<body><h1>大节</h1><p>${"长".repeat(6000)}</p></body>`;
    const doc = buildVirtualDoc(capture(html));
    expect(runPageRead(doc, 0, 6000).hint).not.toContain("refresh");
  });

  it("采样 HTML 被截(content truncated):source_truncated 透出并进指引", () => {
    // 页体量要过壳页阈值,否则壳页 hint 按优先级先出,轮不到截断指引
    const doc = buildVirtualDoc({
      ...capture(`<body><p>${"正文内容".repeat(60)}</p></body>`),
      truncated: true,
    });
    const read = runPageRead(doc, 0, 6000);
    expect(read.source_truncated).toBe(true);
    expect(read.hint).toContain("web_fetch");
    expect(runPageOutline(doc).source_truncated).toBe(true);
  });

  it("正常小节零误报:不带截断标记与 hint", () => {
    const html = `<body><h1>标题</h1><p>${"正文内容".repeat(60)}</p></body>`;
    const doc = buildVirtualDoc(capture(html));
    const read = runPageRead(doc, 0, 6000);
    expect(read.sections_truncated).toBeUndefined();
    expect(read.source_truncated).toBeUndefined();
    expect(read.hint).toBeUndefined();
    expect(runPageOutline(doc).sections_truncated).toBeUndefined();
  });

  it("管线自报 hint 优先:可疑信号与截断并存时 hint 不被截断指引顶掉", () => {
    const html =
      `<body><h1>详情</h1><p>${"正常描述文字".repeat(40)}${"\uE0A0".repeat(8)}</p>` +
      `<h2>规格</h2><p>${"长".repeat(6000)}</p></body>`;
    const doc = buildVirtualDoc(capture(html));
    expect(doc.truncatedSections).toBe(true);
    expect(runPageRead(doc, 0, 6000).hint).toContain("字体反爬");
  });
});

describe("标题层级与定位的边界(2026-09 审计)", () => {
  it("aria-level 烂值不炸整页解析:钳回 1-6 档", () => {
    // 旧实现直接 Number(aria-level) 后 "#".repeat(-1) 抛 RangeError,
    // 整页解析在同一位置反复炸死(page_read/page_find/page_outline 全废)
    const html = `<body>
      <div role="heading" aria-level="-1">负值标题</div>
      <div role="heading" aria-level="1e99">天文标题</div>
      <h3>正常标题</h3>
      <p>正文</p>
    </body>`;
    const doc = buildVirtualDoc(capture(html));
    const levels = runPageOutline(doc).items.map((i) => i.level);
    expect(levels).toEqual([2, 2, 3]); // 烂值回落默认 2,合法值照旧
    expect(doc.md).toContain("负值标题");
  });

  it("小写变长字符不使定位偏移:page_find 的 pos 仍指向 md 真身", () => {
    // İ→i̇ / ﬁ→fi 折叠后长度 +1:旧实现用 toLowerCase 建搜索基底,lower 与 md
    // 错位,首个变长字符之后的所有命中 pos 系统性偏移(读到错的正文片段)
    const html = `<body>
      <p>İstanbul ﬁnal 记录</p>
      <p>这里才是目标词</p>
    </body>`;
    const doc = buildVirtualDoc(capture(html));
    const found = runPageFind(doc, "目标词", 3);
    expect(found.total_matches).toBe(1);
    const pos = found.matches[0].pos;
    expect(doc.md.slice(pos, pos + 3)).toBe("目标词");
  });
});

describe("每节截断省略量注记", () => {
  it("超长节末尾出现精确省略量注记,正常节不受影响", () => {
    // 第一节 4800 字符 > 每节帽 4000:截断保 4000(无换行,不回吸),
    // 省略量 = 4800 - 4000 = 800;第二节短,无注记
    const html = `<body><article>
      <h2>第一节</h2><p>${"山".repeat(4800)}</p>
      <h2>第二节</h2><p>短内容,不足以触发截断。</p>
    </article></body>`;
    const doc = buildVirtualDoc(capture(html));
    const cut = doc.md.indexOf("第二节");
    const s1 = doc.md.slice(0, cut);
    const m = /\[本节超长,已省略 (\d+) 字\]/.exec(s1);
    expect(m).not.toBeNull();
    expect(Number(m?.[1])).toBe(800);
    // 保留内容(去注记)不越帽(truncateMarkdown 构造保证 ≤ maxChars;
    // 切片含标题行与 unit 间换行,给小容差)
    const kept = s1.replace(/\n?\[本节超长,已省略 \d+ 字\]/, "");
    expect(kept.length).toBeLessThanOrEqual(4000 + 20);
    const s2 = doc.md.slice(cut);
    expect(s2).not.toContain("本节超长");
  });

  it("preamble(首标题前内容)超长同样带注记", () => {
    const html = `<body><article>
      <p>${"前言".repeat(2500)}</p>
      <h2>正文</h2><p>短。</p>
    </article></body>`;
    const doc = buildVirtualDoc(capture(html));
    const m = /\[本节超长,已省略 (\d+) 字\]/.exec(doc.md);
    expect(m).not.toBeNull();
    // 5000 字符前言保 4000,省略 1000
    expect(Number(m?.[1])).toBe(1000);
  });

  it("无标题全文路径不加节级注记(全局截断已有 truncated_total)", () => {
    const html = `<body><p>${"段".repeat(5000)}</p></body>`;
    const doc = buildVirtualDoc(capture(html));
    expect(doc.md).not.toContain("本节超长");
  });
});
