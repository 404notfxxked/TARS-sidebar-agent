// 验证 run 结束通知的确定性路径(REQ-P0-5 notify 域)
// 用法: pnpm build && node tests/verify-notify.mjs
//
// 场景:
//   N1 显式关闭:notifyDone=false → run 正常结束,不产生任何通知
//   N2 开关开启:期望值从实测判据推出(自洽断言,环境无关)——
//      面板可见 ∧ 窗口持焦 ⇒ 决策正确地抑制(0);否则 ⇒ 通知产生(1)
//   N3 取消不打扰:基线相对,取消的 run 不新增通知
//
// 边界说明(2026-10-06 评审修正):本套件不再押注焦点分支的环境表现——
// xvfb/CI 无窗口管理器(focused 恒 false)与真实桌面(可持焦)都能绿:
// N2 先读 visibilityState 与 getLastFocused().focused,按与
// src/background/notify.ts shouldNotifyRunEnd 相同的规则算期望。
// 焦点分支的语义细节仍由 notify.test.ts 单测钉住;真机焦点行为依赖人工验证。
// 观测手法:chrome.notifications.getAll 自面板页求值(扩展页上下文),
// 通知在无头/无 WM 环境照常入册,只是无 OS 展示。

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  launchWithCdp,
  ask,
  makeChecker,
  openPanel,
  pollUntil,
  seedProviders,
  sse,
  waitForRunLog,
} from "./lib-cdp-mock.mjs";
import { zh } from "./lib-i18n.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(__dirname, "..", "dist");
const USER_DATA_DIR = `/tmp/verify-notify-${Date.now()}`;

const check = makeChecker();

const { browser, extId, mock } = await launchWithCdp({
  extDir: EXT_DIR,
  userDataDir: USER_DATA_DIR,
});
console.log("✅ 扩展:", extId);

let hang = false;
mock.setRoutes([
  {
    match: (url) => url.includes("/chat/completions"),
    handle: async (ctx) => {
      if (hang) {
        // N3 用:响应挂住,给取消留窗口(取消后 SW abort,fetch 竞态在 lib 层吸收)
        await new Promise(() => {});
      }
      return ctx.fulfill({
        headers: { "Content-Type": "text/event-stream" },
        body: sse(
          { choices: [{ delta: { content: "答" } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ),
      });
    },
  },
]);

const sidepanel = await openPanel(browser, extId, {
  configure: (p) => seedProviders(p, [{ id: "gpt-t" }]),
});

const notificationCount = async () =>
  sidepanel.evaluate(
    () =>
      new Promise((r) => chrome.notifications.getAll((ids) => r(Object.keys(ids).length))),
  );
const setNotifyDone = (on) =>
  sidepanel.evaluate(
    (v) => chrome.storage.local.set({ notifyDone: v }),
    on,
  );

// ---- N1 显式关闭 ----
console.log("\nN1 notifyDone=false:run 结束无通知");
{
  await setNotifyDone(false);
  await ask(sidepanel, "第一问");
  await waitForRunLog(sidepanel, (e) => e.msg === "run ended", "N1 run ended");
  // 负向断言:通知创建是 run 收口后的异步尾,轮询确认它稳定不出现
  await pollUntil(notificationCount, (n) => n === 0, "N1 无通知", 3_000);
  const n = await notificationCount();
  check(n === 0, "开关关闭时 run 结束不产生通知", `n=${n}`);
}

// ---- N2 开关开启(自洽断言,环境无关)----
console.log("\nN2 开关开启:按实测判据定期望(可见+持焦 ⇒ 抑制;否则 ⇒ 通知)");
{
  await setNotifyDone(true);
  await ask(sidepanel, "第二问");
  await waitForRunLog(sidepanel, (e) => e.msg === "run ended", "N2 run ended");
  // 判据可观测,期望值从观测推出而不是押注环境:xvfb/CI 无窗口管理器时
  // focused 恒 false → 期望 1;真实桌面窗口持焦 → 期望 0(决策正确地抑制)。
  // 与 src/background/notify.ts 的 shouldNotifyRunEnd 同一规则(aborted=false)
  const hidden = await sidepanel.evaluate(() => document.visibilityState === "hidden");
  const focused = await sidepanel.evaluate(
    () => new Promise((r) => chrome.windows.getLastFocused((w) => r(!!w.focused))),
  );
  const expected = hidden || !focused ? 1 : 0;
  const n = await pollUntil(
    notificationCount,
    (v) => v === expected,
    `N2 通知数==${expected}`,
  );
  check(
    n === expected,
    `通知数符合判据(hidden=${hidden}, focused=${focused} → 期望 ${expected})`,
    `n=${n}`,
  );
}

// ---- N3 取消不打扰(基线相对,不依赖 N2 产生了通知)----
console.log("\nN3 用户取消的 run 不发通知");
{
  const baseline = await notificationCount();
  hang = true;
  const input = sidepanel.locator(`textarea[aria-label="${zh.chat.askInput}"]`);
  await input.fill("第三问(会挂住)");
  await sidepanel.locator(`button[aria-label="${zh.chat.send}"]`).click();
  // 翻成停止钮即 run 在途,取消
  const stop = sidepanel.locator(`button[aria-label="${zh.chat.stop}"]`);
  await stop.waitFor({ state: "visible", timeout: 10_000 });
  await stop.click();
  await waitForRunLog(sidepanel, (e) => e.msg === "run ended", "N3 run ended");
  hang = false;
  // 负向断言:取消的 run 不新增通知(基线相对,与 N2 是否发过通知无关)
  await pollUntil(
    notificationCount,
    (v) => v === baseline,
    `N3 通知数不增(基线 ${baseline})`,
    3_000,
  );
  const n = await notificationCount();
  check(n === baseline, "取消的 run 不新增通知", `baseline=${baseline} n=${n}`);
}

console.log(`\n结果: ${check.failures.length} 条断言失败`);
await browser.close();
process.exit(check.failures.length > 0 ? 1 : 0);
