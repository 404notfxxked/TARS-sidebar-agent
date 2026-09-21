// 探针:消息级动作行——回答气泡的复制(真实写剪贴板)与末条「重新生成」
// (SW 截库自末条 user 行含,以原内容重跑;库里不出现重复提问)。
// 覆盖两条挂点:本轮收尾气泡(RunZone settled)与历史回放后的末条气泡。
// 用法: pnpm build && node tests/probe-actions.mjs
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync, rmSync } from "fs";
import { launchWithCdp, sse, ask } from "./lib-cdp-mock.mjs";
import { zh } from "./lib-i18n.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(__dirname, "..", "dist");
const USER_DATA_DIR = "/tmp/probe-actions-profile";
const OUT = "/tmp/tars-actions";
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
const answerSSE = (ctx, text) =>
  ctx.fulfill({
    headers: { "Content-Type": "text/event-stream" },
    body: sse(
      { choices: [{ delta: { content: text } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ),
  });

// 逐次换答案:首答 A、重答应 B、回放后再重答应 C——「真的重跑了」以文案为准
// (mock 模型输出,非 UI 文案,不受文案门禁约束)
let calls = 0;
const ANSWERS = ["ALPHA_FIRST_REPLY", "BETA_REGEN_REPLY", "GAMMA_REPLAY_REPLY"];
await mock.setRoutes([
  {
    match: (url) => url.includes("/chat/completions"),
    handle: async (ctx) =>
      answerSSE(ctx, ANSWERS[Math.min(calls++, ANSWERS.length - 1)]),
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

const QUESTION = "帮我把这段话润色一下";

// ── 首答 + 复制 ──
await ask(page, QUESTION);
ok(
  await page.getByText(ANSWERS[0]).first().isVisible(),
  "首答回答可见(ALPHA)",
);
const bubble = page.locator(".msg-bubble", { hasText: ANSWERS[0] }).first();
const copyBtn = bubble.locator(`button[aria-label="${zh.common.copy}"]`);
await copyBtn.click();
// 按钮翻转是事件,不猜时长:等「已复制」钮出现(超时降级为拿不到),
// 断言仍由 ok() 持有 —— 翻转没发生照样 FAIL,这里不做恒真打卡
const copiedBtn = bubble.locator(`button[aria-label="${zh.common.copied}"]`);
await copiedBtn.waitFor({ timeout: 3000 }).catch(() => {});
ok(
  (await copiedBtn.count()) > 0,
  "复制后按钮翻成已复制反馈(useCopyFlash 成功路径)",
);
// 剪贴板真实写入:标签翻转即代表 copy() 已 resolve,这里再做内容级加分断言。
// readText 无权限时会弹真窗永久阻塞(evaluate 无超时),必须带超时竞速;
// 只有环境拒绝(timeout/权限拒绝)才降级跳过,内容不匹配照常 FAIL
const clip = await Promise.race([
  page.evaluate(() => navigator.clipboard.readText()).catch(() => "<denied>"),
  new Promise((r) => setTimeout(() => r("<timeout>"), 3000)),
]);
if (clip === "<timeout>" || clip === "<denied>") {
  console.log("  ⚠️ 剪贴板读取被环境拒绝,跳过内容断言(标签断言已覆盖)");
} else {
  ok(clip === ANSWERS[0], `剪贴板内容 = 回答原文(${clip.slice(0, 20)}…)`);
}

// ── 重新生成(本轮收尾气泡挂点)──
const regenBtn = bubble.locator(`button[aria-label="${zh.chat.regenerate}"]`);
ok((await regenBtn.count()) === 1, "末条答案带「重新生成」");
await regenBtn.click();
await page.getByText(ANSWERS[1]).waitFor({ timeout: 30000 });
ok(await page.getByText(ANSWERS[1]).first().isVisible(), "重答后新答案可见(BETA)");
ok(
  (await page.getByText(ANSWERS[0]).count()) === 0,
  "旧答案已退场(ALPHA 不再渲染)",
);
ok(
  (await page.getByText(QUESTION).count()) === 1,
  "提问气泡不重复(仍是 1 条)",
);
ok(calls === 2, `模型确实被重新调用(${calls} 次)`);

// ── 库态:截断 + 重跑落盘 ──
{
  const rows = await page.evaluate(async () => {
    const db = await new Promise((resolvePromise, reject) => {
      const rq = indexedDB.open("tars");
      rq.onsuccess = () => resolvePromise(rq.result);
      rq.onerror = () => reject(rq.error);
    });
    const tx = db.transaction("messages", "readonly");
    const all = await new Promise((resolvePromise) => {
      const rq = tx.objectStore("messages").getAll();
      rq.onsuccess = () => resolvePromise(rq.result);
    });
    db.close();
    return all;
  });
  const mine = rows.map((r) => r.msg);
  ok(
    mine.filter((m) => m.role === "user" && m.content.includes(QUESTION)).length === 1,
    "库中该问只有 1 条 user 行(截断未留重复)",
  );
  ok(
    mine.some((m) => m.role === "assistant" && m.content?.includes(ANSWERS[1])) &&
      !mine.some((m) => m.role === "assistant" && m.content?.includes(ANSWERS[0])),
    "库中只有新答案(旧答案行已被截掉)",
  );
}

await page.screenshot({ path: `${OUT}/1-regen.png` });

// ── 历史回放后的重答(末条历史气泡挂点)──
await page.reload();
await sleep(800);
await page.locator(`button[aria-label="${zh.chat.openSessions}"]`).click();
await sleep(300);
await page.getByText(QUESTION).first().click();
await sleep(600);
ok(
  await page.getByText(ANSWERS[1]).first().isVisible(),
  "回放后上一答案可见(BETA)",
);
const replayBubble = page
  .locator(".msg-bubble", { hasText: ANSWERS[1] })
  .first();
await replayBubble
  .locator(`button[aria-label="${zh.chat.regenerate}"]`)
  .click();
await page.getByText(ANSWERS[2]).waitFor({ timeout: 30000 });
ok(await page.getByText(ANSWERS[2]).first().isVisible(), "回放挂点重答成功(GAMMA)");
await page.screenshot({ path: `${OUT}/2-replay-regen.png` });

console.log("\n✅ VERDICT: PASS — 截图在 /tmp/tars-actions/");
await browser.close();
