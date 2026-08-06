// 验证停止按钮链路
// 用法: npm run build && node scripts/verify-cancel.mjs

import { chromium } from "playwright";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(__dirname, "..", "dist");
const logs = [];

const browser = await chromium.launchPersistentContext(
  "/tmp/verify-cancel-" + Date.now(),
  {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
    ],
    viewport: { width: 1400, height: 900 },
  }
);

// 捕获所有页面的 console（包括 SW 调试页）
browser.on("page", (p) => {
  p.on("console", (msg) => {
    const t = msg.text();
    if (t.includes("[")) logs.push(t);
  });
});

// 等 SW 启动
await new Promise((r) => setTimeout(r, 3000));

// 拿扩展 ID
const workers = browser.serviceWorkers();
let extId = "";
for (const sw of workers) {
  const m = sw.url().match(/chrome-extension:\/\/([^/]+)\//);
  if (m) { extId = m[1]; break; }
}
if (!extId) {
  for (const bp of browser.backgroundPages()) {
    const m = bp.url().match(/chrome-extension:\/\/([^/]+)\//);
    if (m) { extId = m[1]; break; }
  }
}
if (!extId) {
  console.error("❌ 找不到扩展 ID");
  await browser.close();
  process.exit(1);
}
console.log("✅ 扩展:", extId);

// 拦截 LLM API —— 延迟 5s 给停止按钮留窗口
await browser.route("**/v1/**", async (route) => {
  console.log("[test] 拦截 API");
  await new Promise((r) => setTimeout(r, 5000));
  try {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "mock",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "mock" } }],
      }),
    });
    console.log("[test] API 响应完成");
  } catch {
    console.log("[test] API 响应失败（可能已被 abort）");
  }
});

// 打开 sidepanel
const sidepanel = await browser.newPage();
await sidepanel.goto(`chrome-extension://${extId}/sidepanel.html`);
await new Promise((r) => setTimeout(r, 1500));

// 注入假 API Key
await sidepanel.evaluate(() =>
  chrome.storage.local.set({
    apiKey: "sk-test",
    provider: "openai",
    model: "gpt-test",
    baseUrl: "https://api.test.example.com",
  })
);
console.log("🔑 已注入假 Key");
await sidepanel.reload();
await new Promise((r) => setTimeout(r, 1000));

// 打开 SW 调试页以捕获其 console
const swPage = await browser.newPage();
await swPage.goto(`chrome-extension://${extId}/background.js`);
await new Promise((r) => setTimeout(r, 500));

// 输入并发送
const input = sidepanel.locator('input[aria-label="提问"]');
await input.waitFor({ timeout: 5000 });
await input.fill("测试");
console.log("📤 发送...");
await sidepanel.locator('button[aria-label="发送"]').click();

// 等停止按钮
console.log("⏳ 等待停止按钮...");
await sidepanel.locator('button[aria-label="停止"]').waitFor({ timeout: 10000 });
console.log("🛑 点停止...");
await new Promise((r) => setTimeout(r, 500));
await sidepanel.locator('button[aria-label="停止"]').click();
console.log("🛑 已点击");

// 等 agent 退出并恢复 idle
await new Promise((r) => setTimeout(r, 3000));

// 检查发送按钮是否恢复
const sendBack = await sidepanel
  .locator('button[aria-label="发送"]')
  .isVisible()
  .catch(() => false);

// 结果
console.log("\n=== Console 日志 ===");
for (const l of logs) console.log(" ", l);

const full = logs.join("\n");

const checks = [
  ["[agent] run started", "后台收到 USER_MESSAGE"],
  ["[chat] agent started, sessionId:", "前端收到 sessionId（非空）"],
  ["[chat] cancel clicked", "前端点取消"],
  ["[agent] cancel requested", "后台收到 CANCEL_RUN"],
  ["found — aborting", "后台找到 session 执行 abort"],
  ["aborted by user", "agent 检测到 abort 信号"],
  ["[agent] run ended", "后台 finally 清理"],
];

console.log("\n=== 链路 ===");
let allPass = true;
for (const [pat, label] of checks) {
  const ok = full.includes(pat);
  console.log(ok ? "✅" : "❌", label);
  if (!ok) allPass = false;
}
if (sendBack) {
  console.log("✅ 发送按钮已恢复（前端状态已重置）");
} else {
  console.log("❌ 发送按钮未恢复（前端仍卡住）");
  allPass = false;
}

await browser.close();

if (!allPass) {
  console.log("\n❌ VERDICT: FAIL");
  process.exit(1);
}
console.log("\n✅ VERDICT: PASS");
process.exit(0);
