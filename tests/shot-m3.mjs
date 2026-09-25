// M3 视觉验收脚本(非断言型:截图 + 少量回归检查;原 shot-accents /
// probe-memory-ui / probe-mcp-ui / probe-hints 已并入,2026-09)
// 用法: pnpm build && node tests/shot-m3.mjs          # 全量:深浅色 × 对话/设置/历史/记忆/MCP + 模型弹层
//       pnpm build && node tests/shot-m3.mjs --accents # 只跑 8 套重点色试色(对话+设置,浅色)
//       pnpm build && node tests/shot-m3.mjs --hints   # 只跑提示分层留档(ⓘ 悬停/了解详情,中英)
//       pnpm build && node tests/shot-m3.mjs --som     # 只跑 SoM 视觉留档(page_screenshot 编号框)
// 回归: 一轮真实 mock 对话(含 web_search 工具调用)驱动 气泡/markdown/过程卡 渲染,
//       期间收集 pageerror/console error,结束时汇总。
// 配置走旧版单供应商字段:顺带练习读时迁移路径。

import { zh, en } from "./lib-i18n.mjs";
import { rmSync, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  launchWithCdp,
  seedSessions,
  seedMemories,
  setTheme,
  sse,
  injectTestConfig,
} from "./lib-cdp-mock.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(__dirname, "..", "dist");
const USER_DATA_DIR = "/tmp/probe-m3-profile";
const OUT_DIR = "/tmp/tars-m3";

rmSync(USER_DATA_DIR, { recursive: true, force: true });
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

const ACCENTS_ONLY = process.argv.includes("--accents");
const HINTS_ONLY = process.argv.includes("--hints");
const SOM_ONLY = process.argv.includes("--som");
/** [id, 设置页色板 aria-label 名];id 清单对应 scripts/generate-m3.mjs 的
 *  ACCENTS,标签从字典取 —— 字典改色名断言自动跟随 */
