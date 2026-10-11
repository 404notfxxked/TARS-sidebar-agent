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
import { launchWithCdp, makeChecker, openPanel, pollUntil, scrollProbe, seedSessions, setTheme, sleep } from "./lib-cdp-mock.mjs";
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

// ---- composer 窄宽度回归:折叠式模型/思考选择区,任何宽度无变形 ----
// 挤压变形的历史形态:三个文字 pill 挤在工具条里,窄面板下被压到逐字
// 竖排(「思/考/·/中」)、不收缩的 pill 叠画到模型名上。现结构:默认
// 摘要栏一行(工具条只剩附件/档位/发送),展开「模型/思考程度」两行。
// 断言:320/280px 下,收起态 4 颗按钮、展开态 6 颗,每颗高度 ≤44px
// (单行行高 ≈26-38px,文字竖排必然 >56px),表体无横向溢出。
// 宽度探测后恢复 420,不影响后续悬浮层断言。
await page.evaluate(() =>
  chrome.storage.local.set({
    providers: [
      {
        id: "prov-1",
        name: "TestProv",
        baseUrl: "https://api.test.example.com/v1",
        apiKey: "sk-test",
        models: [
          { id: "gpt-5.1", alias: "deepseek-flash", reasoning: true },
          // 长 id 把二级列表顶到 280px 宽度上限,复现左锚越出视口的回归
          { id: "deepseek-v4-flash-vision-exp-2026-0918-long" },
        ],
      },
    ],
    modelProvider: "prov-1",
    model: "gpt-5.1",
  }),
);
await page.reload();
await pollUntil(
  async () => page.locator("form textarea").count(),
  (n) => n > 0,
  "composer 就绪(注入带思考档位的供应商配置后 reload)",
);
/** 表体全部按钮高度与横向溢出量(实现在本探针内,仅此一处用) */
const composerProbe = () =>
  page.evaluate(() => {
    const form = document.querySelector("form");
    const toolbar = form.querySelector(".composer-toolbar");
    return {
      buttons: [...form.querySelectorAll("button")].map((b) =>
        Math.round(b.getBoundingClientRect().height),
      ),
      overflow: form.scrollWidth - form.clientWidth,
      formH: Math.round(form.getBoundingClientRect().height),
      toolbarH: Math.round(toolbar.getBoundingClientRect().height),
    };
  });
/** 摘要栏:收起态唯一含模型别名的按钮;展开态 DOM 序在两行之后(.last()
 *  命中摘要栏而非模型行,避免误点开弹层) */
const summaryBar = () =>
  page.locator("form button", { hasText: "deepseek-flash" }).last();
for (const width of [320, 280, 250]) {
  await page.setViewportSize({ width, height: 740 });
  // 重排后等一帧再量(rAF 事件驱动;本探针固定等待基线已满,不可新增 sleep)
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => r())),
  );
  let m = await composerProbe();
  const collapsedH = m.formH;
  check(
    m.buttons.length === 4,
    `composer ${width}px:收起态 4 颗按钮(摘要栏/附件/档位/发送)`,
    `实际 ${m.buttons.length} 颗`,
  );
  check(
    m.toolbarH <= 48,
    `composer ${width}px:工具条单行(高 ${m.toolbarH}px ≤ 48)`,
    `工具条高 ${m.toolbarH}px —— 折行了`,
  );
  check(
    m.buttons.every((h) => h <= 44),
    `composer ${width}px:收起态无竖排变形(高度≤44px)`,
    `各钮高度: ${m.buttons.join(", ")}px`,
  );
  check(
    m.overflow <= 1,
    `composer ${width}px:收起态无横向溢出`,
    `溢出 ${m.overflow}px`,
  );
  await summaryBar().click();
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => r())),
  );
  m = await composerProbe();
  check(
    m.buttons.length === 6,
    `composer ${width}px:展开态 6 颗按钮(+模型行/思考行)`,
    `实际 ${m.buttons.length} 颗`,
  );
  check(
    m.buttons.every((h) => h <= 44),
    `composer ${width}px:展开态无竖排变形(高度≤44px)`,
    `各钮高度: ${m.buttons.join(", ")}px`,
  );
  check(
    m.overflow <= 1,
    `composer ${width}px:展开态无横向溢出`,
    `溢出 ${m.overflow}px`,
  );
  check(
    Math.abs(m.formH - collapsedH) <= 1,
    `composer ${width}px:展开为浮层,表体高度不变(${collapsedH}px)`,
    `展开后表体 ${m.formH}px —— 面板在推挤布局而非悬浮`,
  );
  // 二级列表(模型弹层):左锚曾向右越出视口,把页面顶出横向滚动条
  await page.getByRole("button", { name: zh.chat.selectModel }).click();
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => r())),
  );
  m = await composerProbe();
  check(
    m.overflow <= 1,
    `composer ${width}px:模型列表弹出不产生横向溢出`,
    `溢出 ${m.overflow}px`,
  );
  await page.keyboard.press("Escape"); // 收列表弹层,面板保持
  // 页面级截图:面板浮出表体上缘,form 截图会裁掉
  await page.screenshot({ path: `${OUT}/layout-composer-${width}.png` });
  console.log(`  📸 layout-composer-${width}.png`);
  await summaryBar().click(); // 收起复原
}
await page.setViewportSize({ width: 420, height: 740 });

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
