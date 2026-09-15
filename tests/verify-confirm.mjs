// 验证写操作确认门(安全 V1)
// 用法: pnpm build && node tests/verify-confirm.mjs
//
// CDP Fetch 拦截 LLM 端点,mock 模型先调 fill_input(写操作)再给终答,断言:
//   C1. 默认开启(confirmActions 键缺席 = 开):面板弹确认卡,卡内含
//       目标页面 / 写入内容 / 回车提交提示 / 元素定位 —— 信息足够做决定
//   C2. 拒绝:fill_input 不执行,「declined」错误文案回给模型,run 正常收口
//   C3. 允许:门放行,工具真实分发(本测试环境无普通页面可注入,执行期
//       失败也算放行 —— 关键是错误不再是 declined)
//   C4. 期间后台日志带 confirm 语义,便于与其他工具失败区分

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  launchWithCdp,
  injectTestConfig,
  readRunLogs,
  sse,
} from "./lib-cdp-mock.mjs";
import { zh } from "./lib-i18n.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(__dirname, "..", "dist");
const USER_DATA_DIR = `/tmp/verify-confirm-${Date.now()}`;

const { browser, extId, mock } = await launchWithCdp({
  extDir: EXT_DIR,
  userDataDir: USER_DATA_DIR,
});
console.log("✅ 扩展:", extId);

