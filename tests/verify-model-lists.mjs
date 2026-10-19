// 验证「获取列表」的模型漂移标记与供应商级一键清理(端到端:设置页真拉取)
// 用法: pnpm build && node tests/run.mjs model-lists
//
// 前置:providers 种子 = 本地 [kept-model, old-model],默认模型 old-model;
// mock 端点 GET /v1/models 可在套件中途换返回值(同一 handler 读变量)。
//   ML1 刷新标记:官方返回不含 old-model → 落盘 unlisted=true + 行首警示图标;
//       官方新模型 new-model 预填进列表
//   ML2 两段确认:首点「清理未收录」只进入待确认(文案换确认态),不写盘
//   ML3 重新在列摘标记:官方把 old-model 加回 → 刷新后 unlisted 清除、图标消失
//   ML4 一键清理:再次漂移后确认清理 → 未收录模型整批移除,默认模型被清时
//       回落到剩余首个(写盘核对),图标随之消失
// 断言手段:UI 文案(图标语义/按钮两态)+ chrome.storage.local 落盘核对;
// 等待全部走 pollUntil(存储/文案轮询),无固定 sleep。

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  launchWithCdp,
  makeChecker,
  openPanel,
  pollUntil,
  seedProviders,
} from "./lib-cdp-mock.mjs";
import { zh } from "./lib-i18n.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(__dirname, "..", "dist");
const USER_DATA_DIR = `/tmp/verify-model-lists-${Date.now()}`;

const check = makeChecker();

// mock 端点的官方列表:套件中途换值驱动「漂移 / 重新在列」两个方向
let remoteModels = ["kept-model", "new-model"];

const { browser, extId, mock } = await launchWithCdp({
  extDir: EXT_DIR,
  userDataDir: USER_DATA_DIR,
});
mock.setRoutes([
  {
    match: (url) => url.includes("api.test.example.com/v1/models"),
    handle: async (ctx) =>
      ctx.fulfill({
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: remoteModels.map((id) => ({ id })) }),
      }),
  },
]);

const page = await openPanel(browser, extId, {
  configure: (p) =>
    seedProviders(p, [{ id: "kept-model" }, { id: "old-model" }], "old-model"),
});

/** 读 providers / 当前模型的落盘值 */
const readConfig = () =>
  page.evaluate(() =>
    chrome.storage.local.get(["providers", "model", "modelProvider"]),
  );
const modelIds = (cfg) =>
  (cfg.providers?.[0]?.models ?? []).map((m) => m.id);

// 打开设置页并展开供应商卡(模型块收在卡内)
await page.locator(`button[aria-label="${zh.chat.openSettings}"]`).click();
await page
  .locator(`h2:has-text("${zh.settings.title}")`)
  .waitFor({ timeout: 5000 });
await page
  .locator(".model-list > .model-row > .model-row-head", { hasText: "TestProv" })
  .click();

// ---- ML1 刷新标记:漂移模型落 unlisted 并显示警示图标;官方新模型并入 ----
await page.locator(`button:has-text("${zh.settings.fetchModels}")`).click();
let cfg = await pollUntil(
  readConfig,
  (c) => modelIds(c).length === 3,
  "ML1 刷新后合并官方列表(2 本地 + 1 新增)",
);
check(
  modelIds(cfg).join(",") === "kept-model,new-model,old-model",
  "ML1 刷新合并:官方新增入列且本地模型保留",
  `实际 ${modelIds(cfg).join(",")}`,
);
const oldEntry = cfg.providers[0].models.find((m) => m.id === "old-model");
check(
  oldEntry?.unlisted === true,
  "ML1 漂移标记落盘:old-model.unlisted === true",
  `实际 ${JSON.stringify(oldEntry)}`,
);
await pollUntil(
  async () => page.locator("svg.model-row-warn-icon").count(),
  (n) => n === 1,
  "ML1 行首警示图标出现",
);
check(
  (await page.locator("svg.model-row-warn-icon").getAttribute("aria-label")) ===
    zh.settings.unlistedMark,
  "ML1 图标语义标签取字典(unlistedMark)",
  `实际 "${await page.locator("svg.model-row-warn-icon").getAttribute("aria-label")}"`,
);

// ---- ML2 两段确认:首点只进入待确认,不写盘 ----
await page.locator(`button:has-text("${zh.settings.cleanUnlisted}")`).click();
await pollUntil(
  async () =>
    page.locator(`button:has-text("${zh.settings.confirmCleanUnlisted}")`).count(),
  (n) => n === 1,
  "ML2 首点进入待确认(按钮换确认文案)",
);
cfg = await readConfig();
check(
  modelIds(cfg).length === 3,
  "ML2 待确认态不写盘:模型仍是 3 个",
  `实际 ${modelIds(cfg).length} 个`,
);

// ---- ML3 重新在列:官方加回 old-model,刷新即摘标记 ----
remoteModels = ["kept-model", "old-model", "new-model"];
await page.locator(`button:has-text("${zh.settings.fetchModels}")`).click();
cfg = await pollUntil(
  readConfig,
  (c) =>
    c.providers[0].models.find((m) => m.id === "old-model")?.unlisted ===
    undefined,
  "ML3 重新在列后标记摘除",
);
check(
  modelIds(cfg).length === 3,
  "ML3 刷新后模型数不变(标记摘除 ≠ 增删)",
  `实际 ${modelIds(cfg).length} 个`,
);
await pollUntil(
  async () => page.locator("svg.model-row-warn-icon").count(),
  (n) => n === 0,
  "ML3 图标随标记摘除消失",
);

// ---- ML4 再次漂移后一键清理:整批移除 + 默认模型回落 ----
remoteModels = ["kept-model", "new-model"];
await page.locator(`button:has-text("${zh.settings.fetchModels}")`).click();
await pollUntil(
  readConfig,
  (c) =>
    c.providers[0].models.find((m) => m.id === "old-model")?.unlisted === true,
  "ML4 再次漂移标记落盘",
);
await page.locator(`button:has-text("${zh.settings.cleanUnlisted}")`).click();
await page
  .locator(`button:has-text("${zh.settings.confirmCleanUnlisted}")`)
  .click();
cfg = await pollUntil(
  readConfig,
  (c) => modelIds(c).length === 2,
  "ML4 清理后只剩在列模型",
);
check(
  modelIds(cfg).join(",") === "kept-model,new-model",
  "ML4 未收录模型整批移除",
  `实际 ${modelIds(cfg).join(",")}`,
);
check(
  cfg.model === "kept-model",
  "ML4 默认模型被清回落剩余首个",
  `实际 model=${cfg.model}`,
);
await pollUntil(
  async () => page.locator("svg.model-row-warn-icon").count(),
  (n) => n === 0,
  "ML4 清理后图标消失",
);

console.log("\n========================================");
if (check.failures.length > 0) {
  console.log("❌ VERDICT: FAIL —", check.failures.join("; "));
  await browser.close();
  process.exit(1);
}
console.log("✅ VERDICT: PASS");
await browser.close();
process.exit(0);
