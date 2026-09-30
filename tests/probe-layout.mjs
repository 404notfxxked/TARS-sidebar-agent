// 布局回归探针(合并自 probe-sticky + probe-shots,2026-09):
// 悬浮层(设置/历史页)结构硬规则的唯一自动化防线 ——「overlay 必须
// flex 列、内页自滚、顶栏在滚动区外」坏了吗,数值说了算 + 滚动中截图人看。
// 断言:文档层不可滚(docScrollable=0)、滚动后顶栏纹丝不动(headerTop≥0)、
//       内页真的在滚(innerScrollable>0,否则断言形同虚设)。
// 用法: pnpm build && node tests/probe-layout.mjs
// 产出: /tmp/probe-layout-out/layout-*.png;任一断言失败退出码 1。
// (产物目录勿与 shot-m3 的 /tmp/tars-m3 合用 —— 那边启动会整目录 rmSync)
import { mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { launchWithCdp, makeChecker, openPanel, scrollProbe, seedSessions, setTheme, sleep } from "./lib-cdp-mock.mjs";
import { zh } from "./lib-i18n.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(__dirname, "..", "dist");
const USER_DATA_DIR = `/tmp/probe-layout-${Date.now()}`;
const OUT = "/tmp/probe-layout-out";
mkdirSync(OUT, { recursive: true });

const check = makeChecker();
const { browser, extId } = await launchWithCdp({
  extDir: EXT_DIR,
  userDataDir: USER_DATA_DIR,
});
const page = await openPanel(browser, extId, {
  deviceScaleFactor: 2,
  configure: (p) =>
    p.evaluate(() =>
      chrome.storage.local.set({ apiKey: "sk-test", model: "gpt-4o", theme: "light" }),
    ),
});
await page.setViewportSize({ width: 420, height: 740 }); // 二分实验:视口后置

// 种 24 条历史(跨 24 天,保证历史页超高、内页必然可滚)
const DAY = 24 * 3600 * 1000;
await seedSessions(
  page,
  Array.from({ length: 24 }, (_, i) => ({
    id: `s-${i}`,
    title: `历史会话 ${i + 1}号`, // i18n-ok 测试种子标题,非 UI 断言
    at: Date.now() - (i + 1) * DAY,
  })),
);

/** 数值探针:文档层/顶栏/内页滚动状态 —— 实现在 lib scrollProbe(唯一实现,
 *  probe-focus 的 listState 同源) */
const probe = () => scrollProbe(page);
const scrollInner = async (dy) => {
  await page.mouse.move(210, 400);
  await page.mouse.wheel(0, dy);
  await sleep(400);
};

for (const theme of ["light", "dark"]) {
  await setTheme(page, theme);
  await sleep(250);
  await page.screenshot({ path: `${OUT}/layout-home-${theme}.png` });
  console.log(`  📸 layout-home-${theme}.png`);

  // 历史页:打开时文档层不可滚;滚动后顶栏不动、内页在滚
  await page.locator(`button[aria-label="${zh.chat.openSessions}"]`).click();
  await page.locator(`h2:has-text("${zh.sessions.title}")`).waitFor({ timeout: 5000 });
  await sleep(400);
  let m = await probe();
  check(m.docScrollable === 0, `[${theme}] 历史页打开:文档层不可滚`, `docScrollable=${m.docScrollable}`);
  await scrollInner(500);
  m = await probe();
  check(m.innerScrollable > 0, `[${theme}] 历史页:内页可滚(种子够高)`, `innerScrollable=${m.innerScrollable}`);
  check(m.innerScrollTop > 0, `[${theme}] 历史页:滚动后内页位置已变`, `innerScrollTop=${m.innerScrollTop}`);
  check(m.headerTop !== null && m.headerTop >= 0, `[${theme}] 历史页滚动后顶栏吸顶`, `headerTop=${m.headerTop}`);
  await page.screenshot({ path: `${OUT}/layout-sessions-scrolled-${theme}.png` });
  console.log(`  📸 layout-sessions-scrolled-${theme}.png`);
  await page.keyboard.press("Escape");
  await sleep(300);

  // 设置页:同一套断言
  await page.locator(`button[aria-label="${zh.chat.openSettings}"]`).click();
  await page.locator(`h2:has-text("${zh.settings.title}")`).waitFor({ timeout: 5000 });
  await sleep(400);
  m = await probe();
  check(m.docScrollable === 0, `[${theme}] 设置页打开:文档层不可滚`, `docScrollable=${m.docScrollable}`);
  await scrollInner(700);
  m = await probe();
  check(m.innerScrollable > 0, `[${theme}] 设置页:内页可滚`, `innerScrollable=${m.innerScrollable}`);
  check(m.innerScrollTop > 0, `[${theme}] 设置页:滚动后内页位置已变`, `innerScrollTop=${m.innerScrollTop}`);
  check(m.headerTop !== null && m.headerTop >= 0, `[${theme}] 设置页滚动后顶栏吸顶`, `headerTop=${m.headerTop}`);
  await page.screenshot({ path: `${OUT}/layout-settings-scrolled-${theme}.png` });
  console.log(`  📸 layout-settings-scrolled-${theme}.png`);
  await page.keyboard.press("Escape");
  await sleep(300);
}

console.log("\n========================================");
if (check.failures.length > 0) {
  console.log("❌ VERDICT: FAIL —", check.failures.join("; "));
  await browser.close();
  process.exit(1);
}
console.log("✅ VERDICT: PASS");
await browser.close();
process.exit(0);
