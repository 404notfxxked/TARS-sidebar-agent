// 验证写操作确认门(安全 V1)
// 用法: pnpm build && node tests/verify-confirm.mjs
//
// CDP Fetch 拦截 LLM 端点,mock 模型先调一个「过门工具」再给终答,断言:
//   场景 1(C1/C2):默认开启(confirmActions 键缺席 = 开)弹确认卡,卡内
//       含目标页面 / 写入内容 / 回车提交提示 / 元素定位 —— 信息足够做决定;
//       拒绝后 fill_input 不执行,「declined」错误文案回给模型,run 正常收口
//   场景 2(C3):允许 → 门放行,工具真实分发(本测试环境无普通页面可注入,
//       执行期失败也算放行 —— 关键是错误不再是 declined)
//   场景 3(M):memory_save 过门(拒绝 → 拒;允许 → 落库)
//   场景 4(W):web_fetch 出口底线:私网必卡;白名单命中直抓
//   场景 5(W2):同轮两个白名单外 fetch 串行出卡(批次屏障)+ 同域复用
//   场景 6:设置页安全分节渲染

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  answerSSE,
  injectTestConfig,
  idbGetAll,
  launchWithCdp,
  makeChecker,
  openPanel,
  readRunLogs,
  sse,
  toolCallSSE,
  waitForRunLog,
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

const answer = answerSSE;
const toolCall = toolCallSSE;