const ACCENTS = [
  ["coral", zh.settings.accentCoral],
  ["rose", zh.settings.accentRose],
  ["green", zh.settings.accentGreen],
  ["ocean", zh.settings.accentOcean],
  ["teal", zh.settings.accentTeal],
  ["indigo", zh.settings.accentIndigo],
  ["lilac", zh.settings.accentLilac],
  ["graphite", zh.settings.accentGraphite],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 24 * 3600 * 1000;

let pageErrors = [];
const shot = async (page, name) => {
  await page.screenshot({ path: `${OUT_DIR}/${name}.png` });
  console.log(`  📸 ${name}.png`);
};

// 设置页 → 记忆整页(视觉与套件共用的入口路径)
const openMemoryPage = async () => {
  await page.locator(`button[aria-label="${zh.chat.openSettings}"]`).click();
  await page.locator(`h2:has-text("${zh.settings.title}")`).waitFor({ timeout: 5000 });
  await sleep(350);
  await page.locator(`button[aria-label="${zh.memory.settingsManage}"]`).click();
  await page.locator(`h2:has-text("${zh.memory.entryTitle}")`).waitFor({ timeout: 5000 });
  await sleep(400);
};

// ---- 提示分层留档(原 probe-hints.mjs,2026-09 并入):瘦身设置页 +
// 「了解详情」折叠展开 + ⓘ 悬停态,中英各一组;带 ok 健康检查,失败即抛 ──
async function runHints(browser, extId) {
  const ok = (cond, label) => {
    if (!cond) throw new Error(`❌ ${label}`);
    console.log(`  ✅ ${label}`);
  };
  const hpage = await browser.newPage({ deviceScaleFactor: 2 });
  const errs = [];
  hpage.on("pageerror", (e) => errs.push(e));
  await hpage.setViewportSize({ width: 420, height: 740 });
  await hpage.goto(`chrome-extension://${extId}/sidepanel.html`);
  await sleep(500);
  // 先注入旧版单供应商配置再重载:设置页挂载时才 loadConfig,注入必须在其前
  await injectTestConfig(hpage);
  await hpage.reload();
  await sleep(800);

  // ① 供应商卡片展开 → Base URL 的 ⓘ 悬停态(气泡弹出)
  await hpage.locator(`button[aria-label="${zh.chat.openSettings}"]`).click();
  await sleep(400);
  await hpage.locator(".model-row-head").first().click();
  await sleep(300);
  await hpage.locator(".info-tip-btn").first().hover();
  await sleep(400);
  ok(await hpage.locator(".info-tip-pop").first().isVisible(), "ⓘ 悬停弹出气泡");
  await shot(hpage, "hints-1-zh-infotip");
  await hpage.mouse.move(0, 0); // 移开鼠标取消悬停(不能 Esc:会关掉整个设置悬浮层)
  await sleep(300);

  // ② 联网:打开开关 → 第一枚折叠钮(联网区)展开
  const webSwitch = hpage.locator("#settings-web-search");
  if ((await webSwitch.getAttribute("aria-checked")) !== "true") {
    await webSwitch.click();
    await sleep(500);
  }
  const mores = hpage.locator(".hint-more-btn");
  // DOM 序 = 分区序(Model/Appearance 无 HintMore):联网/MCP/记忆 +
  // 安全区确认门告知(confirmActions 默认开,2026-09-15 加入)。这里只锁
  // 「至少三处机制说明」;probe-hints 时代硬编码 ===3 曾被安全区新增打破
  ok(
    (await mores.count()) >= 3,
    "联网/MCP/记忆的「了解详情」齐全",
  );
  await mores.nth(0).click();
  await sleep(300);
  ok(
    (await hpage.locator(".field-hint").allTextContents()).some((s) =>
      s.includes("DuckDuckGo"),
    ),
    "联网机制详情展开",
  );
  await hpage
    .locator("h3", { hasText: zh.settings.sectionWeb })
    .first()
    .scrollIntoViewIfNeeded();
  await sleep(300);
  await shot(hpage, "hints-2-zh-web-more");

  // ③ 记忆:展开态留档
  await mores.nth(2).click();
  await sleep(300);
  await hpage
    .locator("h3", { hasText: zh.settings.sectionMemory })
    .first()
    .scrollIntoViewIfNeeded();
  await sleep(300);
  await shot(hpage, "hints-3-zh-memory-more");

  // ④ 英文:切语言后同一屏(联网折叠保持展开,文案即变)
  await hpage.locator("#ui-locale").selectOption("en-US");
  await sleep(500);
  await hpage
    .locator("h3", { hasText: en.settings.sectionWeb })
    .first()
    .scrollIntoViewIfNeeded();
  await sleep(300);
  ok(
    (await hpage.locator(".field-hint").allTextContents()).some((s) =>
      s.includes("DuckDuckGo"),
    ),
    "切英文后展开态文案跟随",
  );
  await shot(hpage, "hints-4-en-web-more");

  if (errs.length > 0) {
    console.log(`\n❌ VERDICT: hints 页面错误 ${errs.length} 条`);
    throw new Error(`hints 页面错误:${errs[0]}`);
  }
  console.log(`\n✅ VERDICT: PASS(hints)— 截图在 ${OUT_DIR}/`);
}

// ---- SoM 视觉留档(page_screenshot 轮并入,2026-09):mock LLM 驱动
// find_elements → page_screenshot,把模型实际收到的 JPEG(含 SoM 编号框、
// 1280 降采样)与 marks 对照表落盘。行为断言归 verify-screenshot 套件,
// 这里只留档 + 健康检查。标记层是瞬态的(画上→捕获→摘除),wire 上的
// 带图 user 消息是唯一留得下来的产物 ──
async function runSom(browser, extId, mock) {
  const ok = (cond, label) => {
    if (!cond) throw new Error(`❌ ${label}`);
    console.log(`  ✅ ${label}`);
  };

  // 富内容后台页:导航/按钮/表单混排,编号框有真实密度可言
  const SOM_HTML = `<html><head><meta charset="utf-8"><title>Acme 控制台</title></head>
<body style="margin:0;font-family:system-ui,sans-serif;background:#f6f7f9">
  <header style="display:flex;gap:16px;align-items:center;padding:12px 24px;background:#fff;border-bottom:1px solid #e5e7eb">
    <strong style="font-size:18px">Acme 控制台</strong>
    <a href="#">概览</a><a href="#">订单</a><a href="#">报表</a>
    <button>新建订单</button>
    <input placeholder="搜索订单、客户…" style="margin-left:auto;width:200px;padding:6px 10px;border:1px solid #d1d5db;border-radius:6px">
    <button>通知</button>
  </header>
  <main style="padding:24px;display:grid;grid-template-columns:2fr 1fr;gap:16px">
    <section style="background:#fff;border-radius:10px;padding:16px">
      <h2 style="margin:0 0 8px">本周数据</h2>
      <p style="color:#555;margin:0 0 12px">订单量、转化率与退款率的趋势一览,数据每日凌晨刷新。</p>
      <button>导出 CSV</button>
      <button>分享看板</button>
      <p style="margin-top:16px"><a href="#">查看历史归档</a></p>
    </section>
    <aside style="background:#fff;border-radius:10px;padding:16px">
      <h2 style="margin:0 0 12px">快捷操作</h2>
      <label>收件人 <input style="width:100%;margin:4px 0 10px;padding:6px;border:1px solid #d1d5db;border-radius:6px"></label>
      <select style="width:100%;margin-bottom:10px;padding:6px"><option>普通快递</option><option>次日达</option></select>
      <textarea placeholder="备注…" style="width:100%;box-sizing:border-box;margin-bottom:10px;padding:6px;border:1px solid #d1d5db;border-radius:6px"></textarea>
      <button>发送通知</button>
      <p style="margin:12px 0 0"><a href="#">管理通知模板</a></p>
    </aside>
  </main>
</body></html>`;

  // wire 侧顺手捕获:带图 user 消息(data URL + 注记文本)与 screenshot 结果
  let wireImage = null;
  let noteText = null;
  let shotResult = null;
  mock.setRoutes([
    {
      match: (url) => url.includes("mock.test/som"),
      handle: async (ctx) =>
        ctx.fulfill({
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
          body: SOM_HTML,
        }),
    },
    {
      match: (url) => url.includes("/chat/completions"),
      handle: async (ctx) => {
        const body = JSON.parse(ctx.params.request.postData ?? "{}");
        const msgs = body.messages ?? [];
        // 截图注记以 user 消息插在 run 中段,「最后一条 user 之后」式窗口
        // 会清零计数 → 全局数 assistant tool_calls(verify-screenshot 同款)
        const done = msgs
          .flatMap((m) => (m.role === "assistant" ? m.tool_calls ?? [] : []))
          .length;
        for (const m of msgs) {
          if (m.role === "user" && Array.isArray(m.content)) {
            const img = m.content.find((p) => p.type === "image_url");
            if (img) {
              wireImage = img.image_url.url;
              noteText =
                m.content.find((p) => p.type === "text")?.text ?? null;
            }
          }
          if (m.role === "tool") {
            try {
              const r = JSON.parse(m.content);
              if (Array.isArray(r.marks)) shotResult = r;
            } catch {
              // find_elements 等其它工具结果不是 screenshot 形态,跳过
            }
          }
        }
        const fulfillSSE = (sseBody) =>
          ctx.fulfill({
            headers: { "Content-Type": "text/event-stream" },
            body: sseBody,
          });
        if (done >= 2) {
          return fulfillSSE(
            sse(
              { choices: [{ delta: { content: "已按编号框定位到页面元素。" } }] },
              { choices: [{ delta: {}, finish_reason: "stop" }] },
            ),
          );
        }
        const calls = [
          { name: "find_elements", args: {} },
          { name: "page_screenshot", args: {} },
        ];
        const next = calls[done];
        return fulfillSSE(
          sse(
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: `call-${done}`,
                        function: {
                          name: next.name,
                          arguments: JSON.stringify(next.args),
                        },
                      },
                    ],
                  },
                },
              ],
            },
            { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
          ),
        );
      },
    },
  ]);

  const page = await browser.newPage({ deviceScaleFactor: 2 });
  await page.setViewportSize({ width: 420, height: 740 });
  await page.goto(`chrome-extension://${extId}/sidepanel.html`);
  await page.evaluate(() =>
    chrome.storage.local.set({
      providers: [
        {
          id: "p0",
          name: "test",
          baseUrl: "https://api.test.example.com/v1",
          apiKey: "sk-test",
          models: [{ id: "gpt-v", vision: true }],
        },
      ],
      modelProvider: "p0",
      model: "gpt-v",
    }),
  );
  await page.reload();
  await sleep(800);

  // 目标页后开 = 窗口激活 tab,captureVisibleTab 拍到的才是它
  const target = await browser.newPage();
  await target.setViewportSize({ width: 1280, height: 800 });
  await target.goto("https://mock.test/som", { waitUntil: "load" });
  await sleep(400);
  await target.screenshot({ path: `${OUT_DIR}/som-1-page.png` });
  console.log("  📸 som-1-page.png(无标记原页)");

  const tabId = await page.evaluate(
    () =>
      new Promise((resolve) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) =>
          resolve(tabs[0]?.id ?? -1),
        );
      }),
  );
  ok(tabId > 0, "拿到目标页 tabId");

  const input = page.locator(`textarea[aria-label="${zh.chat.askInput}"]`);
  await input.fill("看看这个页面,告诉我有哪些可以操作的元素");
  await page.locator(`button[aria-label="${zh.chat.send}"]`).click();
  await page
    .locator(`button[aria-label="${zh.chat.send}"]`)
    .waitFor({ state: "visible", timeout: 30000 });
  await sleep(400);

  ok(
    !!wireImage && wireImage.startsWith("data:image/jpeg;base64,"),
    "wire 上有带图 user 消息",
  );
  ok(
    wireImage.length > 10_000,
    `截图附件非空(data URL ${Math.round(wireImage.length / 1024)}KB)`,
  );

  const B64_PREFIX = "data:image/jpeg;base64,";
  writeFileSync(
    `${OUT_DIR}/som-2-model-view.jpg`,
    Buffer.from(wireImage.slice(B64_PREFIX.length), "base64"),
  );
  console.log("  📸 som-2-model-view.jpg(模型视角,含编号框)");

  ok(
    Array.isArray(shotResult?.marks) && shotResult.marks.length >= 1,
    `marks 表非空(${shotResult?.marks?.length ?? 0} 个编号)`,
  );
  const md = [
    "# SoM 视觉留档(page_screenshot)",
    "",
    "- `som-1-page.png` — 原页(无标记,人类视角)",
    "- `som-2-model-view.jpg` — 模型实际收到的 JPEG(视口捕获,1280 宽降采样,含编号框)",
    `- 捕获几何:viewport ${shotResult.viewport?.w}×${shotResult.viewport?.h} · scroll_y=${shotResult.page?.scroll_y} / scroll_height=${shotResult.page?.scroll_height} · at_bottom=${shotResult.page?.at_bottom}`,
    "",
    "## 随图注入的注记(模型收到原文)",
    "",
    "```",
    noteText ?? "(无)",
    "```",
    "",
    "## marks 对照表(编号 → 元素)",
    "",
    "| # | tag | role | label | selector |",
    "| - | --- | ---- | ----- | -------- |",
    ...shotResult.marks.map(
      (m) =>
        `| ${m.n} | ${m.tag} | ${m.role ?? "-"} | ${m.label ?? "-"} | \`${m.selector}\` |`,
    ),
  ].join("\n");
  writeFileSync(`${OUT_DIR}/som-3-marks.md`, md);
  console.log("  📄 som-3-marks.md(marks 对照表)");

  await target.close();
  console.log(`\n✅ VERDICT: PASS(som)— 留档在 ${OUT_DIR}/`);
}

