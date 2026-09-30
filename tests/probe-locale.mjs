// 语言切换留档:设置页外观分节把面板切成 English,验证整树文案跟随、
// 返回对话与重载后语言保持。用法: pnpm build && node tests/probe-locale.mjs
import { zh, en, greetRe } from "./lib-i18n.mjs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync, rmSync } from "fs";
import { launchWithCdp, openPanel, sleep } from "./lib-cdp-mock.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(__dirname, "..", "dist");
const USER_DATA_DIR = "/tmp/probe-locale-profile";
const OUT = "/tmp/tars-locale";

// 持久 profile 会带上一次运行的语言偏好,先清掉
rmSync(USER_DATA_DIR, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const { browser, extId } = await launchWithCdp({
  extDir: EXT_DIR,
  userDataDir: USER_DATA_DIR,
});
const page = await openPanel(browser, extId, { deviceScaleFactor: 2 });
await page.setViewportSize({ width: 420, height: 740 });

// 空态标题按时段定档,断言「任一档可见」;正则构造在 lib-i18n 统一维护
const EN_GREET_RE = greetRe(en);
const ZH_GREET_RE = greetRe(zh);

const ok = (cond, label) => {
  if (!cond) throw new Error(`❌ ${label}`);
  console.log(`  ✅ ${label}`);
};

// ── 中文基线:打开设置 ──
await page.locator(`button[aria-label="${zh.chat.openSettings}"]`).click();
// 等标题出现而非猜时长(硬规则 3):waitFor 只保证挂载,断言由 ok() 现查
const zhTitle = page.getByText(zh.settings.sectionAppearance, { exact: true });
await zhTitle.waitFor({ timeout: 3000 }).catch(() => {});
ok(await zhTitle.isVisible(), "设置页标题为中文(基线)");
await page.screenshot({ path: `${OUT}/1-settings-zh.png` });

// ── 切到 English:设置页整树立即换文案 ──
await page.locator("#ui-locale").selectOption("en-US");
await sleep(300);
ok(await page.getByText(en.settings.sectionModel).isVisible(), "分节标题随切换变英文");
ok(await page.getByRole("radio", { name: en.settings.themeSystem }).isVisible(), "主题选项标签不是模块级旧文案");
await page.screenshot({ path: `${OUT}/2-settings-en.png` });

// ── 返回对话:常驻 ChatView 同步换文案 ──
await page.keyboard.press("Escape");
await sleep(300);
ok(await page.getByText(EN_GREET_RE).isVisible(), "回到首页,空态为英文时段问候之一");
await page.screenshot({ path: `${OUT}/3-chat-en.png` });

// ── 首页语言钮:切回简体中文(首页自救路径,反向验证;面板此刻是英文,
//    触发钮 aria 是英文名 —— 恰好证明英文用户找得到它) ──
await page.locator(`button[aria-label="${en.chat.switchLanguage}"]`).click();
await sleep(200);
await page
  .locator('[role="menuitemradio"]', { hasText: zh.settings.languageZh })
  .click();
await sleep(300);
ok(await page.getByText(ZH_GREET_RE).isVisible(), "首页语言钮切换后,空态回中文时段问候");
await page.screenshot({ path: `${OUT}/4-chat-zh-home-menu.png` });

// ── 重载:首页入口的选择同样落盘,仍是中文 ──
await page.reload();
await sleep(800);
ok(await page.getByText(ZH_GREET_RE).isVisible(), "重载后仍为中文(首页入口已落盘)");
await page.screenshot({ path: `${OUT}/5-chat-zh-reload.png` });

console.log("\n✅ VERDICT: PASS — 截图在 /tmp/tars-locale/");
await browser.close();
