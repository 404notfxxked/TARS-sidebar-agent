// 验证读页三件套真实执行链(page-tools 域;此前该链路 e2e 零覆盖,
// page_find 一次都没出现过 —— 静默截断缺陷能长期存活正因如此)
// 用法: pnpm build && node tests/verify-page-tools.mjs
//
// 场景:
//   PT1 主链路:page_outline → page_find → page_read(offset=pos) 全链路
//      (面板 → SW → offscreen 解析 → content 采样回填),断言 —— 大纲条目
//      与 offset 体系、find 命中 pos 与标题链、read 按 pos 精确续读
//   PT2 截断标记回归:单节超 4000 上限的页面 → outline/read
//      带 sections_truncated + 指引点名 web_fetch(且不指 refresh —— 重建
//      快照对单节上限无效);被裁内容确实不在快照里
//   PT3 navigate_tab 端到端:navigate(确认卡放行)→ tabs.onUpdated 快照自动
//      失效 → page_find 不带 refresh 直接命中新页;断言 loaded=true 与目标 tab
//   PT4 tab_activate / close_tab:激活不过门、关闭过门;关闭后 get_tabs 无该
//      tab;get_tabs 每项带 status 字段
//   PT5 守卫与参数闸:独立单标签页窗口的 close_tab 被最后标签页守卫拒绝;
//      navigate_tab 拒绝 javascript: 等非 http/https URL
//   说明:content 侧采样截断(source_truncated,CAPTURE_HTML_MAX_CHARS=1M)
//   的透出由 pipeline 单测覆盖 —— e2e 造 1M 字节夹具不成比例,不在此重复。
//
// mock 手法:CDP Fetch 拦截 mock.test/doc* 返回夹具 HTML(真实 Chromium
// 渲染 + content script 可注入);LLM 按脚本逐跳发工具调用。

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { zh } from "./lib-i18n.mjs";
import {
  launchWithCdp,
  ask,
  makeChecker,
  openPanel,
  seedProviders,
  sse,
} from "./lib-cdp-mock.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(__dirname, "..", "dist");
const USER_DATA_DIR = `/tmp/verify-page-tools-${Date.now()}`;

const check = makeChecker();

// PT1 夹具:三个标题节,「夜航船」是第一节特有词(page_find 的定位目标)
const DOC_HTML = `<html><head><meta charset="utf-8"></head><body><main>
  <h1>测试文档</h1>
  <p>前言:本页是读页链路的端到端夹具,覆盖大纲、检索与续读。</p>
  <h2>第一章 短节</h2>
  <p>第一章正文:夜航船是本节的特有词,page_find 应能定位到这一节。</p>
  <h2>第二章 结尾</h2>
  <p>第二章正文:全篇完。</p>
</main></body></html>`;

// PT2 夹具:第二节超长(6000 字符,超出单节 4000 上限),被裁尾部藏暗号
// 「芝麻关门」—— 若截断后它仍出现在快照里,说明上限没生效
const BIG_HTML = `<html><head><meta charset="utf-8"></head><body><main>
  <h1>长文测试</h1>
  <p>前置短文。</p>
  <h2>第一节 短</h2>
  <p>短内容。</p>
  <h2>第二节 长</h2>
  <p>${"长".repeat(6000)}节尾暗号:芝麻关门</p>
</main></body></html>`;

const { browser, extId, mock } = await launchWithCdp({
  extDir: EXT_DIR,
  userDataDir: USER_DATA_DIR,
});
console.log("✅ 扩展:", extId);

let lastRequest = null;
/** 当前场景的工具调用脚本;args 为函数时收到上一条工具结果(JSON) */
let chain = [];