const answer = (ctx, text) =>
  ctx.fulfill({
    headers: { "Content-Type": "text/event-stream" },
    body: sse(
      { choices: [{ delta: { content: text } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ),
  });
const toolCall = (ctx, name, args) =>
  ctx.fulfill({
    headers: { "Content-Type": "text/event-stream" },
    body: sse(
      {
        choices: [
          {
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  id: `call_${Math.random().toString(36).slice(2, 8)}`,
                  type: "function",
                  function: { name, arguments: JSON.stringify(args) },
                },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ),
  });

// 每轮:先调 fill_input(带 pressEnterAfter,覆盖提交提示断言),工具往返后终答
mock.setRoutes([
  {
    match: (url) => url.includes("/chat/completions"),
    handle: async (ctx) => {
      const body = JSON.parse(ctx.params.request.postData ?? "{}");
      const msgs = body.messages ?? [];
      const lastUserIdx = msgs.map((m) => m.role).lastIndexOf("user");
      const usedTool = msgs
        .slice(lastUserIdx + 1)
        .some((m) => m.role === "tool");
      if (!usedTool) {
        return toolCall(ctx, "fill_input", {
          selector: "form > input#search-q",
          text: "确认门测试写入内容",
          pressEnterAfter: true,
        });
      }
      return answer(ctx, "明白,已停下。终答:CONFIRM_OK");
    },
  },
]);
console.log("✅ LLM mock 就绪(fill_input → 终答)");

// 面板 + 假配置(confirmActions 键缺席 = 默认开启,即被测默认态)
const sidepanel = await browser.newPage();
await sidepanel.goto(`chrome-extension://${extId}/sidepanel.html`);
await new Promise((r) => setTimeout(r, 1000));
await injectTestConfig(sidepanel);
console.log("🔑 已注入假 Key");
await sidepanel.reload();
await new Promise((r) => setTimeout(r, 1500));

const sendBtn = `button[aria-label="${zh.chat.send}"]`;
const denyBtn = `button[aria-label="${zh.chat.confirmDeny}"]`;
const allowBtn = `button[aria-label="${zh.chat.confirmAllow}"]`;
const card = '[role="alertdialog"]';

let passCount = 0;
let failCount = 0;
const assert = (name, cond, detail = "") => {
  if (cond) {
    passCount++;
    console.log(`  ✅ ${name}`);
  } else {
    failCount++;
    console.log(`  ❌ ${name} ${detail}`);
  }
};

/** 发消息但不等 run 结束(确认门会让 run 挂起等答复) */
async function sendOnly(text) {
  const input = sidepanel.locator(`textarea[aria-label="${zh.chat.askInput}"]`);
  await input.waitFor({ timeout: 5000 });
  await input.fill(text);
  await sidepanel.locator(sendBtn).click();
}
const waitIdle = () =>
  sidepanel.locator(sendBtn).waitFor({ state: "visible", timeout: 20000 });

const findToolLog = (entries, msgRe) =>
  entries.find(
    (e) => `${e.ctx}/${e.tag}` === "bg/tool" && msgRe.test(e.msg),
  );

try {
  // ---- 场景 1:默认开启 + 拒绝 ----
  console.log("\n── C1/C2 确认卡与拒绝 ──");
  await sendOnly("帮我在搜索框填写内容并提交");
  await sidepanel.locator(denyBtn).waitFor({ timeout: 20000 });
  const cardText = await sidepanel.locator(card).innerText();
  assert("确认卡弹出(默认开启)", true);
  assert("展示写入内容", cardText.includes("确认门测试写入内容"));
  assert("展示回车提交提示", cardText.includes("回车提交"));
  assert("展示元素定位", cardText.includes("search-q"));
  assert("展示目标页面", cardText.includes("目标页面"), `卡片内容:${cardText}`);

  await sidepanel.locator(denyBtn).click();
  await waitIdle();
  // 断言用「当前 run」日志窗口:mock 环境整轮 <100ms,时间窗会串进上一 run
  const entries1 = await readRunLogs(sidepanel);
  const denyLog = findToolLog(entries1, /fill_input 失败/);
  assert(
    "拒绝 → 工具未执行,declined 文案回给模型",
    !!denyLog && /declined/.test(denyLog.data ?? "{}"),
    JSON.stringify(denyLog?.data ?? null).slice(0, 200),
  );
  const answered1 = entries1.some(
    (e) => `${e.ctx}/${e.tag}` === "panel/chat" && /confirm answered/.test(e.msg) && /false/.test(`${e.data ?? ""}${e.msg}`),
  );
  assert("面板记录拒绝答复", answered1);

  // ---- 场景 2:允许 ----
  console.log("\n── C3 允许放行 ──");
  await sendOnly("再填一次");
  await sidepanel.locator(allowBtn).waitFor({ timeout: 20000 });
  await sidepanel.locator(allowBtn).click();
  await waitIdle();
  const entries2 = await readRunLogs(sidepanel);
  const okLog = findToolLog(entries2, /fill_input 完成/);
  const failLog = findToolLog(entries2, /fill_input 失败/);
  // 测试环境没有普通网页可注入,执行期失败也算放行;关键是错误不再是 declined,
  // 且能看到「confirm answered true」→ 门确实放行到了内容层
  const gatePassed =
    !!okLog || (!!failLog && !/declined/.test(failLog.data ?? "{}"));
  assert(
    "允许 → 门放行,工具真实分发",
    gatePassed,
    JSON.stringify(failLog?.data ?? okLog?.data ?? null).slice(0, 200),
  );
  const answered2 = entries2.some(
    (e) => `${e.ctx}/${e.tag}` === "panel/chat" && /confirm answered/.test(e.msg) && /true/.test(`${e.data ?? ""}${e.msg}`),
  );
  assert("面板记录允许答复", answered2);
  if (!gatePassed) {
    console.log(`  [debug] 场景 2 时间线:`);
    for (const e of entries2) {
      console.log(
        `    t=${e.t} [${e.ctx}/${e.tag}] ${e.msg} ${String(e.data ?? "").slice(0, 80)}`,
      );
    }
  }

  // ---- 场景 3:设置页开关存在(安全分节渲染) ----
  console.log("\n── 安全分节 ──");
  await sidepanel.locator(`button[aria-label="${zh.chat.openSettings}"]`).click();
  await sidepanel
    .locator('label, span, div')
    .filter({ hasText: zh.security.confirmActions })
    .first()
    .waitFor({ timeout: 10000 });
  assert("设置页出现「安全」分节与确认开关", true);
} catch (err) {
  failCount++;
  console.log("  ❌ 用例执行异常:", err.message);
} finally {
  await browser.close();
}

console.log(`\n结果:${passCount} 通过,${failCount} 失败`);
process.exit(failCount > 0 ? 1 : 0);