// ---- 启动 ----
let { browser, extId, mock } = await launchWithCdp({
  extDir: EXT_DIR,
  userDataDir: USER_DATA_DIR,
});
console.log("✅ 扩展:", extId);

// --hints 只跑提示分层,不走主流程的 mock 路由注册
if (HINTS_ONLY) {
  await runHints(browser, extId);
  await browser.close();
  process.exit(0);
}

// --som 只跑 SoM 视觉留档(自带 mock 路由)
if (SOM_ONLY) {
  await runSom(browser, extId, mock);
  await browser.close();
  process.exit(0);
}

// LLM 剧本:"search"(主对话,web_search 过程卡)|"mcp"(MCP 过程卡);
// 一次 mock 对话结束后切剧本,再驱动一轮 MCP 工具调用
let script = "search";
const WIRE_GET = "mcp_GitHub_get_issue";

const toolCallSSE = (ctx, id, name, args) =>
  ctx.fulfill({
    headers: { "Content-Type": "text/event-stream" },
    body: sse(
      {
        choices: [
          {
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  id,
                  type: "function",
                  function: { name, arguments: JSON.stringify(args) },
                },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ),
  });
const answerSSE = (ctx, text) =>
  ctx.fulfill({
    headers: { "Content-Type": "text/event-stream" },
    body: sse(
      { choices: [{ delta: { content: text } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ),
  });

// 搜索引擎 mock(web_search 工具会真的去抓)
mock.setRoutes([
  {
    match: (url) => /bing\.com|duckduckgo\.com/.test(url),
    handle: async (ctx) => {
      await ctx.delay(300);
      await ctx.fulfill({
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
        body: `<html><body>
          <li class="b_algo"><h2><a href="https://m3.material.io">Material Design 3</a></h2>
          <div class="b_caption"><p>Material Design 3 是 Google 最新设计系统,包含动态取色、形状分级与表达性动效。</p></div></li>
          <li class="b_algo"><h2><a href="https://example.com/m3-guide">M3 迁移指南</a></h2>
          <div class="b_caption"><p>从 M2 迁移到 M3 的完整清单:色彩角色、组件形态与动效令牌。</p></div></li>
        </body></html>`,
      });
    },
  },
  {
    // MCP 服务器 mock:tools/list 直答(三个工具,设置页拉清单用)+ tools/call
    match: (url) => url.startsWith("https://mcpmock.test/mcp"),
    handle: async (ctx) => {
      const body = JSON.parse(ctx.params.request.postData ?? "{}");
      const json = (obj, status = 200) =>
        ctx.fulfill({
          status,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(obj),
        });
      if (body.method === "tools/list")
        return json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [
              {
                name: "get_issue",
                description:
                  "获取 GitHub issue 的完整详情,包含标题、正文、标签、评论时间线与关联 PR 信息",
                inputSchema: {
                  type: "object",
                  properties: { issue_number: { type: "number" } },
                  required: ["issue_number"],
                },
              },
              {
                name: "list_issues",
                description: "按状态与标签过滤列出仓库的 issue 列表",
                inputSchema: { type: "object", properties: {} },
              },
              {
                name: "create_issue",
                description: "在仓库中创建一个新 issue",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          },
        });
      if (body.method === "tools/call")
        return json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            content: [{ type: "text", text: "issue #42: mock 内容,关于侧栏渲染的一个边界问题" }],
          },
        });
      return json({ jsonrpc: "2.0", id: body.id, result: {} });
    },
  },
  {
    match: (url) => url.includes("/chat/completions"),
    handle: async (ctx) => {
      const body = JSON.parse(ctx.params.request.postData ?? "{}");
      // 只看当前轮(最后一条 user 之后)有没有 tool 观察结果 —— 全历史里
      // 上一轮的 tool 消息不算,否则 MCP 剧本会误判
      const msgs = body.messages ?? [];
      const lastUserIdx = msgs.map((m) => m.role).lastIndexOf("user");
      const usedTool = msgs.slice(lastUserIdx + 1).some((m) => m.role === "tool");
      if (script === "mcp") {
        if (!usedTool) return toolCallSSE(ctx, "call_m1", WIRE_GET, { issue_number: 42 });
        return answerSSE(ctx, "issue #42 的要点已整理完毕。");
      }
      if (!usedTool) {
        // 第一轮:让模型发起 web_search 工具调用(驱动过程卡)
        await ctx.delay(400);
        return toolCallSSE(ctx, "call_1", "web_search", {
          query: "Material Design 3 设计规范",
        });
      }
      // 第二轮:流式 markdown 正文(练习 markdown.css 的各元素)
      await ctx.delay(400);
      const md = [
        "查到了,给你一份 **Material 3** 的要点整理:",
        "",
        "## 核心变化",
        "",
        "1. **动态取色**:从源色生成整套 scheme",
        "2. 形状分级(shape scale)",
        "3. 表达性动效",
        "",
        "### 色彩角色对照",
        "",
        "| M2 | M3 |",
        "| --- | --- |",
        "| primary | primary + on-primary |",
        "| surface | surface-container 五级 |",
        "",
        "> 状态层用 `color-mix` 做 8% / 12% 透明叠加。",
        "",
        "```css",
        ".card {",
        "  background: var(--md-sys-color-surface-container-low);",
        "  border-radius: var(--radius-lg);",
        "}",
        "```",
        "",
        "完整规范见 [m3.material.io](https://m3.material.io)。",
      ].join("\n");
      return answerSSE(ctx, md);
    },
  },
]);

const page = await browser.newPage({
  deviceScaleFactor: 2,
});
// persistent context 下 newPage 的 viewport 选项会被忽略,显式设一次
await page.setViewportSize({ width: 420, height: 740 });
page.on("pageerror", (e) => pageErrors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") pageErrors.push(`console: ${m.text()}`);
});
await page.goto(`chrome-extension://${extId}/sidepanel.html`);