mock.setRoutes([
  // doc-big 必须在 doc 之前:includes 前缀重叠,顺序错了长文页会被小夹具顶掉
  { match: (url) => url.includes("mock.test/doc-big"), handle: async (ctx) => ctx.fulfill({ status: 200, headers: { "Content-Type": "text/html" }, body: BIG_HTML }) },
  { match: (url) => url.includes("mock.test/doc"), handle: async (ctx) => ctx.fulfill({ status: 200, headers: { "Content-Type": "text/html" }, body: DOC_HTML }) },
  {
    match: (url) => url.includes("/chat/completions"),
    handle: async (ctx) => {
      const body = JSON.parse(ctx.params.request.postData ?? "{}");
      lastRequest = body;
      // 窗口 = 最后一条真实 user 之后(与 verify-web-search 同款;避免把
      // 历史轮的 tool_calls 计进本次脚本推进)
      const messages = body.messages ?? [];
      const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
      const window = messages.slice(lastUserIdx + 1);
      const done = window
        .flatMap((m) => (m.role === "assistant" ? m.tool_calls ?? [] : []))
        .length;
      const lastToolMsg = [...window].reverse().find((m) => m.role === "tool");
      const fulfill = (sseBody) =>
        ctx.fulfill({
          headers: { "Content-Type": "text/event-stream" },
          body: sseBody,
        });
      if (done >= chain.length) {
        return fulfill(
          sse(
            { choices: [{ delta: { content: "PAGE_DONE" } }] },
            { choices: [{ delta: {}, finish_reason: "stop" }] },
          ),
        );
      }
      const next = chain[done];
      let prevTool = null;
      try {
        prevTool = JSON.parse(lastToolMsg?.content ?? "null");
      } catch {
        prevTool = null;
      }
      const args = typeof next.args === "function" ? next.args(prevTool) : next.args;
      return fulfill(
        sse(
          { choices: [{ delta: { tool_calls: [{ index: 0, id: `call-${done}-${Date.now()}`, function: { name: next.name, arguments: JSON.stringify(args) } }] } }] },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        ),
      );
    },
  },
]);

const sidepanel = await openPanel(browser, extId, {
  configure: (p) => seedProviders(p, [{ id: "gpt-t" }]),
});

const openTarget = async (path) => {
  const page = await browser.newPage();
  await page.goto(`https://mock.test/${path}`, { waitUntil: "load" });
  // 不留 settle 等待:content script 按需懒注入(发送失败 → 注入 → 重试),
  // 快照采集在工具调用内发生,页面 load 即可
  const tabId = await sidepanel.evaluate(
    () =>
      new Promise((resolve) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) =>
          resolve(tabs[0]?.id ?? -1),
        );
      }),
  );
  return { page, tabId };
};

const toolMessagesOf = (body) => {
  const messages = body?.messages ?? [];
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
  return messages.slice(lastUserIdx + 1).filter((m) => m.role === "tool");
};

// ---- PT1 主链路:大纲 → 检索 → 续读 ----
console.log("\nPT1 读页三件套主链路(outline → find → read)");
{
  const { page, tabId } = await openTarget("doc");
  check(tabId > 0, "目标页已打开且拿到 tabId", `tabId=${tabId}`);
  chain = [
    { name: "page_outline", args: { tabId } },
    { name: "page_find", args: { tabId, query: "夜航船" } },
    {
      name: "page_read",
      args: (prev) => ({ tabId, offset: prev?.matches?.[0]?.pos }),
    },
  ];
  await ask(sidepanel, "这篇文档讲了什么");

  const tools = toolMessagesOf(lastRequest);
  check(tools.length === 3, "三个读页工具按脚本顺序执行", `n=${tools.length}`);

  const outline = JSON.parse(tools[0]?.content ?? "{}");
  check(
    (outline.items?.length ?? 0) >= 2 &&
      outline.items.every((it) => typeof it.offset === "number" && it.title),
    "page_outline 返回大纲条目(offset/title)",
    JSON.stringify(outline.items)?.slice(0, 140),
  );
  check(
    outline.sections_truncated === undefined && outline.source_truncated === undefined,
    "正常页不带截断标记(零误报)",
    JSON.stringify({ s: outline.sections_truncated, c: outline.source_truncated }),
  );

  const find = JSON.parse(tools[1]?.content ?? "{}");
  check(
    (find.matches?.length ?? 0) >= 1 &&
      typeof find.matches[0].pos === "number" &&
      Array.isArray(find.matches[0].headings),
    "page_find 命中并带 pos 与标题链",
    JSON.stringify(find.matches)?.slice(0, 140),
  );

  const read = JSON.parse(tools[2]?.content ?? "{}");
  check(
    read.offset === find.matches[0].pos && read.text.includes("夜航船"),
    "page_read 按 find 的 pos 精确续读到目标内容",
    JSON.stringify({ offset: read.offset, has: read.text?.includes("夜航船") }),
  );
  check(
    (read.headings?.length ?? 0) >= 1 && read.total_chars > 0,
    "page_read 带标题链与总量",
    JSON.stringify(read.headings),
  );
  await page.close();
}

