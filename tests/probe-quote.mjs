// 探针:每日一句交互与设置——
// ① 稳定性:缓存 miss(API 延迟)时挂载中文案不跳变,补抓后重挂载切到 API 句;
// ② 出处悬停显形(rest opacity 0 → hover 1);
// ③ 设置 → 外观「每日一句」开关:关 → 空态无 quote,重载持久化,再开恢复。
// 用法: pnpm build && node tests/probe-quote.mjs
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync, rmSync } from "fs";
import { launchWithCdp, sse } from "./lib-cdp-mock.mjs";
import { zh } from "./lib-i18n.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(__dirname, "..", "dist");
const USER_DATA_DIR = "/tmp/probe-quote-profile";
const OUT = "/tmp/tars-quote";
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
const hitokotoBody = () =>
  JSON.stringify({
    hitokoto: "API_DELAYED_QUOTE",
    from: "延迟测试",
    from_who: null,
    uuid: "75a45fd4-4f2f-45eb-80cb-6f0a7bcdfaf2",
  });

// 一言延迟 2.5s 回:模拟 API 延迟(用户报告过的跳变场景)
const LLM_SSE = () =>
  sse(
    { choices: [{ delta: { content: "好" } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  );
await mock.setRoutes([
  {
    match: (url) => url.includes("/chat/completions"),
    handle: async (ctx) =>
      ctx.fulfill({
        headers: { "Content-Type": "text/event-stream" },
        body: LLM_SSE(),
      }),
  },
  {
    match: (url) => url.includes("hitokoto"),
    handle: async (ctx) => {
      await ctx.delay(2500);
      return ctx.fulfill({
        headers: { "Content-Type": "application/json" },
        body: hitokotoBody(),
      });
    },
  },
]);

await page.evaluate(() =>
  chrome.storage.local.set({
    apiKey: "sk-test",
    model: "gpt-test",
    baseUrl: "https://api.test.example.com/v1",
    models: [{ id: "gpt-test" }],
  }),
);
await page.reload();
await sleep(800);

// ── ① 挂载稳定性:缓存 miss 下 3s 采样同一条,不跳变 ──
const quoteText = () =>
  page.evaluate(
    () =>
      [...document.querySelectorAll(".quote-text")].map((p) => p.textContent)[0] ??
      null,
  );
const first = await quoteText();
ok(first !== null, "空态有每日一句");
let stable = true;
for (let i = 0; i < 3; i++) {
  await sleep(1000); // 1s/2s/3s 各采一次
  if ((await quoteText()) !== first) stable = false;
}
ok(stable, `挂载中不跳变(始终「${(first ?? "").slice(0, 14)}…」)`);
ok(!first.includes("API_DELAYED_QUOTE"), "缓存 miss 时用的是本地池句(API 未到)");

// ── ② 出处悬停显形 ──
const sourceOpacity = () =>
  page.evaluate(() => {
    const el = document.querySelector(".quote-source");
    return el ? getComputedStyle(el).opacity : null;
  });
ok((await sourceOpacity()) === "0", "出处默认隐藏(opacity 0)");
await page.locator(".quote-block").hover();
await sleep(400);
ok((await sourceOpacity()) === "1", "悬停后出处显形(opacity 1)");

// 「来自 <源名>」署名只对网络来源显示:此刻展示的是本地池播种条,不许标来源
// —— 面板靠 quote.src 判断而非「有没有 from」(本地池同样有 from),错标即假署名
const viaPrefix = zh.chat.quoteVia.split("{")[0];
ok(
  await page.evaluate(
    () => document.querySelector(".quote-source a") === null,
  ),
  "本地池句不标来源(不给自家内容错标)",
);

// ── 补抓完成(>2.5s 已过),触发重挂载:发一句 → 新对话 ──
await page.locator(`textarea[aria-label="${zh.chat.askInput}"]`).fill("hi");
await page.locator(`button[aria-label="${zh.chat.send}"]`).click();
await page
  .locator(`button[aria-label="${zh.chat.send}"]`)
  .waitFor({ state: "visible", timeout: 30000 });
await sleep(400);
await page.locator(`button[aria-label="${zh.chat.newChat}"]`).click();
await sleep(600);
ok(
  (await quoteText())?.includes("API_DELAYED_QUOTE") === true,
  "补抓落盘后重挂载切到 API 句",
);
ok((await sourceOpacity()) === "0", "重挂载出处同样默认隐藏");

// 此刻展示的是 API 句:署名行应带「来自 一言」+ 回链(一言官方的请求,见 README 致谢)
const credit = await page.evaluate(() => {
  const a = document.querySelector(".quote-source a");
  return a ? { text: a.textContent, href: a.getAttribute("href") } : null;
});
ok(credit !== null, "API 句署名带链接");
ok(credit?.text === "一言", "署名显示内容源名");
ok(
  credit?.href === "https://hitokoto.cn/?uuid=75a45fd4-4f2f-45eb-80cb-6f0a7bcdfaf2",
  "署名回链到该句页面(uuid 溯源,该服务官方建议的方式)",
);
const sourceLine = await page.evaluate(
  () => document.querySelector(".quote-source")?.textContent ?? "",
);
ok(sourceLine.includes(viaPrefix), `署名行含「${viaPrefix.trim()}」`);
// 层级:署名链接要比出处轻一档(否则「作者」与「来源」糊成一团),
// 且下划线常显 —— 本行只在悬停时可见,「常显」即「露出时就知道能点」
const quoteStyle = await page.evaluate(() => {
  const p = document.querySelector(".quote-source");
  const a = p?.querySelector("a");
  return {
    line: p ? getComputedStyle(p).color : null,
    link: a ? getComputedStyle(a).color : null,
    deco: a ? getComputedStyle(a).textDecorationLine : null,
  };
});
ok(
  quoteStyle.link !== null && quoteStyle.link !== quoteStyle.line,
  "署名链接比出处浅一档(90% 混合,最差配色仍 AA)",
);
ok(quoteStyle.deco === "underline", "署名链接常显下划线");
// 视觉留档:悬停到署名显形再截(轮询等 opacity,不引入固定 sleep)
await page.locator(".quote-block").hover();
await page.waitForFunction(
  () => {
    const el = document.querySelector(".quote-source");
    return el !== null && getComputedStyle(el).opacity === "1";
  },
  { timeout: 5000 },
);
await page.screenshot({ path: `${OUT}/3-quote-credit.png` });

// ── ③ 设置开关:关 → 无 quote;重载持久;再开恢复 ──
await page.locator(`button[aria-label="${zh.chat.openSettings}"]`).click();
await sleep(300);
const sw = page.locator("#ui-quote");
ok(
  (await sw.getAttribute("aria-checked")) === "true",
  "设置里「每日一句」缺省为开",
);
await sw.click();
await sleep(300);
ok(
  (await sw.getAttribute("aria-checked")) === "false",
  "点按后为关",
);
await page.keyboard.press("Escape");
await sleep(300);
ok((await quoteText()) === null, "关闭后空态不再展示 quote");
await page.screenshot({ path: `${OUT}/1-quote-off.png` });

await page.reload();
await sleep(800);
ok((await quoteText()) === null, "重载后仍是关(偏好持久化)");

await page.locator(`button[aria-label="${zh.chat.openSettings}"]`).click();
await sleep(300);
await page.locator("#ui-quote").click();
await sleep(300);
await page.keyboard.press("Escape");
await sleep(400);
ok((await quoteText()) !== null, "重新打开后恢复展示");
await page.screenshot({ path: `${OUT}/2-quote-hover.png` });

console.log("\n✅ VERDICT: PASS — 截图在 /tmp/tars-quote/");
await browser.close();
