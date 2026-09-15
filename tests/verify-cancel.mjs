// 验证停止按钮链路(取消 → abort → agent 静默退出 → UI 复位)
// 用法: pnpm build && node tests/verify-cancel.mjs
//
// (2026-08 重写)旧版靠「打开 SW 调试页捕获 console」取日志、Playwright
// context.route 拦截 LLM 请求 —— 前者在当前 Playwright 下捕获不到 SW 日志,
// 后者拦不到扩展 SW 发起的 organic fetch,双双失效。改用:
//   - CDP Fetch 域直连 SW target 拦截网络(见 lib-cdp-mock.mjs)
//   - 环形日志 chrome.storage(log:bg / log:panel)做结构化断言
// 链路:USER_MESSAGE → agent 运行(LLM 请求被 mock 延迟 8s)→ 点停止
//       → CANCEL_RUN → abort 中断 fetch → agent 静默退出 → 发送按钮恢复

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  launchWithCdp,
  injectTestConfig,
  readLogs,
  sse,
} from "./lib-cdp-mock.mjs";
import { zh } from "./lib-i18n.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(__dirname, "..", "dist");
const USER_DATA_DIR = `/tmp/verify-cancel-${Date.now()}`;

const { browser, extId, mock } = await launchWithCdp({ extDir: EXT_DIR, userDataDir: USER_DATA_DIR });
console.log("✅ 扩展:", extId);

// LLM mock:首次请求挂起 8s,给「点停止」留窗口;abort 后这次 fulfill 会失败(lib 内已捕获)
mock.setRoutes([
  {
    match: (url) => url.includes("/chat/completions"),
    handle: async (ctx) => {
      console.log("[test] LLM 请求已拦截,挂起 8s");
      await ctx.delay(8000);
      await ctx.fulfill({
        headers: { "Content-Type": "text/event-stream" },
        body: sse(
          { choices: [{ delta: { content: "mock" } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ),
      });
    },
  },
]);
console.log("✅ CDP Fetch 拦截已就绪(轮询挂载扩展全部上下文 target)");

// 面板 + 配置
const sidepanel = await browser.newPage();
await sidepanel.goto(`chrome-extension://${extId}/sidepanel.html`);
await new Promise((r) => setTimeout(r, 1000));
await injectTestConfig(sidepanel);
console.log("🔑 已注入假 Key");
await sidepanel.reload();
await new Promise((r) => setTimeout(r, 1500));

// 发送 → 等停止按钮出现 → 点停止
const since = Date.now() - 500;
const input = sidepanel.locator(`textarea[aria-label="${zh.chat.askInput}"]`);
await input.waitFor({ timeout: 5000 });
await input.fill("测试");
console.log("📤 发送...");
await sidepanel.locator(`button[aria-label="${zh.chat.send}"]`).click();
console.log("⏳ 等待停止按钮...");
await sidepanel.locator(`button[aria-label="${zh.chat.stop}"]`).waitFor({ timeout: 10000 });
console.log("🛑 点停止...");
await sidepanel.locator(`button[aria-label="${zh.chat.stop}"]`).click();

// 等 agent 退出并恢复 idle
await sidepanel.locator(`button[aria-label="${zh.chat.send}"]`).waitFor({ state: "visible", timeout: 15000 });
await new Promise((r) => setTimeout(r, 1000));

// ---- 断言(环形日志)----
const entries = await readLogs(sidepanel, since);
const find = (prefixRe, msgRe, data = null) =>
  entries.find((e) => prefixRe.test(`${e.ctx}/${e.tag}`) && msgRe.test(e.msg) && (!data || data(e)));
const checks = [
  ["[bg/agent] run started", "后台收到 USER_MESSAGE",
    find(/bg\/agent/, /run started/)],
  ["[panel/chat] cancel clicked", "前端点取消",
    find(/panel\/chat/, /cancel clicked/)],
  ["[bg/agent] cancel requested(found)", "后台收到 CANCEL_RUN 且找到 session",
    find(/bg\/agent/, /cancel requested/, (e) => /"found":true/.test(e.data ?? "{}"))],
  ["[bg/agent] aborted by user", "agent 检测到 abort 信号",
    find(/bg\/agent/, /aborted by user/)],
  ["[bg/agent] run ended", "后台 finally 清理",
    find(/bg\/agent/, /run ended/)],
];

console.log("\n=== 链路 ===");
let allPass = true;
for (const [pat, label, hit] of checks) {
  const ok = !!hit;
  console.log(ok ? "✅" : "❌", label, ok ? "" : `(${pat})`);
  if (!ok) allPass = false;
}
const sendBack = await sidepanel.locator(`button[aria-label="${zh.chat.send}"]`).isVisible().catch(() => false);
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