// 每轮:先按 mode 发一个「过门工具」调用,工具往返后终答。
// 2026-09 确认门扩容后,这里覆盖三个族:页面写动作 / 记忆持久写 / web_fetch 出口底线
let mode = "fill"; // fill | memory | webfetch-private | webfetch-open | webfetch-parallel
let parStep = 0; // webfetch-parallel 的轮次推进(两连发 → 同域复用 → 终答)
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
      if (mode === "memory") {
        if (!usedTool) return toolCall(ctx, "memory_save", { content: "用户偏好深色界面" });
        return answer(ctx, "明白,已停下。终答:CONFIRM_OK");
      }
      if (mode === "webfetch-private") {
        if (!usedTool)
          return toolCall(ctx, "web_fetch", { url: "http://10.0.0.5:8080/internal/config" });
        return answer(ctx, "明白,已停下。终答:CONFIRM_OK");
      }
      if (mode === "webfetch-open") {
        if (!usedTool) return toolCall(ctx, "web_fetch", { url: "https://mock.test/open-page" });
        return answer(ctx, "明白,已停下。终答:CONFIRM_OK");
      }
      if (mode === "webfetch-parallel") {
        // 同轮两个白名单外 fetch:批次屏障下必须逐个出卡,不允许同批并发
        // 派发把先到的确认请求挤丢。第三跳复用已批准的域:
        // 批准即知情,同域不再重复弹卡。
        // 域名用本套件专属的 w2a/w2b.test:同会话前序场景已把 mock.test
        // 写进白名单,用它会让「首卡」错位到第二跳
        const call = (index, url) => ({
          index,
          id: `call_${index}_${Math.random().toString(36).slice(2, 8)}`,
          type: "function",
          function: { name: "web_fetch", arguments: JSON.stringify({ url }) },
        });
        if (parStep === 0) {
          parStep = 1;
          if (!usedTool) {
            return ctx.fulfill({
              headers: { "Content-Type": "text/event-stream" },
              body: sse(
                {
                  choices: [
                    {
                      delta: {
                        role: "assistant",
                        tool_calls: [
                          call(0, `https://w2a.test/a?k=${"x".repeat(320)}`),
                          call(1, `https://w2b.test/b?k=${"y".repeat(320)}`),
                        ],
                      },
                    },
                  ],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ),
            });
          }
        }
        if (parStep === 1) {
          parStep = 2;
          return ctx.fulfill({
            headers: { "Content-Type": "text/event-stream" },
            body: sse(
              {
                choices: [
                  {
                    delta: {
                      role: "assistant",
                      tool_calls: [call(0, `https://w2b.test/c?k=${"z".repeat(320)}`)],
                    },
                  },
                ],
              },
              { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
            ),
          });
        }
        return answer(ctx, "明白,已停下。终答:CONFIRM_OK");
      }
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
console.log("✅ LLM mock 就绪(mode 驱动:fill/memory/webfetch)");

// 面板 + 假配置(confirmActions 键缺席 = 默认开启,即被测默认态)
const sidepanel = await openPanel(browser, extId, { configure: injectTestConfig });

const sendBtn = `button[aria-label="${zh.chat.send}"]`;
const denyBtn = `button[aria-label="${zh.chat.confirmDeny}"]`;
const allowBtn = `button[aria-label="${zh.chat.confirmAllow}"]`;
const card = '[role="alertdialog"]';

const check = makeChecker();

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

let scene = null;
try {
  // ---- 场景 1:默认开启 + 拒绝 ----
  scene = "C1/C2 确认卡与拒绝";
  console.log("\n── C1/C2 确认卡与拒绝 ──");
  await sendOnly("帮我在搜索框填写内容并提交");
  await sidepanel.locator(denyBtn).waitFor({ timeout: 20000 });
  const cardText = await sidepanel.locator(card).innerText();
  check(
    (await sidepanel.locator(card).isVisible()) && cardText.trim().length > 0, "确认卡弹出(默认开启)", 
    `卡片内容:${cardText}`, 
  );
  check(cardText.includes("确认门测试写入内容"), "展示写入内容");
  check(cardText.includes(zh.chat.confirmSubmitHint), "展示回车提交提示");
  check(cardText.includes("search-q"), "展示元素定位");
  check(cardText.includes(zh.chat.confirmTarget.split("{")[0].trim()), "展示目标页面", `卡片内容:${cardText}`); // i18n-ok 断言标签(人读输出);惯用法统一后标签在第二参,不在守卫豁免窗内

  await sidepanel.locator(denyBtn).click();
  await waitIdle();
  // 断言用「当前 run」日志窗口:mock 环境整轮 <100ms,时间窗会串进上一 run
  const entries1 = await readRunLogs(sidepanel);
  const denyLog = findToolLog(entries1, /fill_input 失败/);
  check(
    !!denyLog && /declined/.test(denyLog.data ?? "{}"), "拒绝 → 工具未执行,declined 文案回给模型", 
    JSON.stringify(denyLog?.data ?? null).slice(0, 200), 
  );
  const answered1 = entries1.some(
    (e) => `${e.ctx}/${e.tag}` === "panel/chat" && /confirm answered/.test(e.msg) && /false/.test(`${e.data ?? ""}${e.msg}`),
  );
  check(answered1, "面板记录拒绝答复");

  // ---- 场景 2:允许 ----
  scene = "C3 允许放行";
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
  check(
    gatePassed, "允许 → 门放行,工具真实分发", 
    JSON.stringify(failLog?.data ?? okLog?.data ?? null).slice(0, 200), 
  );
  const answered2 = entries2.some(
    (e) => `${e.ctx}/${e.tag}` === "panel/chat" && /confirm answered/.test(e.msg) && /true/.test(`${e.data ?? ""}${e.msg}`),
  );
  check(answered2, "面板记录允许答复");
  if (!gatePassed) {
    console.log(`  [debug] 场景 2 时间线:`);
    for (const e of entries2) {
      console.log(
        `    t=${e.t} [${e.ctx}/${e.tag}] ${e.msg} ${String(e.data ?? "").slice(0, 80)}`,
      );
    }
  }

  // ---- 场景 3:memory_save 过门(拒绝 → 拒;允许 → 落库) ----
  scene = "M memory_save 确认门";
  console.log("\n── M memory_save 确认门(拒绝/允许)──");
  mode = "memory";
  await sendOnly("记住我喜欢深色界面");
  await sidepanel.locator(denyBtn).waitFor({ timeout: 20000 });
  const memCardText = await sidepanel.locator(card).innerText();
  check(
    memCardText.includes(zh.chat.confirmMemorySaveTitle), "确认卡为记忆族标题", 
    `卡片内容:${memCardText}`, 
  );
  check(memCardText.includes("用户偏好深色界面"), "展示将记住的内容");
  await sidepanel.locator(denyBtn).click();
  await waitIdle();
  const memRows1 = await idbGetAll(sidepanel, "memories");
  check(memRows1.length === 0, "拒绝 → 记忆未落库",  JSON.stringify(memRows1.map((r) => r.text)));
  const entriesM1 = await readRunLogs(sidepanel);
  const memDenyLog = findToolLog(entriesM1, /memory_save 失败/);
  check(
    !!memDenyLog && /declined/.test(memDenyLog.data ?? "{}"), "拒绝 → declined 文案回给模型", 
    JSON.stringify(memDenyLog?.data ?? null).slice(0, 200), 
  );

  await sendOnly("再记一次");
  await sidepanel.locator(allowBtn).waitFor({ timeout: 20000 });
  await sidepanel.locator(allowBtn).click();
  await waitIdle();
  const memRows2 = await idbGetAll(sidepanel, "memories");
  check(
    memRows2.length === 1 && memRows2[0].text === "用户偏好深色界面", "允许 → 记忆落库(source=model)", 
    JSON.stringify(memRows2.map((r) => r.text)), 
  );

  // ---- 场景 4:web_fetch 出口底线(私网过门;公开页直抓) ----
  scene = "W web_fetch 出口底线";
  console.log("\n── W web_fetch 出口底线 ──");
  await sidepanel.evaluate(() =>
    chrome.storage.local.set({ webSearch: true }),
  );
  mode = "webfetch-private";
  await sendOnly("读一下内网配置页");
  await sidepanel.locator(denyBtn).waitFor({ timeout: 20000 });
  const wfCardText = await sidepanel.locator(card).innerText();
  check(
    wfCardText.includes(zh.chat.confirmWebFetchTitle), "私网目标弹确认卡(外链族标题)", 
    `卡片内容:${wfCardText}`, 
  );
  check(wfCardText.includes("10.0.0.5"), "展示目标链接");
  await sidepanel.locator(denyBtn).click();
  await waitIdle();
  const entriesW1 = await readRunLogs(sidepanel);
  const wfDenyLog = findToolLog(entriesW1, /web_fetch 失败/);
  check(
    !!wfDenyLog && /declined/.test(wfDenyLog.data ?? "{}"), "私网拒绝 → declined 文案回给模型", 
    JSON.stringify(wfDenyLog?.data ?? null).slice(0, 200), 
  );

  mode = "webfetch-open";
  // 会话来源域白名单:URL 出自用户消息 → 命中 → 不弹卡直抓
  await sendOnly("读一个公开页 https://mock.test/open-page");
  // 公开页要真实走一次 fetch(DNS 失败需数秒),waitIdle 的两段判定有
  // 既有竞态 —— 事件驱动等工具日志出现(若被门拦住,工具日志不会出现)。
  // ⚠️ 谓词必须按本轮 URL 限定:run started 落库晚一拍时,run 窗口仍停在
  // 上一轮(私网拒绝),宽松匹配会立刻假阳性命中上一轮的 declined
  // (2026-09-30 CI release 预检实测)。W2 场景第三跳的同款限定是既有先例
  const entriesW2 = await waitForRunLog(
    sidepanel,
    (e) =>
      `${e.ctx}/${e.tag}` === "bg/tool" &&
      /web_fetch (失败|完成)/.test(e.msg) &&
      /mock\.test\/open-page/.test(e.data ?? "{}"),
    "web_fetch 直达执行日志",
  );
  check((await sidepanel.locator(card).count()) === 0, "白名单内链接不弹确认卡");
  const wfOpenLog = entriesW2.find(
    (e) =>
      `${e.ctx}/${e.tag}` === "bg/tool" &&
      /web_fetch (失败|完成)/.test(e.msg) &&
      /mock\.test\/open-page/.test(e.data ?? "{}"),
  );
  check(
    !!wfOpenLog && !/declined/.test(wfOpenLog.data ?? "{}"), "白名单命中直达工具(失败也非 declined)", 
    JSON.stringify(wfOpenLog?.data ?? null).slice(0, 200), 
  );

  // ---- 场景 5:同轮两个白名单外 fetch 串行出卡(批次屏障) ----
  scene = "W2 双白名单外 fetch 串行确认";
  console.log("\n── W2 同轮双过门 fetch:逐个出卡 + 同域复用 ──");
  // 上一轮(mock.test DNS 失败要数秒)收口后再发:发送钮仍隐藏时 sendOnly
  // 会白等 30s(CI release 预检实测)
  await waitIdle();
  mode = "webfetch-parallel";
  parStep = 0;
  await sendOnly("把这两个链接都读一下");
  await sidepanel.locator(allowBtn).waitFor({ timeout: 20000 });
  check(
    (await sidepanel.locator(card).count()) === 1, "第一批屏障生效:场上只有一张确认卡", 
  );
  const cardA = await sidepanel.locator(card).innerText();
  check(
    cardA.includes(zh.chat.confirmWebFetchQuery.replace("{n}", "322")) &&
      !/x{40}/.test(cardA), "长参数只报字符数、不上原文(search 323 含?,参数 322)", 
    `卡片:${cardA.slice(0, 160)}`, 
  );
  await sidepanel.locator(allowBtn).click();
  // 第一批完整收口(工具日志在场)后第二张卡才出现 —— 屏障串行化的时序证据。
  // 谓词按 w2a 限定:宽匹配会命中上一轮 open-page 的失败日志(run started
  // 落库晚一拍的窗口串轮,见场景 4 注)
  await waitForRunLog(
    sidepanel,
    (e) =>
      `${e.ctx}/${e.tag}` === "bg/tool" &&
      /web_fetch 失败/.test(e.msg) &&
      /w2a\.test/.test(e.data ?? "{}"),
    "第一个 fetch 执行完毕",
  );
  await sidepanel.locator(allowBtn).waitFor({ timeout: 20000 });
  check(
    (await sidepanel.locator(card).count()) === 1, "另一个白名单外域随后单独出卡(w2a 已批准,不牵连 w2b)", 
  );
  await sidepanel.locator(allowBtn).click();
  // 第三跳复用已批准的 w2b 域:批准即知情,不再弹卡
  await waitForRunLog(
    sidepanel,
    (e) =>
      `${e.ctx}/${e.tag}` === "bg/tool" &&
      /web_fetch 失败/.test(e.msg) &&
      /w2b\.test/.test(e.data ?? "{}"),
    "同域复用跳直达执行",
  );
  check(
    (await sidepanel.locator(card).count()) === 0, "批准过的域同 run 内不再重复弹卡", 
  );
  await waitIdle();
  const entriesP = await readRunLogs(sidepanel);
  const fetchFails = entriesP.filter(
    (e) => `${e.ctx}/${e.tag}` === "bg/tool" && /web_fetch 失败/.test(e.msg),
  );
  check(
    fetchFails.length === 3 &&
      fetchFails.every((e) => !/declined/.test(e.data ?? "{}")), "三个 fetch 都逐个真实执行(未 declined)", 
    JSON.stringify(fetchFails.map((e) => e.data)).slice(0, 300), 
  );

  // ---- 场景 6:设置页开关存在(安全分节渲染) ----
  scene = "安全分节";
  console.log("\n── 安全分节 ──");
  await sidepanel.locator(`button[aria-label="${zh.chat.openSettings}"]`).click();
  const securityRow = sidepanel
    .locator('label, span, div')
    .filter({ hasText: zh.security.confirmActions })
    .first();
  await securityRow.waitFor({ timeout: 10000 });
  check(
    (await securityRow.count()) > 0, "设置页出现「安全」分节与确认开关", 
  );
} catch (err) {
  // 场景名 + 完整堆栈:失败要能定位到哪个场景哪一行,而不是折成一个匿名红点
  check(false, `场景「${scene ?? "初始化"}」执行异常`, err.stack ?? String(err));
} finally {
  await browser.close();
}

const passCount = check.failures.length;
console.log(`\n结果:异常断言 ${passCount} 条`);
process.exit(passCount > 0 ? 1 : 0);