// 配置:多模型 + 别名(练习模型弹层与设置页模型列表)
await page.evaluate(() =>
  chrome.storage.local.set({
    apiKey: "sk-test",
    model: "deepseek-chat",
    baseUrl: "https://api.test.example.com/v1",
    models: [
      { id: "deepseek-chat", alias: "DeepSeek V3", vision: false },
      { id: "deepseek-reasoner", alias: "DeepSeek R1" },
      { id: "gpt-4o", vision: true },
      { id: "qwen-max-0428" },
    ],
    theme: "light",
    webSearch: true,
    historyRetention: 7,
  }),
);
await page.reload();
await sleep(800);

// ---- 一轮真实对话:工具调用 + markdown 回复(两种模式都靠它给对话页内容)----
console.log("\n── 跑一轮 mock 对话 ──");
const input = page.locator(`textarea[aria-label="${zh.chat.askInput}"]`);
await input.fill("帮我查一下 Material Design 3 有什么新变化");
await page.locator(`button[aria-label="${zh.chat.send}"]`).click();
// 等回复完成(发送按钮回来)
await page
  .locator(`button[aria-label="${zh.chat.send}"]`)
  .waitFor({ state: "visible", timeout: 30000 });
await sleep(600);

// 展开settled 过程卡看完整行
const traceChip = page.locator(".trace-header").first();
if (await traceChip.count()) {
  await shot(page, "1-chat-trace-collapsed");
  await traceChip.click();
  await sleep(400);
}

