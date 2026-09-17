// 语言切换留档:设置页外观分节把面板切成 English,验证整树文案跟随、
// 返回对话与重载后语言保持。用法: pnpm build && node tests/probe-locale.mjs
import { zh, en, escapeRegExp } from "./lib-i18n.mjs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync, rmSync } from "fs";
import { launchWithCdp } from "./lib-cdp-mock.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(__dirname, "..", "dist");
const USER_DATA_DIR = "/tmp/probe-locale-profile";
const OUT = "/tmp/tars-locale";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 持久 profile 会带上一次运行的语言偏好,先清掉
rmSync(USER_DATA_DIR, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const { browser, extId } = await launchWithCdp({
  extDir: EXT_DIR,
  userDataDir: USER_DATA_DIR,
});
const page = await browser.newPage({ deviceScaleFactor: 2 });
await page.setViewportSize({ width: 420, height: 740 });
await page.goto(`chrome-extension://${extId}/sidepanel.html`);
await sleep(600);

// 空态标题按时段定档(早/中/下午/晚/深夜 5 档),断言「任一档可见」;
// 键位语义化后从字典显式取值,文案改动断言自动跟随
const EN_GREET_RE = new RegExp(
  "^(?:" +
    ["greetMorning", "greetNoon", "greetAfternoon", "greetEvening", "greetLateNight"]
      .map((k) => escapeRegExp(en.chat[k]))
      .join("|") +
    ")$",
);

const ok = (cond, label) => {
  if (!cond) throw new Error(`❌ ${label}`);
  console.log(`  ✅ ${label}`);
};

// ── 中文基线:打开设置 ──
await page.locator(`button[aria-label="${zh.chat.openSettings}"]`).click();
await sleep(300);
ok(await page.getByText(zh.settings.sectionAppearance, { exact: true }).isVisible(), "设置页标题为中文(基线)");
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

// ── 重载:语言从配置恢复,仍是英文 ──
await page.reload();
await sleep(800);
ok(await page.getByText(EN_GREET_RE).isVisible(), "重载后仍为英文(时段问候任一,语言已落盘)");
await page.screenshot({ path: `${OUT}/4-chat-en-reload.png` });

console.log("\n✅ VERDICT: PASS — 截图在 /tmp/tars-locale/");
await browser.close();
