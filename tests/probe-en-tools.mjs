// 探针:英文界面下工具行/摘要标签应走面板字典(此前 SW 硬编码中文
// displayName 泄漏到英文 UI)。用法: pnpm build && node tests/probe-en-tools.mjs
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync, rmSync } from "fs";
import { launchWithCdp, sse } from "./lib-cdp-mock.mjs";
import { zh, en } from "./lib-i18n.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(__dirname, "..", "dist");
const USER_DATA_DIR = "/tmp/verify-en-profile";
const OUT = "/tmp/tars-en";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

rmSync(USER_DATA_DIR, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const { browser, extId, mock } = await launchWithCdp({
  extDir: EXT_DIR,
  userDataDir: USER_DATA_DIR,
});
const page = await browser.newPage({ deviceScaleFactor: 2 });
await page.setViewportSize({ width: 420, height: 740 });
await page.goto(`chrome-extension://${extId}/sidepanel.html`);
await sleep(600);

const ok = (cond, label) => {
  if (!cond) throw new Error(`❌ ${label}`);
  console.log(`  ✅ ${label}`);
};
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

// 第一轮 page_outline(本地只读工具,不依赖网络),第二轮纯文本作答
let usedTool = false;
await mock.setRoutes([
  {
    match: (url) => url.includes("/chat/completions"),
    handle: async (ctx) => {
      if (!usedTool) {
        usedTool = true;
        return toolCallSSE(ctx, "call_1", "page_outline", {});
      }
      return answerSSE(ctx, "Done. Tool labels are localized.");
    },
  },
]);

await page.evaluate(() =>
  chrome.storage.local.set({
    apiKey: "sk-test",
    model: "gpt-test",
    baseUrl: "https://api.test.example.com/v1",
    models: [{ id: "gpt-test" }],
    locale: "en-US",
  }),
);
await page.reload();
await sleep(800);

const input = page.locator(`textarea[aria-label="${en.chat.askInput}"]`);
await input.fill("outline this page");
await page.locator(`button[aria-label="${en.chat.send}"]`).click();
await page
  .locator(`button[aria-label="${en.chat.send}"]`)
  .waitFor({ state: "visible", timeout: 30000 });
await sleep(500);

const ranFor = en.chat.trace.stepsMeta.split("{dur}")[0].trim();
ok(
  (await page.getByText(en.chat.tool.pageOutline).count()) > 0,
  "工具行标签为英文(chat.tool.pageOutline)",
);
ok(
  (await page.getByText(zh.chat.tool.pageOutline).count()) === 0,
  "无中文名泄漏(zh.chat.tool.pageOutline)",
);
ok((await page.getByText(ranFor).count()) > 0, "折叠摘要为英文(chat.trace.stepsMeta)");
await page.locator(".trace-summary").first().click();
await sleep(400);
ok(
  await page.getByText(en.chat.tool.pageOutline).first().isVisible(),
  "展开后工具行可见且为英文",
);
await page.screenshot({ path: `${OUT}/1-trace-en.png` });
console.log("\n✅ VERDICT: PASS — 截图在 /tmp/tars-en/");
await browser.close();