// ---- PT2 截断标记回归 ----
console.log("\nPT2 单节截断不再静默(sections_truncated + web_fetch 指引)");
{
  const { page, tabId } = await openTarget("doc-big");
  // 大纲第二节的 offset → 续读该节
  chain = [
    { name: "page_outline", args: { tabId } },
    {
      name: "page_read",
      args: (prev) => ({
        tabId,
        offset: prev?.items?.find((it) => it.title.includes("第二节"))?.offset,
      }),
    },
  ];
  await ask(sidepanel, "这份长文档的结构");

  const tools = toolMessagesOf(lastRequest);
  check(tools.length === 2, "两跳按脚本执行", `n=${tools.length}`);

  const outline = JSON.parse(tools[0]?.content ?? "{}");
  check(
    outline.sections_truncated === true, "outline 带 sections_truncated 标记",
    JSON.stringify(outline.sections_truncated),
  );
  check(
    typeof outline.hint === "string" && outline.hint.includes("web_fetch"),
    "截断指引点名 web_fetch",
    outline.hint?.slice(0, 80),
  );
  check(
    !outline.hint?.includes("refresh"),
    "指引不指向 refresh(重建快照对单节上限无效,指了就是空耗 turn)",
    outline.hint?.slice(0, 80),
  );

  const read = JSON.parse(tools[1]?.content ?? "{}");
  check(
    read.sections_truncated === true, "page_read 同样携带 sections_truncated",
    JSON.stringify(read.sections_truncated),
  );
  check(
    typeof read.hint === "string" && read.hint.includes("web_fetch"),
    "read 结果同样带可行动指引",
    read.hint?.slice(0, 80),
  );
  check(
    read.text?.includes("长") === true && !read.text?.includes("芝麻关门"),
    "被裁内容确实不在快照里(上限真实生效)",
    `len=${read.text?.length}`,
  );
  await page.close();
}

// ---- PT3 navigate_tab 端到端(navigate → 快照自动失效 → find 命中)----
// 确认门:strict 下 navigate_tab(page-nav)过门,卡上展示目标 URL,放行后执行
console.log("\nPT3 navigate_tab 端到端(navigate → 快照自动失效 → page_find)");
{
  const sendBtn = `button[aria-label="${zh.chat.send}"]`;
  const inputSel = `textarea[aria-label="${zh.chat.askInput}"]`;
  const allowBtn = `button[aria-label="${zh.chat.confirmAllow}"]`;
  const sendOnly = async (text) => {
    const input = sidepanel.locator(inputSel);
    await input.waitFor({ timeout: 5000 });
    await input.fill(text);
    await sidepanel.locator(sendBtn).click();
  };
  const waitIdle = () =>
    sidepanel.locator(sendBtn).waitFor({ state: "visible", timeout: 30000 });

  // 先开「doc-big」页,再让模型 navigate 到「doc」夹具:跳转触发 tabs.onUpdated
  // → docBridge 快照自动失效,后续 page_find 不带 refresh 也应重建并命中
  const { page, tabId } = await openTarget("doc-big");
  chain = [
    { name: "navigate_tab", args: { tabId, url: "https://mock.test/doc" } },
    { name: "page_find", args: { tabId, query: "夜航船" } },
  ];
  await sendOnly("把当前页跳到测试文档页,找找夜航船");
  await sidepanel.locator(allowBtn).waitFor({ timeout: 20000 });
  await sidepanel.locator(allowBtn).click();
  await waitIdle();

  const tools = toolMessagesOf(lastRequest);
  check(tools.length === 2, "navigate → find 两跳按脚本执行", `n=${tools.length}`);
  const nav = JSON.parse(tools[0]?.content ?? "{}");
  check(
    nav.loaded === true && nav.tabId === tabId && nav.url === "https://mock.test/doc",
    "navigate_tab 等到 complete(loaded=true)并返回目标 tab",
    JSON.stringify(nav),
  );
  const find = JSON.parse(tools[1]?.content ?? "{}");
  check(
    (find.matches?.length ?? 0) >= 1 && JSON.stringify(find).includes("夜航船"),
    "跳转后 page_find 不带 refresh 直接命中(快照自动失效生效)",
    JSON.stringify(find.matches)?.slice(0, 120),
  );
  await page.close();
}

