// 验证权限拒绝路径与生产注入路径(权限模型此前零覆盖的缺口)
// 用法: pnpm build && node tests/run.mjs host-access
//
// 生产形态是「安装零授权 + 按需授权」,但授权弹窗无法自动化(见
// tests/lib-cdp-mock.mjs 头注与 tests/README「e2e 不覆盖什么」),本套件
// 用两个 flavor 夹出判定路径的两端:
//   HA1(zero flavor,页面域零授权):find_elements 在注入前被权限门拦下,
//      工具结果带可行动指引(pageAccessHint),run 正常收口 —— 拒绝不是崩,
//      模型能把指引转告用户
//   HA2(zero flavor):web_fetch 同一条门(hasOriginAccess),未授权给出
//      「设置 → 安全」指引
//   HA3(dynamic flavor,全站授权但无静态 content script):同一条
//      find_elements 链路成功 —— 走的是生产唯一的注入路径(sendMessage 失败
//      → executeScript 注入 → 重试),这条路径在既有套件里从未被执行过
//
// 断言手段:mock LLM 的 wire 抓包(工具消息内容)+ runAskViaPort 的收口事件。

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  injectTestConfig,
  launchWithCdp,
  makeChecker,
  runAskViaPort,
  sse,
} from "./lib-cdp-mock.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(__dirname, "..", "dist");

const check = makeChecker();
const assert = (name, cond, detail = "") => check(cond, `  ${name}`, detail);

// 目标页:一个可被 find_elements 观察的普通页面
const PAGE_HTML = `<html><head><meta charset="utf-8"></head>
<body style="margin:0;font-family:sans-serif">
  <button id="go">开始按钮 Go Button</button>
  <a href="#more">更多链接 More Link</a>
</body></html>`;

let lastAgentBody = null;
/** 当前场景让模型先调的工具(find | fetch),工具往返后终答 */
let mode = "find";