if (ACCENTS_ONLY) {
  // ---- 重点色试色:走真实代码路径点设置页色板(选中环 + 落盘 + data-accent)----
  await setTheme(page, "light");
  await sleep(200);
  for (const [accent, label] of ACCENTS) {
    await page.locator(`button[aria-label="${zh.chat.openSettings}"]`).click();
    await sleep(400);
    const swatch = page.locator(
      `button[aria-label="${zh.settings.accentAria.replace("{name}", label)}"]`,
    );
    await swatch.scrollIntoViewIfNeeded();
    await swatch.click();
    await sleep(300);
    await page.screenshot({ path: `${OUT_DIR}/accent-${accent}-settings.png` });
    await page.keyboard.press("Escape");
    await sleep(300);
    await page.screenshot({ path: `${OUT_DIR}/accent-${accent}-chat.png` });
    console.log(`  📸 accent-${accent}`);
  }
} else {
  await setTheme(page, "light");
  await sleep(200);
  await shot(page, "1-chat-light");
  console.log(`  会话可见: ${await page.getByText("核心变化").count()}`);

  // 模型弹层
  await page.locator(`button[aria-label="${zh.chat.selectModel}"]`).click();
  await sleep(300);
  await shot(page, "2-combo-light");
  await page.keyboard.press("Escape");
  await sleep(200);

  // 种历史数据(今天组已有 live 会话,再种昨天/3天/20天)
  await seedSessions(page, [
    { id: "s-yday", title: "帮我总结这篇论文的方法部分", at: Date.now() - 1 * DAY },
    { id: "s-3day", title: "把表格数据整理成周报格式", at: Date.now() - 3 * DAY },
    { id: "s-20day", title: "查一下 React 19 的新特性", at: Date.now() - 20 * DAY },
  ]);

  // 设置页
  await page.locator(`button[aria-label="${zh.chat.openSettings}"]`).click();
  await page.locator(`h2:has-text("${zh.settings.title}")`).waitFor({ timeout: 5000 });
  await sleep(500);
  await shot(page, "3-settings-light");
  // 开关特写(检验对勾居中):4x 缩放元素截图
  const lightSwitch = page.locator("#settings-web-search");
  await lightSwitch.scrollIntoViewIfNeeded();
  await sleep(200);
  await lightSwitch.screenshot({ path: `${OUT_DIR}/3b-switch-light.png`, scale: "device" });
  console.log("  📸 3b-switch-light.png");
  // 展开一个模型行
  await page.locator(".model-row-head").first().click();
  await sleep(400);
  await shot(page, "4-settings-model-light");
  await page.keyboard.press("Escape");
  await sleep(300);

  // 历史会话页
  await page.locator(`button[aria-label="${zh.chat.openSessions}"]`).click();
  await page.locator(`h2:has-text("${zh.sessions.title}")`).waitFor({ timeout: 5000 });
  await sleep(500);
  await shot(page, "5-sessions-light");

  // ---- 深色 ----
  await setTheme(page, "dark");
  await sleep(300);
  await shot(page, "6-sessions-dark");
  await page.keyboard.press("Escape");
  await sleep(300);
  await shot(page, "7-chat-dark");
  await page.locator(`button[aria-label="${zh.chat.openSettings}"]`).click();
  await sleep(500);
  await shot(page, "8-settings-dark");
  // 深色开关特写(联网搜索开关在首屏外,滚动到可见再截)
  const webSwitch = page.locator("#settings-web-search");
  await webSwitch.scrollIntoViewIfNeeded();
  await sleep(200);
  await webSwitch.screenshot({ path: `${OUT_DIR}/8b-switch-dark.png`, scale: "device" });
  console.log("  📸 8b-switch-dark.png");

  // ── 记忆页(原 probe-memory-ui,2026-09 并入)──
  console.log("\n── 记忆页:12 条 浅/深 + 设置页记忆卡 ──");
  await seedMemories(page, [
    ["偏好简洁的中文回答,少用 emoji", true],
    ["身份:前端工程师,熟悉 React 和 TypeScript", true],
    ["时区 UTC+8,工作日 10:00-19:00 在线", false],
    ["常用的模型是 DeepSeek,便宜优先", false],
    ["代码注释喜欢中文,命名用英文", false],
    ["正在做的项目是 TARS 浏览器扩展", false],
    ["不喜欢被重复询问已知信息", false],
    ["搜索结果偏好近一年的内容", false],
    ["周末一般不工作,不要安排提醒", false],
    ["输出格式:能用列表就不用大段文字", false],
    ["对 \"无障碍\" 话题特别关注", false],
    ["养了一只叫年糕的橘猫,偶尔会聊到", false],
  ]);
  await page.reload();
  await sleep(800);
  for (const theme of ["light", "dark"]) {
    await setTheme(page, theme);
    await sleep(250);
    await openMemoryPage();
    await shot(page, `memory-page-${theme}`);
    await page.keyboard.press("Escape");
    await sleep(300);
    // 设置页瘦身后的记忆卡
    await page.locator(`button[aria-label="${zh.chat.openSettings}"]`).click();
    await page.locator(`h2:has-text("${zh.settings.title}")`).waitFor({ timeout: 5000 });
    await sleep(350);
    const card = page.locator(".settings-card", {
      has: page.locator("#settings-memory"),
    });
    await card.scrollIntoViewIfNeeded();
    await sleep(200);
    await card.screenshot({ path: `${OUT_DIR}/memory-card-${theme}.png` });
    console.log(`  📸 memory-card-${theme}.png`);
    await page.keyboard.press("Escape");
    await sleep(300);
  }

  // 空态(空数组 = 清空重种)
  await seedMemories(page, []);
  await page.reload();
  await sleep(800);
  await setTheme(page, "light");
  await sleep(250);
  await openMemoryPage();
  await shot(page, "memory-empty-light");
  await page.keyboard.press("Escape");
  await sleep(300);

  // 超预算:40 条,应出现「有 N 条未注入」
  console.log("── 记忆页:超预算 40 条 ──");
  await seedMemories(
    page,
    Array.from({ length: 40 }, (_, i) => [
      `记忆条目 ${i + 1}:偏好明快的回答风格,给出的建议要带具体步骤和例子,不要泛泛而谈,也不要重复我已经知道的背景知识`,
      i < 2,
    ]),
  );
  await page.reload();
  await sleep(800);
  await openMemoryPage();
  await shot(page, "memory-overflow-light");
  // 定位统计行用键派生子串(取字典值「·」后、占位符前的稳定措辞段)
  const statsNeedle = zh.memory.saved.split("·")[1]?.split("{")[0].trim() ?? "";
  const stats = await page.evaluate(
    (needle) => ({
      sub: [...document.querySelectorAll("p")]
        .map((p) => p.textContent)
        .find((t) => t?.includes(needle)),
    }),
    statsNeedle,
  );
  console.log("  超预算副标:", stats.sub);
  await page.keyboard.press("Escape");
  await sleep(300);

  // ── MCP(原 probe-mcp-ui,2026-09 并入)──
  console.log("\n── MCP:设置页卡片 + 聊天过程卡 ──");
  await page.evaluate(() =>
    chrome.storage.local.set({
      mcp: {
        enabled: true,
        servers: [
          {
            id: "srv-1",
            name: "GitHub",
            url: "https://mcpmock.test/mcp",
            headers: { Authorization: "Bearer ghp-test" },
            enabled: true,
          },
        ],
      },
    }),
  );
  await page.reload();
  await sleep(900);
  await setTheme(page, "light");
  script = "mcp"; // LLM 切 MCP 剧本

  // 设置页 MCP 区块(卡片展开,拉工具清单)
  await page.locator(`button[aria-label="${zh.chat.openSettings}"]`).click();
  await page.locator(`h2:has-text("${zh.settings.title}")`).waitFor({ timeout: 5000 });
  await sleep(400);
  await page.locator('h3:has-text("MCP")').scrollIntoViewIfNeeded();
  await sleep(200);
  await page.locator(".model-row-head").last().click();
  await sleep(1500);
  await shot(page, "mcp-settings-light");
  await page.keyboard.press("Escape");
  await sleep(300);

  // 聊天流:一轮真实 MCP 工具调用 → 过程卡
  const mcpInput = page.locator(`textarea[aria-label="${zh.chat.askInput}"]`);
  await mcpInput.fill("看一下 issue 42");
  await page.locator(`button[aria-label="${zh.chat.send}"]`).click();
  // mcp_* 工具全量过确认门(宁慢勿错):等卡出现 → 留档 → 自动放行。
  // 不应答的话 run 停在门里 2 分钟,脚本等「发送按钮回来」必然超时
  const allowBtn = page.locator(`button[aria-label="${zh.chat.confirmAllow}"]`);
  await allowBtn.waitFor({ state: "visible", timeout: 15000 });
  await shot(page, "mcp-confirm-light");
  await allowBtn.click();
  await page
    .locator(`button[aria-label="${zh.chat.send}"]`)
    .waitFor({ state: "visible", timeout: 30000 });
  await sleep(500);
  await shot(page, "mcp-chat-light");

  await setTheme(page, "dark");
  await sleep(300);
  await shot(page, "mcp-chat-dark");
  await page.locator(`button[aria-label="${zh.chat.openSettings}"]`).click();
  await sleep(400);
  await page.locator('h3:has-text("MCP")').scrollIntoViewIfNeeded();
  await sleep(200);
  await page.locator(".model-row-head").last().click();
  await sleep(1500);
  await shot(page, "mcp-settings-dark");
}

// ---- 回归检查 ----
console.log("\n── 回归 ──");
const errs = pageErrors.filter(
  (e) => !e.includes("Extension context invalidated"),
);
console.log(
  errs.length === 0
    ? "  ✅ 无 pageerror / console error"
    : `  ❌ ${errs.length} 个错误:\n${errs.map((e) => `     ${e}`).join("\n")}`,
);

console.log(`\n完成:截图在 ${OUT_DIR}`);
await browser.close();
process.exit(errs.length > 0 ? 1 : 0);
