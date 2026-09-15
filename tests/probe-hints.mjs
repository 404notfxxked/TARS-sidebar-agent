// 提示分层留档:瘦身后的设置页 + 「了解详情」折叠展开态 + ⓘ 气泡悬停态,
// 中英各一组。用法: pnpm build && node tests/probe-hints.mjs
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync, rmSync } from "fs";
import { launchWithCdp, injectTestConfig } from "./lib-cdp-mock.mjs";
import { zh } from "./lib-i18n.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(__dirname, "..", "dist");
const USER_DATA_DIR = "/tmp/verify-hints-profile";
const OUT = "/tmp/tars-hints";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

rmSync(USER_DATA_DIR, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const { browser, extId } = await launchWithCdp({
  extDir: EXT_DIR,
  userDataDir: USER_DATA_DIR,
});
const page = await browser.newPage({ deviceScaleFactor: 2 });
await page.setViewportSize({ width: 420, height: 740 });
await page.goto(`chrome-extension://${extId}/sidepanel.html`);
await sleep(500);
// 先注入旧版单供应商配置再重载:设置页挂载时才 loadConfig,注入必须在其前
await injectTestConfig(page);
await page.reload();
await sleep(800);

const ok = (cond, label) => {
  if (!cond) throw new Error(`❌ ${label}`);
  console.log(`  ✅ ${label}`);
};

// ── ① 供应商卡片展开 → Base URL 的 ⓘ 悬停态(气泡弹出) ──
await page.locator(`button[aria-label="${zh.chat.openSettings}"]`).click();
await sleep(400);
await page.locator(".model-row-head").first().click();
await sleep(300);
await page.locator(".info-tip-btn").first().hover();
await sleep(400);
ok(await page.locator(".info-tip-pop").first().isVisible(), "ⓘ 悬停弹出气泡");
await page.screenshot({ path: `${OUT}/1-zh-infotip.png` });
await page.mouse.move(0, 0); // 移开鼠标取消悬停(不能 Esc:会关掉整个设置悬浮层)
await sleep(300);

// ── ② 联网:打开开关 → 第一枚折叠钮(联网区)展开 ──
const webSwitch = page.locator("#settings-web-search");
if ((await webSwitch.getAttribute("aria-checked")) !== "true") {
  await webSwitch.click();
  await sleep(500);
}
const mores = page.locator(".hint-more-btn");
ok((await mores.count()) === 3, "三处「了解详情」(联网/MCP/记忆)齐全");
await mores.nth(0).click();
await sleep(300);
ok(
  (await page.locator(".field-hint").allTextContents()).some((s) =>
    s.includes("DuckDuckGo"),
  ),
  "联网机制详情展开",
);
await page
  .locator("h3", { hasText: zh.settings.sectionWeb })
  .first()
  .scrollIntoViewIfNeeded();
await sleep(300);
await page.screenshot({ path: `${OUT}/2-zh-web-more.png` });

// ── ③ 记忆:展开关闭行为细节 ──
await mores.nth(2).click();
await sleep(300);
await page
  .locator("h3", { hasText: zh.settings.sectionMemory })
  .first()
  .scrollIntoViewIfNeeded();
await sleep(300);
await page.screenshot({ path: `${OUT}/3-zh-memory-more.png` });

// ── ④ 英文:切语言后同一屏(联网折叠保持展开,文案即变) ──
await page.locator("#ui-locale").selectOption("en-US");
await sleep(500);
await page
  .locator("h3", { hasText: en.settings.sectionWeb })
  .first()
  .scrollIntoViewIfNeeded();
await sleep(300);
ok(
  (await page.locator(".field-hint").allTextContents()).some((s) =>
    s.includes("DuckDuckGo"),
  ),
  "切英文后展开态文案跟随",
);
await page.screenshot({ path: `${OUT}/4-en-web-more.png` });

console.log(`\n✅ VERDICT: PASS — 截图在 ${OUT}/`);
await browser.close();