/** 注册 mock 路由:目标页 + LLM(按 mode 先调一个工具,往返后终答) */
function registerRoutes(mock) {
  mock.setRoutes([
    {
      match: (url) => url.includes("mock.test/hello"),
      handle: async (ctx) =>
        ctx.fulfill({
          status: 200,
          headers: { "Content-Type": "text/html" },
          body: PAGE_HTML,
        }),
    },
    {
      match: (url) => url.includes("/chat/completions"),
      handle: async (ctx) => {
        const body = JSON.parse(ctx.params.request.postData ?? "{}");
        lastAgentBody = body;
        const msgs = body.messages ?? [];
        const lastUserIdx = msgs.map((m) => m.role).lastIndexOf("user");
        const usedTool = msgs
          .slice(lastUserIdx + 1)
          .some((m) => m.role === "tool");
        if (!usedTool) {
          const call =
            mode === "find"
              ? { name: "find_elements", arguments: JSON.stringify({}) }
              : {
                  name: "web_fetch",
                  arguments: JSON.stringify({ url: "https://mock.test/hello" }),
                };
          return ctx.fulfill({
            headers: { "Content-Type": "text/event-stream" },
            body: sse(
              {
                choices: [
                  {
                    delta: {
                      role: "assistant",
                      tool_calls: [
                        {
                          index: 0,
                          id: `call_${Math.random().toString(36).slice(2, 8)}`,
                          type: "function",
                          function: call,
                        },
                      ],
                    },
                  },
                ],
              },
              { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
            ),
          });
        }
        return ctx.fulfill({
          headers: { "Content-Type": "text/event-stream" },
          body: sse(
            { choices: [{ delta: { content: "HOST_OK" } }] },
            { choices: [{ delta: {}, finish_reason: "stop" }] },
          ),
        });
      },
    },
  ]);
}

/** 开面板 → 注入配置 → 打开目标页(target 最后开 = 活动 tab,
 *  find_elements 的 tabId 解析由此落点) */
async function startPanel(browser, extId) {
  const panel = await browser.newPage();
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
  await injectTestConfig(panel);
  await panel.reload();
  await new Promise((r) => setTimeout(r, 800));
  const target = await browser.newPage();
  await target.goto("https://mock.test/hello", { waitUntil: "load" });
  await new Promise((r) => setTimeout(r, 300));
  return panel;
}

/** 最后一条 tool 消息的内容(工具错误/结果都走这里回给模型) */
const lastToolContent = () => {
  const msgs = lastAgentBody?.messages ?? [];
  return [...msgs].reverse().find((m) => m.role === "tool")?.content ?? "";
};

let scene = null;
try {
  // ---- HA1/HA2:zero flavor 的拒绝路径 ----
  scene = "HA1/HA2 零授权拒绝 + 指引";
  console.log("\n===== HA1/HA2. 零授权:拒绝 + 可行动指引 =====");
  const zero = await launchWithCdp({
    extDir: EXT_DIR,
    userDataDir: `/tmp/verify-host-access-zero-${Date.now()}`,
    flavor: "zero",
  });
  console.log("✅ 扩展(zero):", zero.extId);
  try {
    registerRoutes(zero.mock);
    const panel = await startPanel(zero.browser, zero.extId);

    mode = "find";
    const done1 = await runAskViaPort(panel, "ha1", "看看这个页面上有什么");
    assert("拒绝路径 run 正常收口(agent_done)", done1.type === "agent_done", done1.type);
    const hint1 = lastToolContent();
    assert(
      "find_elements 被权限门拦下,指引含目标 origin 与安全页入口",
      hint1.includes("尚未获得") &&
        hint1.includes("的站点访问授权") &&
        hint1.includes("设置 → 安全"), // i18n-ok SW 侧面向模型的文案,不经字典(硬规则 16)
      hint1.slice(0, 220),
    );

    mode = "fetch";
    // 消息带显式 URL:命中来源域白名单,不被确认门拦(否则 fresh 会话
    // 白名单为空,先弹确认卡挂满 120s)—— 由此直达 web_fetch 的授权门
    const done2 = await runAskViaPort(panel, "ha2", "读一下 https://mock.test/hello");
    assert("web_fetch 拒绝路径 run 正常收口", done2.type === "agent_done", done2.type);
    const hint2 = lastToolContent();
    assert(
      "web_fetch 未授权指引明确(域 + 安全页入口)",
      hint2.includes("web_fetch 需要访问") &&
        hint2.includes("的授权") &&
        hint2.includes("设置 → 安全"), // i18n-ok SW 侧面向模型的文案,不经字典(硬规则 16)
      hint2.slice(0, 220),
    );
  } finally {
    await zero.browser.close();
  }

  // ---- HA3:dynamic flavor 的生产注入路径 ----
  scene = "HA3 授权态生产注入路径";
  console.log("\n===== HA3. 授权态(无静态 content script):生产注入路径 =====");
  const dyn = await launchWithCdp({
    extDir: EXT_DIR,
    userDataDir: `/tmp/verify-host-access-dyn-${Date.now()}`,
    flavor: "dynamic",
  });
  console.log("✅ 扩展(dynamic):", dyn.extId);
  try {
    registerRoutes(dyn.mock);
    const panel = await startPanel(dyn.browser, dyn.extId);
    mode = "find";
    const done3 = await runAskViaPort(panel, "ha3", "看看这个页面上有什么");
    assert("生产注入路径 run 正常收口", done3.type === "agent_done", done3.type);
    const result3 = lastToolContent();
    assert(
      "find_elements 经按需注入真实执行(元素文本来自目标页)",
      result3.includes("Go Button") || result3.includes("开始按钮"),
      result3.slice(0, 220),
    );
  } finally {
    await dyn.browser.close();
  }
} catch (err) {
  check(false, `场景「${scene ?? "初始化"}」执行异常`, err.stack ?? String(err));
}

console.log("\n========================================");
if (check.failures.length > 0) {
  console.log("❌ VERDICT: FAIL —", check.failures.join("; "));
  process.exit(1);
}
console.log("✅ VERDICT: PASS");
process.exit(0);
