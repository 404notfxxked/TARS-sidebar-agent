// M3 视觉验收脚本(非断言型:截图 + 少量回归检查;原 shot-accents /
// probe-memory-ui / probe-mcp-ui 已并入,2026-09)
// 用法: pnpm build && node tests/shot-m3.mjs          # 全量:深浅色 × 对话/设置/历史/记忆/MCP + 模型弹层
//       pnpm build && node tests/shot-m3.mjs --accents # 只跑 8 套重点色试色(对话+设置,浅色)
// 回归: 一轮真实 mock 对话(含 web_search 工具调用)驱动 气泡/markdown/过程卡 渲染,
//       期间收集 pageerror/console error,结束时汇总。
// 配置走旧版单供应商字段:顺带练习读时迁移路径。

import { zh } from "./lib-i18n.mjs";
import { rmSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  launchWithCdp,
  seedSessions,
  seedMemories,
  setTheme,
  sse,
} from "./lib-cdp-mock.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(__dirname, "..", "dist");
const USER_DATA_DIR = "/tmp/verify-m3-profile";
const OUT_DIR = "/tmp/tars-m3";

rmSync(USER_DATA_DIR, { recursive: true, force: true });
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

const ACCENTS_ONLY = process.argv.includes("--accents");
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

// ---- 启动 ----
let { browser, extId, mock } = await launchWithCdp({
  extDir: EXT_DIR,
  userDataDir: USER_DATA_DIR,
});
console.log("✅ 扩展:", extId);

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
    const swatch = page.locator(`button[aria-label="重点色：${label}"]`);
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
  const stats = await page.evaluate(() => ({
    sub: [...document.querySelectorAll("p")].map((p) => p.textContent).find((t) => t?.includes("每轮注入")),
  }));
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