// ---- PT4 tab_activate / close_tab(确认卡放行 + get_tabs status)----
console.log("\nPT4 tab_activate / close_tab");
{
  const sendBtn = `button[aria-label="${zh.chat.send}"]`;
  const inputSel = `textarea[aria-label="${zh.chat.askInput}"]`;
  const allowBtn = `button[aria-label="${zh.chat.confirmAllow}"]`;
  const sendOnly = async (text) => {
    const input = sidepanel.locator(inputSel);
    await input.waitFor({ timeout: 5000 });
    await input.fill(text);
    await sidepanel.locator(sendBtn).click();
  };
  const waitIdle = () =>
    sidepanel.locator(sendBtn).waitFor({ state: "visible", timeout: 30000 });

  const p2 = await browser.newPage();
  await p2.goto("https://mock.test/doc-big", { waitUntil: "load" });
  const tabId2 = await sidepanel.evaluate(
    () =>
      new Promise((resolve) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) =>
          resolve(tabs[0]?.id ?? -1),
        );
      }),
  );
  check(tabId2 > 0, "第二页已打开且拿到 tabId", `tabId2=${tabId2}`);

  chain = [
    { name: "tab_activate", args: { tabId: tabId2 } },
    { name: "close_tab", args: { tabId: tabId2 } },
    { name: "get_tabs", args: {} },
  ];
  await sendOnly("切到第二个标签页,然后把它关掉,再列一下标签页");
  // tab_activate 不过门;close_tab(page-write)strict 下弹卡 → 放行
  await sidepanel.locator(allowBtn).waitFor({ timeout: 20000 });
  await sidepanel.locator(allowBtn).click();
  await waitIdle();

  const tools = toolMessagesOf(lastRequest);
  check(tools.length === 3, "activate → close → get_tabs 三跳按脚本执行", `n=${tools.length}`);
  const act = JSON.parse(tools[0]?.content ?? "{}");
  check(act.active === true && act.tabId === tabId2, "tab_activate 激活目标 tab", JSON.stringify(act));
  const closed = JSON.parse(tools[1]?.content ?? "{}");
  check(closed.closed === tabId2, "close_tab 关闭目标 tab", JSON.stringify(closed));
  const list = JSON.parse(tools[2]?.content ?? "{}");
  check(
    !(list.tabs ?? []).some((t) => t.tabId === tabId2),
    "get_tabs 已无被关 tab",
    JSON.stringify((list.tabs ?? []).map((t) => t.tabId)),
  );
  check(
    (list.tabs ?? []).every((t) => typeof t.status === "string"),
    "get_tabs 每项带 status 字段",
    JSON.stringify((list.tabs ?? [])[0]),
  );
  await p2.close().catch(() => {});
}

// ---- PT5 守卫与参数闸(最后标签页拒绝 / 非 http 拒绝)----
console.log("\nPT5 守卫与参数闸");
{
  const sendBtn = `button[aria-label="${zh.chat.send}"]`;
  const inputSel = `textarea[aria-label="${zh.chat.askInput}"]`;
  const allowBtn = `button[aria-label="${zh.chat.confirmAllow}"]`;
  const sendOnly = async (text) => {
    const input = sidepanel.locator(inputSel);
    await input.waitFor({ timeout: 5000 });
    await input.fill(text);
    await sidepanel.locator(sendBtn).click();
  };
  const waitIdle = () =>
    sidepanel.locator(sendBtn).waitFor({ state: "visible", timeout: 30000 });

  // 独立窗口 + 单标签页:close_tab 的最后标签页守卫应拒绝
  const win = await sidepanel.evaluate(() => chrome.windows.create({ url: "https://mock.test/doc" }));
  const soloTabId = win.tabs?.[0]?.id ?? -1;
  check(soloTabId > 0, "独立单标签页窗口已建", `soloTabId=${soloTabId}`);

  chain = [{ name: "close_tab", args: { tabId: soloTabId } }];
  await sendOnly("把刚才新窗口里的标签页关掉");
  await sidepanel.locator(allowBtn).waitFor({ timeout: 20000 });
  await sidepanel.locator(allowBtn).click();
  await waitIdle();
  let tools = toolMessagesOf(lastRequest);
  check(
    (tools[0]?.content ?? "").includes("last tab"),
    "最后标签页守卫:拒绝并语义化报错",
    tools[0]?.content?.slice(0, 120),
  );

  chain = [{ name: "navigate_tab", args: { url: "javascript:alert(1)" } }];
  await sendOnly("跳到 javascript:alert(1)");
  await sidepanel.locator(allowBtn).waitFor({ timeout: 20000 });
  await sidepanel.locator(allowBtn).click();
  await waitIdle();
  tools = toolMessagesOf(lastRequest);
  check(
    (tools[0]?.content ?? "").includes("http/https"),
    "非 http/https URL 拒绝并语义化报错",
    tools[0]?.content?.slice(0, 120),
  );

  await sidepanel.evaluate((id) => chrome.windows.remove(id), win.id);
}

console.log(`\n结果: ${check.failures.length} 条断言失败`);
await browser.close();
process.exit(check.failures.length > 0 ? 1 : 0);
