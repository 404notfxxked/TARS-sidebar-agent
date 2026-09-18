// 验证会话持久化(IndexedDB 多会话 + 保留期 + 迁移)
// 用法: pnpm build && node tests/verify-persist.mjs
//
// 场景:
//   S0 迁移:旧版 chrome.storage.session 的 history:* 在 SW 重启后搬进 IDB
//   S1 多会话+懒创建:两个会话各跑一轮;没发消息的会话不产生记录
//   S2 删除单条:列表两段确认删除,UI 与 IDB 同步消失
//   S3 浏览器重启:同 profile 重启后会话/消息都在;面板打开即新会话(空态);
//      从列表切回旧会话,消息回放
//   S4 保留期:updatedAt 改到 8 天前 → 重启触发启动清理 → 只留活跃会话
//
// 断言手段:UI 文本可见性 + 直接读扩展 origin 的 IndexedDB(测试特权,业务代码不这么干)

import { zh, escapeRegExp } from "./lib-i18n.mjs";
import { rmSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  launchWithCdp,
  injectTestConfig,
  ask,
  sse,
} from "./lib-cdp-mock.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(__dirname, "..", "dist");
const USER_DATA_DIR = `/tmp/verify-persist-profile`;
const DAY = 24 * 3600 * 1000;

// 空态标题按时段定档(早/中/下午/晚/深夜 5 档),断言「任一档可见」;
// 键位语义化后从字典显式取值,文案改动断言自动跟随
const EMPTY_GREET_RE = new RegExp(
  "^(?:" +
    ["greetMorning", "greetNoon", "greetAfternoon", "greetEvening", "greetLateNight"]
      .map((k) => escapeRegExp(zh.chat[k]))
      .join("|") +
    ")$",
);

rmSync(USER_DATA_DIR, { recursive: true, force: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.error(`  ❌ ${name} ${detail}`);
  }
}

/** 直接读扩展 origin 的 IDB(面板页上下文):会话行 + 消息总数 */
async function idbSnapshot(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const rq = indexedDB.open("tars");
        rq.onsuccess = () => {
          const db = rq.result;
          const tx = db.transaction(["sessions", "messages"]);
          const sReq = tx.objectStore("sessions").getAll();
          const mReq = tx.objectStore("messages").count();
          tx.oncomplete = () => {
            db.close();
            resolve({ rows: sReq.result, msgTotal: mReq.result });
          };
          tx.onerror = () => reject(tx.error);
        };
        rq.onerror = () => reject(rq.error);
      }),
  );
}

/** 把某会话的 updatedAt 改旧(保留期场景):先取行再逐行 put,单请求事务必 settle */
async function ageSession(page, titlePrefix, days) {
  const snap = await idbSnapshot(page);
  const targets = snap.rows.filter((r) => r.title.startsWith(titlePrefix));
  if (targets.length === 0)
    throw new Error(`ageSession: 找不到标题以「${titlePrefix}」开头的会话`);
  for (const row of targets) {
    await page.evaluate(
      ({ row, ts }) =>
        new Promise((resolve, reject) => {
          const rq = indexedDB.open("tars");
          rq.onsuccess = () => {
            const db = rq.result;
            const tx = db.transaction("sessions", "readwrite");
            tx.objectStore("sessions").put({ ...row, updatedAt: ts });
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onabort = () => reject(tx.error);
            tx.onerror = () => reject(tx.error);
          };
          rq.onerror = () => reject(rq.error);
        }),
      { row, ts: Date.now() - days * DAY },
    );
  }
}

/** 给指定会话种图片行(images store,主键 [sessionId, 字符串 id]):
 *  键序回归钉子 —— 删会话/保留期清理必须级联回收字符串主键的图片字节 */
async function seedImages(page, sessionId, ids) {
  await page.evaluate(
    ({ sessionId, ids }) =>
      new Promise((resolve, reject) => {
        const rq = indexedDB.open("tars");
        rq.onsuccess = () => {
          const db = rq.result;
          const tx = db.transaction("images", "readwrite");
          const store = tx.objectStore("images");
          for (const id of ids) {
            store.put({
              sessionId,
              id,
              mime: "image/jpeg",
              w: 2,
              h: 2,
              bytes: new Uint8Array([1, 2, 3]),
            });
          }
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onabort = () => reject(tx.error);
          tx.onerror = () => reject(tx.error);
        };
        rq.onerror = () => reject(rq.error);
      }),
    { sessionId, ids },
  );
}

