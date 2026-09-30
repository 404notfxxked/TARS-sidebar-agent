// 探针:焦点与滚动体验细节 —— 打开面板 autofocus / 悬浮层关闭焦点回归 /
// 运行中输入框可编辑 / 「回到最新」悬浮钮 / 模型选择键盘导航 / 历史搜索 autofocus。
// 用法: pnpm build && node tests/probe-focus.mjs
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync, rmSync } from "fs";
import {
  launchWithCdp,
  ask,
  openPanel,
  scrollProbe,
  sleep,
  sse,
} from "./lib-cdp-mock.mjs";
import { zh } from "./lib-i18n.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(__dirname, "..", "dist");
const USER_DATA_DIR = "/tmp/probe-focus-profile";
const OUT = "/tmp/tars-focus";

rmSync(USER_DATA_DIR, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const { browser, extId, mock } = await launchWithCdp({
  extDir: EXT_DIR,
  userDataDir: USER_DATA_DIR,
});
const page = await openPanel(browser, extId, { deviceScaleFactor: 2 });
await page.setViewportSize({ width: 420, height: 740 });

const ok = (cond, label) => {
  if (!cond) throw new Error(`❌ ${label}`);
  console.log(`  ✅ ${label}`);
};
const activeLabel = () =>
  page.evaluate(() =>
    document.activeElement?.getAttribute("aria-label") ??
    document.activeElement?.tagName ??
    "none",
  );

// ---- 长回复 + 1.2s 延迟:撑出滚动,并留出「运行中输入」观察窗 ----
await mock.setRoutes([
  {
    match: (url) => url.includes("/chat/completions"),
    handle: async (ctx) => {
      const body = JSON.parse(ctx.params.request.postData ?? "{}");
      const lastUser = [...(body.messages ?? [])]
        .reverse()
        .find((m) => m.role === "user");
      const raw = String(lastUser?.content ?? "");
      const inner = raw.match(/<user-request>([\s\S]*?)<\/user-request>/);
      const head = (inner ? inner[1] : raw).trim().slice(0, 20);
      const reply = Array.from(
        { length: 18 },
        (_, i) =>
          `**${head} · 段 ${i + 1}**:这一段故意写得很长,用来把消息列表撑出滚动条,验证「回到最新」悬浮钮的出现与回底行为,顺带观察近底跟随是否稳定。`,
      ).join("\n\n");
      await ctx.delay(1200);
      await ctx.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body: sse(
          { choices: [{ delta: { content: reply } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ),
      });
    },
  },
]);

// ---- 富配置:两个供应商三个模型(键盘导航需要多选项) ----
await page.evaluate(() =>
  chrome.storage.local.set({
    apiKey: "sk-test",
    modelProvider: "p1",
    model: "m1",
    providers: [
      {
        id: "p1",
        name: "Provider One",
        baseUrl: "https://p1.test/v1",
        apiKey: "sk-test",
        models: [{ id: "m1" }, { id: "m2" }],
      },
      {
        id: "p2",
        name: "Provider Two",
        baseUrl: "https://p2.test/v1",
        apiKey: "sk-test",
        models: [{ id: "n1", alias: "Nice One" }],
      },
    ],
  }),
);
await page.reload();
await sleep(800);

// ---- A. 打开面板:输入框自动聚焦 ----
console.log("\nA. 打开面板 autofocus");
ok((await activeLabel()) === zh.chat.askInput, "面板打开输入框即聚焦");

// ---- B. 两轮长回复 → 列表可滚 ----
console.log("\nB. 长回复撑出滚动");
// 滚动几何探针唯一实现在 lib scrollProbe(类名策略选容器,聊天列表同用)
const listState = () => scrollProbe(page);
await ask(page, "第一问");
await ask(page, "第二问");
const st = await listState();
ok(st.innerHeight > st.innerClient + 100, `列表已可滚动(h=${st.innerHeight})`);
await page.screenshot({ path: `${OUT}/1-scrolled.png` });

// ---- C. 回到最新悬浮钮 ----
console.log("\nC. 回到最新悬浮钮");
const pill = page.locator(`button[aria-label="${zh.chat.jumpLatest}"]`);
ok((await pill.count()) === 0, "贴底时按钮不出现");
await page.evaluate(() => {
  const el = [...document.querySelectorAll(".overflow-y-auto")].at(-1);
  if (el) el.scrollTop = 0;
});
await sleep(250);
ok(await pill.isVisible(), "上翻回看后按钮出现");
await page.screenshot({ path: `${OUT}/2-pill.png` });
await pill.click();
// headless 下平滑滚动偶发停滞/偏慢,轮询等待到底(最长 ~3s)
let st2 = await listState();
for (let i = 0; i < 20; i++) {
  if (st2.innerHeight - st2.innerBottom < 40) break;
  await sleep(150);
  st2 = await listState();
}
ok(
  st2.innerHeight - st2.innerBottom < 40,
  `点击后平滑滚回底部(${JSON.stringify(st2)})`,
);
ok((await pill.count()) === 0, "贴底后按钮消失");

// ---- D. 运行中输入框可编辑 ----
console.log("\nD. 运行中可预打下一问");
const input = page.locator(`textarea[aria-label="${zh.chat.askInput}"]`);
await input.fill("第三问");
await page.locator(`button[aria-label="${zh.chat.send}"]`).click();
await sleep(400); // 已发出,回复还有 ~800ms
ok(await input.isEnabled(), "运行中输入框未被禁用");
await input.fill("运行中预打的下一问");
ok((await input.inputValue()) === "运行中预打的下一问", "等待期间可预打文本");
await page
  .locator(`button[aria-label="${zh.chat.stop}"]`)
  .waitFor({ state: "detached", timeout: 30000 });
await sleep(300);
await input.press("Enter"); // run 结束后 Enter 正常发送
await page
  .locator(`button[aria-label="${zh.chat.stop}"]`)
  .waitFor({ state: "detached", timeout: 30000 });
await sleep(300);
const echoed = await page
  .getByText("运行中预打的下一问", { exact: true })
  .first()
  .isVisible()
  .catch(() => false);
ok(echoed, "预打的下一问在收口后成功发出");
await page.screenshot({ path: `${OUT}/3-run-typing.png` });

// ---- E. 设置页关闭 → 焦点回归输入框 ----
console.log("\nE. 悬浮层焦点回归");
await page.locator(`button[aria-label="${zh.chat.openSettings}"]`).click();
await sleep(300);
await page.keyboard.press("Escape");
await sleep(250);
ok((await activeLabel()) === zh.chat.askInput, "关设置后焦点回输入框");

// ---- F. 历史页:搜索框 autofocus + 关闭回归 ----
console.log("\nF. 历史页搜索框");
await page.locator(`button[aria-label="${zh.chat.openSessions}"]`).click();
await page.locator(`h2:has-text("${zh.sessions.title}")`).waitFor({ timeout: 5000 });
const searchFocused = await page.evaluate(
  // 字典值经参数传入浏览器上下文(evaluate 回调里看不到 Node 侧的 zh)
  (placeholder) =>
    document.activeElement?.tagName === "INPUT" &&
    document.activeElement?.getAttribute("aria-label") === placeholder,
  zh.sessions.searchPlaceholder,
);
ok(searchFocused, "历史页搜索框自动聚焦");
await page.screenshot({ path: `${OUT}/4-sessions.png` });
await page.keyboard.press("Escape");
await sleep(250);
ok((await activeLabel()) === zh.chat.askInput, "关历史页后焦点回输入框");

// ---- G. 模型选择键盘导航 ----
console.log("\nG. 模型选择键盘导航");
const desc = () =>
  page.evaluate(() =>
    document.querySelector('[role="listbox"]')?.getAttribute("aria-activedescendant"),
  );
const pill_ = page.locator(`button[aria-label="${zh.chat.selectModel}"]`);
await pill_.click();
await sleep(150);
ok((await desc()) === "mp-opt-0", "打开时高亮停在当前选中(m1)");
await page.keyboard.press("ArrowDown");
ok((await desc()) === "mp-opt-1", "↓ 移动高亮(m2)");
await page.keyboard.press("End");
ok((await desc()) === "mp-opt-2", "End 跳到末项(n1)");
await page.screenshot({ path: `${OUT}/5-model-kbd.png` });
await page.keyboard.press("Enter");
await sleep(200);
ok(
  (await pill_.innerText()).includes("Nice One"),
  "Enter 选中高亮模型(显示 alias)",
);
await pill_.click();
await sleep(150);
ok((await desc()) === "mp-opt-2", "重开高亮落在当前选中");
await page.keyboard.press("ArrowUp");
await page.keyboard.press("Tab");
await sleep(200);
ok(
  !(await page.evaluate(() => !!document.querySelector('[role="listbox"]'))),
  "Tab 选中并关闭弹层",
);
ok(
  !(await pill_.innerText()).includes("Nice One"),
  "Tab 路径选中了 m2(alias 消失)",
);
await pill_.click();
await sleep(150);
await page.keyboard.press("Escape");
await sleep(150);
ok(
  !(await page.evaluate(() => !!document.querySelector('[role="listbox"]'))),
  "Esc 关闭弹层",
);

console.log("\n✅ VERDICT: PASS — 截图在 /tmp/tars-focus/");
await browser.close();
