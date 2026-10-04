// 验证写操作确认门(安全 V1 + 三档 confirmLevel)
// 用法: pnpm build && node tests/verify-confirm.mjs
//
// CDP Fetch 拦截 LLM 端点,mock 模型先调一个「过门工具」再给终答,断言:
//   场景 1(C1/C2):默认开启(confirmLevel 键缺席 = strict)弹确认卡,卡内
//       含目标页面 / 写入内容 / 回车提交提示 / 元素定位 —— 信息足够做决定;
//       拒绝后 fill_input 不执行,「declined」错误文案回给模型,run 正常收口
//   场景 2(C3):允许 → 门放行,工具真实分发(本测试环境无普通页面可注入,
//       执行期失败也算放行 —— 关键是错误不再是 declined)
//   场景 3(M):memory_save 过门(拒绝 → 拒;允许 → 落库)
//   场景 4(W):web_fetch 出口底线:私网必卡;白名单命中直抓
//   场景 5(W2):同轮两个白名单外 fetch 串行出卡(批次屏障)+ 同域复用
//   场景 7(OFF):confirmLevel=off → click/fill/memory 全程无卡真实分发
//   场景 8(AUTO):confirmLevel=auto → click 免门;memory_save 仍过门,
//       拒绝后 declined 回给模型
//   场景 9(PILL):composer 档位 pill —— 存储跟随/菜单切 strict 弹卡
//       declined/菜单三项含 off(三档同权)/点 off 下一轮全程无卡
//   场景 6:设置页安全分节渲染(站点授权在场;档位已迁 pill,反向断言)

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
// 2026-09 确认门扩容后,这里覆盖三个族:页面写动作 / 记忆持久写 / web_fetch 出口底线;
// 2026-10 三档化新增 click 档(off/auto 场景的页面写族用,含免门分发语义)
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
      // 本轮意图按消息文本自描述路由(2026-10-02 改造):click_element 在真实
      // 标签页上执行可达数十秒,跨轮全局 mode 会在慢工具执行期间被下一场景
      // 覆盖,让在途请求被错误伺服 —— 路由必须与到达时序解耦
      const lastUser = String(msgs[lastUserIdx]?.content ?? "");
      if (/记住我喜欢简洁回答/.test(lastUser)) {
        // off 场景专用新文本:同文记忆会被 addMemory 去重(少而精语义),
        // 用新文本才能以条数增加佐证免门落库
        if (!usedTool) return toolCall(ctx, "memory_save", { content: "用户偏好简洁回答" });
        return answer(ctx, "明白,已停下。终答:CONFIRM_OK");
      }
      if (/记住我喜欢深色界面|再记一次/.test(lastUser)) {
        if (!usedTool) return toolCall(ctx, "memory_save", { content: "用户偏好深色界面" });
        return answer(ctx, "明白,已停下。终答:CONFIRM_OK");
      }
      if (/点一下提交按钮/.test(lastUser)) {
        if (!usedTool)
          return toolCall(ctx, "click_element", {
            selector: "form > button[type=submit]",
          });
        return answer(ctx, "明白,已停下。终答:CONFIRM_OK");
      }
      if (/读一下内网配置页/.test(lastUser)) {
        if (!usedTool)
          return toolCall(ctx, "web_fetch", { url: "http://10.0.0.5:8080/internal/config" });
        return answer(ctx, "明白,已停下。终答:CONFIRM_OK");
      }
      if (/open-page/.test(lastUser)) {
        if (!usedTool) return toolCall(ctx, "web_fetch", { url: "https://mock.test/open-page" });
        return answer(ctx, "明白,已停下。终答:CONFIRM_OK");
      }
      if (/两个链接/.test(lastUser)) {
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
console.log("✅ LLM mock 就绪(按本轮用户消息文本自描述路由)");

// 面板 + 假配置(confirmLevel 键缺席 = strict,安全默认)
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

  // ---- 场景 7:off 档全部放行 ----
  // 切档照场景 4 的 storage.set 先例;run 开始快照 → 对后续新 run 生效。
  // 断言口径:工具日志在场(失败也行)且无 declined + 场上无确认卡 ——
  // 别只断言卡不在(免门后工具必须真的分发了)
  scene = "OFF 全部放行";
  console.log("\n── OFF 全部放行 ──");
  await sidepanel.evaluate(() =>
    chrome.storage.local.set({ confirmLevel: "off" }),
  );
  await sendOnly("点一下提交按钮");
  // 等工具日志而非 send 钮可见:点击瞬间 send 钮尚可见(翻转在 React 渲染
  // 批次里),waitIdle 会假通过 —— 断言时机必须事件驱动(run 窗口轮询)
  const entriesOff1 = await waitForRunLog(
    sidepanel,
    (e) =>
      `${e.ctx}/${e.tag}` === "bg/tool" &&
      /click_element (失败|完成)/.test(e.msg),
    "off click 轮工具日志",
  );
  const clickOff = findToolLog(entriesOff1, /click_element (失败|完成)/);
  check(
    !!clickOff && !/declined/.test(clickOff.data ?? "{}"), "off:click 免门真实分发(失败也非 declined)",
    JSON.stringify(clickOff?.data ?? null).slice(0, 200),
  );
  check((await sidepanel.locator(card).count()) === 0, "off:click 无确认卡");

  await sendOnly("再填一次");
  const entriesOff2 = await waitForRunLog(
    sidepanel,
    (e) =>
      `${e.ctx}/${e.tag}` === "bg/tool" &&
      /fill_input (失败|完成)/.test(e.msg),
    "off fill 轮工具日志",
  );
  const fillOff = findToolLog(entriesOff2, /fill_input (失败|完成)/);
  check(
    !!fillOff && !/declined/.test(fillOff.data ?? "{}"), "off:fill(提交型)免门真实分发",
    JSON.stringify(fillOff?.data ?? null).slice(0, 200),
  );

  await sendOnly("记住我喜欢简洁回答");
  const offMemLog = await waitForRunLog(
    sidepanel,
    (e) =>
      `${e.ctx}/${e.tag}` === "bg/tool" &&
      /memory_save (失败|完成)/.test(e.msg),
    "off memory 轮工具日志",
  );
  const offMemDone = offMemLog.some(
    (e) =>
      `${e.ctx}/${e.tag}` === "bg/tool" && /memory_save 完成/.test(e.msg),
  );
  const memRowsOff = await idbGetAll(sidepanel, "memories");
  check(
    offMemDone && memRowsOff.length === 2, "off:memory_save 免门直接落库(场景 3 已落 1 条)",
    JSON.stringify(memRowsOff.map((r) => r.text)),
  );
  check((await sidepanel.locator(card).count()) === 0, "off:全程无确认卡");

  // ---- 场景 8:auto 档仅页面操作放行 ----
  scene = "AUTO 仅页面操作放行";
  console.log("\n── AUTO 仅页面操作放行 ──");
  await sidepanel.evaluate(() =>
    chrome.storage.local.set({ confirmLevel: "auto" }),
  );
  await sendOnly("点一下提交按钮");
  const entriesAuto1 = await waitForRunLog(
    sidepanel,
    (e) =>
      `${e.ctx}/${e.tag}` === "bg/tool" &&
      /click_element (失败|完成)/.test(e.msg),
    "auto click 轮工具日志",
  );
  const clickAuto = findToolLog(entriesAuto1, /click_element (失败|完成)/);
  check(
    !!clickAuto && !/declined/.test(clickAuto.data ?? "{}"), "auto:click 免门真实分发",
    JSON.stringify(clickAuto?.data ?? null).slice(0, 200),
  );
  check((await sidepanel.locator(card).count()) === 0, "auto:click 无确认卡");

  await sendOnly("记住我喜欢深色界面");
  await sidepanel.locator(denyBtn).waitFor({ timeout: 20000 });
  const memCardAuto = await sidepanel.locator(card).innerText();
  check(
    memCardAuto.includes(zh.chat.confirmMemorySaveTitle), "auto:memory_save 仍过门(记忆族标题)",
    `卡片内容:${memCardAuto}`,
  );
  await sidepanel.locator(denyBtn).click();
  const entriesAuto2 = await waitForRunLog(
    sidepanel,
    (e) =>
      `${e.ctx}/${e.tag}` === "bg/tool" &&
      /memory_save 失败/.test(e.msg),
    "auto memory 拒绝日志",
  );
  const memDenyAuto = findToolLog(entriesAuto2, /memory_save 失败/);
  check(
    !!memDenyAuto && /declined/.test(memDenyAuto.data ?? "{}"), "auto:拒绝后 declined(CONFIRM_DENIED 语义)回给模型",
    JSON.stringify(memDenyAuto?.data ?? null).slice(0, 200),
  );
  const memRowsAuto = await idbGetAll(sidepanel, "memories");
  check(
    memRowsAuto.length === 2, "auto:拒绝 → 记忆未新增",
    JSON.stringify(memRowsAuto.map((r) => r.text)),
  );

  // ---- 场景 9:composer 档位 pill ----
  scene = "composer 档位 pill";
  console.log("\n── composer 档位 pill ──");
  // 直写 storage 切 auto:run 快照对下一轮生效,pill 文案经 storage 订阅跟随
  await sidepanel.evaluate(() =>
    chrome.storage.local.set({ confirmLevel: "auto" }),
  );
  const pillAuto = sidepanel.getByRole("button", {
    name: zh.chat.confirmPillAria.replace(
      "{level}",
      zh.security.confirmLevelAuto,
    ),
  });
  await pillAuto.waitFor({ timeout: 5000 });
  check(
    (await pillAuto.textContent())?.includes(zh.chat.confirmPillAuto) === true,
    "pill 文案跟随存储档位(auto 短标)",
  );

  await sendOnly("点一下提交按钮");
  const entriesPill1 = await waitForRunLog(
    sidepanel,
    (e) =>
      `${e.ctx}/${e.tag}` === "bg/tool" &&
      /click_element (失败|完成)/.test(e.msg),
    "pill auto 轮 click 工具日志",
  );
  const clickPill = entriesPill1.find(
    (e) => `${e.ctx}/${e.tag}` === "bg/tool" && /click_element (失败|完成)/.test(e.msg),
  );
  check(
    !!clickPill && !/declined/.test(clickPill.data ?? "{}"), "auto:pill 档下 click 免门真实分发",
    JSON.stringify(clickPill?.data ?? null).slice(0, 200),
  );
  check((await sidepanel.locator(card).count()) === 0, "auto:pill 档下 click 无确认卡");

  // 从 pill 菜单点「每步确认」:composer 侧切换真的落档(下一轮 strict 弹卡)
  await pillAuto.click();
  const strictOption = sidepanel.getByRole("option", {
    name: new RegExp(zh.chat.confirmPillStrict),
  });
  await strictOption.waitFor({ timeout: 5000 });
  check(
    (await sidepanel.locator('[role="option"]').count()) === 3,
    "pill 菜单三项(strict/auto/off,三档同权)",
  );
  check(
    (await sidepanel
      .locator('[role="option"]')
      .filter({ hasText: zh.chat.confirmPillOff })
      .count()) === 1, "off 项在场且带 desc(T6 撤销「到不了 off」结构属性)",
  );
  // 菜单几何(间距修法的硬防线):三行带说明在 180px 上限内不滚不裁,
  // 且首行高亮贴菜单上沿(基座垂直内边距已由 combo-pop--list 撤掉)。
  // 元素缺席时回同形状的判别结果(ok/why),别让 getBoundingClientRect
  // 抛裸 TypeError(前置 strictOption.waitFor 已保证在场,这里是防御性判空)
  const menuFit = await sidepanel.evaluate(() => {
    const pop = document.querySelector('[role="listbox"]');
    const first = document.querySelector('[role="option"]');
    if (!pop) {
      return { ok: false, why: "listbox 不在场(菜单没开?)", padTop: -1, gapFirst: -1, overflows: true };
    }
    if (!first) {
      return { ok: false, why: "菜单内无 option", padTop: -1, gapFirst: -1, overflows: true };
    }
    const cs = getComputedStyle(pop);
    return {
      ok: true,
      why: "",
      padTop: Number.parseFloat(cs.paddingTop),
      gapFirst: first.getBoundingClientRect().top - pop.getBoundingClientRect().top,
      overflows: pop.scrollHeight > pop.clientHeight,
    };
  });
  check(
    menuFit.ok && menuFit.padTop === 0 && menuFit.gapFirst === 0,
    "pill 菜单首行高亮贴面上沿(无容器内边距空带)",
    JSON.stringify(menuFit),
  );
  check(
    menuFit.ok && !menuFit.overflows,
    "pill 菜单三行不溢出(末行说明不被裁,无需滚动)",
    JSON.stringify(menuFit),
  );
  await strictOption.click();
  const pillStrict = sidepanel.getByRole("button", {
    name: zh.chat.confirmPillAria.replace(
      "{level}",
      zh.security.confirmLevelStrict,
    ),
  });
  await pillStrict.waitFor({ timeout: 5000 });

  await sendOnly("点一下提交按钮");
  await sidepanel.locator(denyBtn).waitFor({ timeout: 20000 });
  await sidepanel.locator(denyBtn).click();
  const entriesPill2 = await waitForRunLog(
    sidepanel,
    (e) =>
      `${e.ctx}/${e.tag}` === "bg/tool" &&
      /click_element 失败/.test(e.msg),
    "pill strict 轮拒绝日志",
  );
  const clickDeny = entriesPill2.find(
    (e) => `${e.ctx}/${e.tag}` === "bg/tool" && /click_element 失败/.test(e.msg),
  );
  check(
    !!clickDeny && /declined/.test(clickDeny.data ?? "{}"), "pill 菜单切 strict → click 弹卡,拒绝后 declined 回给模型",
    JSON.stringify(clickDeny?.data ?? null).slice(0, 200),
  );

  // 从 pill 菜单点「全部放行」:三档同权单击落档(T6),下一轮全程无卡
  await pillStrict.click();
  const offOption = sidepanel.getByRole("option", {
    name: new RegExp(zh.chat.confirmPillOff),
  });
  await offOption.waitFor({ timeout: 5000 });
  await offOption.click();
  const pillOff = sidepanel.getByRole("button", {
    name: zh.chat.confirmPillAria.replace(
      "{level}",
      zh.security.confirmLevelOff,
    ),
  });
  await pillOff.waitFor({ timeout: 5000 });
  check(
    (await pillOff.getAttribute("class"))?.includes("text-warning") === true,
    "off 态 pill 带 warning 色常驻标示",
  );

  await sendOnly("点一下提交按钮");
  // 切窗风险:run 窗口以「最后一次 run started」为界,而上一轮(strict 拒绝)
  // 的日志在新 run 落地前仍在窗口内 —— 只等 click 日志会抓到上一轮的
  // declined。分两步过窗:先等本轮 run config 记下 confirmLevel=off,
  // 再等 click 工具日志,并取最后一条(取首条仍可能够到上一轮的残影)
  await waitForRunLog(
    sidepanel,
    (e) =>
      `${e.ctx}/${e.tag}` === "bg/agent" &&
      /^run config/.test(e.msg) &&
      /"confirmLevel":"off"/.test(e.data ?? ""),
    "pill off 轮 run config(confirmLevel=off)",
  );
  const clickLogged = (e) =>
    `${e.ctx}/${e.tag}` === "bg/tool" && /click_element (失败|完成)/.test(e.msg);
  const entriesPill3 = await waitForRunLog(
    sidepanel,
    clickLogged,
    "pill off 轮 click 工具日志",
  );
  const clickPillOff = entriesPill3.filter(clickLogged).pop();
  check(
    !!clickPillOff && !/declined/.test(clickPillOff.data ?? "{}"), "off:pill 菜单单击切 off → click 免门真实分发",
    JSON.stringify(clickPillOff?.data ?? null).slice(0, 200),
  );
  check((await sidepanel.locator(card).count()) === 0, "off:pill 档下 click 无确认卡");
  // 回到 auto:场景 6 之后无残留高敏档,后续套件不受影响
  await sidepanel.evaluate(() =>
    chrome.storage.local.set({ confirmLevel: "auto" }),
  );

  // ---- 场景 6:设置页安全分节(档位已迁 pill,反向断言) ----
  scene = "安全分节";
  console.log("\n── 安全分节 ──");
  await sidepanel.locator(`button[aria-label="${zh.chat.openSettings}"]`).click();
  // 分节仍在:站点授权是读页/搜索/读网页的总闸
  const hostRow = sidepanel
    .locator('label, span, div')
    .filter({ hasText: zh.security.hostAccess })
    .first();
  await hostRow.waitFor({ timeout: 10000 });
  check(
    (await hostRow.count()) > 0, "设置页「安全」分节在场(站点授权行)",
  );
  // 档位已迁 composer pill(T7):分节内不应再出现档位单选
  for (const label of [
    zh.security.confirmLevelStrict,
    zh.security.confirmLevelAuto,
    zh.security.confirmLevelOff,
  ]) {
    check(
      (await sidepanel.getByRole("radio", { name: label }).count()) === 0, `档位单选不在设置页(${label})`,
    );
  }
} catch (err) {
  // 场景名 + 完整堆栈:失败要能定位到哪个场景哪一行,而不是折成一个匿名红点
  check(false, `场景「${scene ?? "初始化"}」执行异常`, err.stack ?? String(err));
} finally {
  await browser.close();
}

const passCount = check.failures.length;
console.log(`\n结果:异常断言 ${passCount} 条`);
process.exit(passCount > 0 ? 1 : 0);