/** images store 概览:只回 sessionId 集合,不搬运字节 */
async function imageSnapshot(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const rq = indexedDB.open("tars");
        rq.onsuccess = () => {
          const db = rq.result;
          const tx = db.transaction("images", "readonly");
          const q = tx.objectStore("images").getAll();
          q.onsuccess = () => {
            db.close();
            resolve(q.result.map((r) => r.sessionId));
          };
          q.onerror = () => reject(q.error);
        };
        rq.onerror = () => reject(rq.error);
      }),
  );
}

/** 重启扩展 SW(关 target;下次事件自动唤醒并重跑启动逻辑) */
async function restartSW(cdpSend, extId) {
  const { targetInfos } = await cdpSend("Target.getTargets");
  const sw = targetInfos.find(
    (t) => t.type === "service_worker" && t.url.includes(extId),
  );
  if (sw) await cdpSend("Target.closeTarget", { targetId: sw.targetId });
  await sleep(600);
}

const openPanel = async (browser, extId) => {
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${extId}/sidepanel.html`);
  return page;
};

const openSessionsView = async (page) => {
  await page.locator(`button[aria-label="${zh.chat.openSessions}"]`).click();
  await page.locator(`h2:has-text("${zh.sessions.title}")`).waitFor({ timeout: 5000 });
};

// ---- 启动 ----
let { browser, extId, cdpSend, mock } = await launchWithCdp({
  extDir: EXT_DIR,
  userDataDir: USER_DATA_DIR,
  proxy: process.env.VERIFY_PROXY,
});
console.log("✅ 扩展:", extId);

mock.setRoutes([
  {
    match: (url) => url.includes("/chat/completions"),
    handle: async (ctx) => {
      const body = JSON.parse(ctx.params.request.postData ?? "{}");
      const lastUser = [...(body.messages ?? [])]
        .reverse()
        .find((m) => m.role === "user");
      const raw = String(lastUser?.content ?? "");
      const inner = raw.match(/<user-request>([\s\S]*?)<\/user-request>/);
      const reply = `收到:${(inner ? inner[1] : raw).trim().slice(0, 30)}`;
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

let sidepanel = await openPanel(browser, extId);
await injectTestConfig(sidepanel);
await sidepanel.reload();
await sleep(500);

// ---- S0 迁移 ----
console.log("\nS0 旧数据迁移(storage.session → IDB)");
await sidepanel.evaluate(() =>
  chrome.storage.session.set({
    "history:legacy-id": [
      { role: "user", content: "旧会话迁移测试" },
      { role: "assistant", content: "好的" },
    ],
    "sessionId:default": "legacy-id",
  }),
);
await restartSW(cdpSend, extId);
await sidepanel.reload();
await sleep(1500); // 等 SW 启动迁移完成
await openSessionsView(sidepanel);
await sidepanel
  .getByText("旧会话迁移测试")
  .first()
  .waitFor({ timeout: 10000 })
  .then(() => check("旧会话出现在历史列表", true))
  .catch(() => check("旧会话出现在历史列表", false));
{
  const snap = await idbSnapshot(sidepanel);
  check("迁移后 IDB 有 1 会话 2 消息", snap.rows.length === 1 && snap.msgTotal === 2,
    JSON.stringify(snap.rows.map((r) => r.title)));
}
await sidepanel.locator(`button[aria-label="${zh.common.backToChat}"]`).click();

// ---- S1 多会话 + 懒创建 ----
console.log("\nS1 多会话与懒创建");
await sidepanel.locator(`button[aria-label="${zh.chat.newChat}"]`).click();
await ask(sidepanel, "第一条测试消息");
await sidepanel.locator(`button[aria-label="${zh.chat.newChat}"]`).click();
const emptyVisible = await sidepanel
  .getByText(EMPTY_GREET_RE)
  .waitFor({ timeout: 3000 })
  .then(() => true)
  .catch(() => false);
check("新对话后面板为空态(打开即新会话)", emptyVisible);
await ask(sidepanel, "第二条测试消息");
await openSessionsView(sidepanel);
await sleep(300);
{
  const snap = await idbSnapshot(sidepanel);
  const titles = snap.rows.map((r) => r.title).sort();
  check(
    "IDB 有 3 会话 6 消息",
    snap.rows.length === 3 && snap.msgTotal === 6,
    JSON.stringify({ titles, total: snap.msgTotal }),
  );
  check("会话标题取自首条用户消息",
    titles.includes("第一条测试消息") && titles.includes("第二条测试消息"),
    JSON.stringify(titles));
  const hasEmpty = snap.rows.some(
    (r) => r.msgCount === 0 || r.title === "未命名会话",
  );
  check("没有空会话记录(懒创建)", !hasEmpty);
}

// ---- S2 删除单条 ----
console.log("\nS2 删除单个会话");
{
  // 键序回归:images 主键是 [sessionId, 字符串 id],删会话必须级联回收
  const snap = await idbSnapshot(sidepanel);
  const legacy = snap.rows.find((r) => r.title.startsWith("旧会话迁移测试"));
  await seedImages(sidepanel, legacy.id, ["img-legacy-1", "img-legacy-2"]);
  check("删除前 images store 有 2 行", (await imageSnapshot(sidepanel)).length === 2);

  const row = sidepanel.locator("li", { hasText: "旧会话迁移测试" });
  await row.locator('button[aria-label^="删除会话"]').click();
  await row.locator(`button:has-text("${zh.common.confirmDelete}")`).click();
  await sleep(600);
  const gone = (await row.count()) === 0;
  check("列表行已消失", gone);
  const after = await idbSnapshot(sidepanel);
  check("IDB 剩 2 会话 4 消息", after.rows.length === 2 && after.msgTotal === 4,
    JSON.stringify({ n: after.rows.length, total: after.msgTotal }));
  check("图片字节随会话级联删除(键序回归)", (await imageSnapshot(sidepanel)).length === 0);
}
await sidepanel.locator(`button[aria-label="${zh.common.backToChat}"]`).click();

// ---- S3 浏览器重启 ----
console.log("\nS3 浏览器重启持久化");
await browser.close();
({ browser, extId, cdpSend, mock } = await launchWithCdp({
  extDir: EXT_DIR,
  userDataDir: USER_DATA_DIR,
}));
sidepanel = await openPanel(browser, extId);
{
  const emptyVisible = await sidepanel
    .getByText(EMPTY_GREET_RE)
    .waitFor({ timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  check("重启后打开仍是空态(不自动恢复)", emptyVisible);
}
await openSessionsView(sidepanel);
await sleep(300);
{
  const titles = await sidepanel.locator("li").allInnerTexts();
  check(
    "重启后列表剩 2 个会话",
    titles.some((t) => t.includes("第一条测试消息")) &&
      titles.some((t) => t.includes("第二条测试消息")),
    JSON.stringify(titles),
  );
}
// 切回旧会话,消息回放
await sidepanel.locator("li", { hasText: "第一条测试消息" }).first().click();
await sleep(800);
{
  const text = await sidepanel.evaluate(() => document.body.innerText);
  check(
    "切回后消息回放(用户消息与回复可见)",
    text.includes("第一条测试消息") && text.includes("收到:第一条测试消息"),
  );
  // 回归钉子:回显必须是用户输入原文,不得泄漏 wire 层的 context 包裹
  check(
    "用户气泡回显无 context 包裹",
    !text.includes("<context>") && !text.includes("user-request"),
    text.slice(0, 200),
  );
}

// ---- S4 保留期清理 ----
console.log("\nS4 保留期清理(默认 7 天)");
let keptSessionId = null;
{
  // 键序回归(保留期路径):过期会话的图片字节一并回收,活跃会话的保留
  const snap = await idbSnapshot(sidepanel);
  const expired = snap.rows.find((r) => r.title.startsWith("第一条测试消息"));
  const kept = snap.rows.find((r) => r.title.startsWith("第二条测试消息"));
  keptSessionId = kept.id;
  await seedImages(sidepanel, expired.id, ["img-expired-1"]);
  await seedImages(sidepanel, kept.id, ["img-kept-1"]);
}
await ageSession(sidepanel, "第一条测试消息", 8);
await browser.close();
({ browser, extId } = await launchWithCdp({
  extDir: EXT_DIR,
  userDataDir: USER_DATA_DIR,
}));
sidepanel = await openPanel(browser, extId);
await sleep(800); // 等 SW 启动清理
await openSessionsView(sidepanel);
await sleep(300);
{
  const titles = await sidepanel.locator("li").allInnerTexts();
  check(
    "过期会话被清理,活跃会话保留",
    titles.some((t) => t.includes("第二条测试消息")) &&
      !titles.some((t) => t.includes("第一条测试消息")),
    JSON.stringify(titles),
  );
  const imgs = await imageSnapshot(sidepanel);
  check(
    "保留期清理级联回收过期会话图片,活跃会话图片保留(键序回归)",
    imgs.length === 1 && imgs[0] === keptSessionId,
    JSON.stringify({ imgs, keptSessionId }),
  );
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
await browser.close();
process.exit(failed > 0 ? 1 : 0);
