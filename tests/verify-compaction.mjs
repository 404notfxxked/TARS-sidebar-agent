// 验证上下文压缩(第二层:摘要式 compaction)
// 用法: pnpm build && node tests/verify-compaction.mjs
//   网络受限环境: VERIFY_PROXY=http://127.0.0.1:8118 (mock 全在 CDP 层,一般不需要)
//
// 用 CDP Fetch 拦截 LLM 端点,断言:
//   S1. 触发与滚动:超阈值 run 前先发摘要调用;agent 请求含 <context-summary>
//       且不含被压缩轮原文;库仍是全量历史;二次触发合并旧摘要(rolling)
//   S1b. HISTORY 载荷带 compaction 元数据与消息 seq;UI 渲染压缩分隔条
//   S2. 压缩用模型:摘要请求 model=cheap-test、agent 请求 model=gpt-test
//       引用失效(ghost)时回落当前模型 + 告警日志
//   S3. 摘要调用 500 → 回退溢出裁剪,run 正常完成
//   S4. 档位生效:同一份历史,early 档触发、late 档不触发
//   S5. 未配 contextTokens → 永不触发
//   S6. run 中途撞窗(400 maximum context length)→ 紧急压缩后重试成功
//
// 历史种子:直接写扩展 origin 的 IndexedDB(db "tars"),run 用裸 port 驱动
// 指定 sessionId(不经 UI,避免面板会话状态的干扰)。

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { answerSSE, idbMessages, launchWithCdp, makeChecker, openPanel, runAskViaPort, seedProviders, waitForRunLog } from "./lib-cdp-mock.mjs";
import { zh } from "./lib-i18n.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(__dirname, "..", "dist");
const USER_DATA_DIR = `/tmp/verify-compaction-${Date.now()}`;

// ---- LLM mock 状态 ----
const llm = {
  calls: [], // {model, isSummary, ts}
  summaryMode: "ok", // ok | 500
  overflowArmed: false,
  overflowDone: false,
};
let summaryTexts = []; // 已返回的摘要文本(rolling 断言用)
let lastSummaryInput = null; // 最近一次摘要请求的 messages
let lastAgentBody = null; // 最近一次 agent 请求的 body(断言 summary 注入/原文排除)

const answer = (ctx, text, usage) => answerSSE(ctx, text, { usage });

const { browser, extId, mock } = await launchWithCdp({
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
      const sys = body.messages?.[0]?.content ?? "";
      const isSummary = !body.tools && sys.includes("compress the history of an AI assistant conversation");
      llm.calls.push({ model: body.model, isSummary, ts: Date.now() });
      if (isSummary) {
        if (llm.summaryMode === "500") {
          return ctx.fulfill({ status: 500, body: "summary backend down" });
        }
        lastSummaryInput = body.messages;
        const text = `摘要#${summaryTexts.length + 1}:早期对话压缩要点(压缩主会话/MARK 相关内容已收编)`;
        summaryTexts.push(text);
        return answer(ctx, text);
      }
      lastAgentBody = body;
      if (llm.overflowArmed && !llm.overflowDone) {
        llm.overflowDone = true;
        return ctx.fulfill({
          status: 400,
          body: JSON.stringify({
            error: {
              message:
                "This model's maximum context length is 4096 tokens. However, your messages resulted in 5000 tokens.",
            },
          }),
        });
      }
      return answer(ctx, "终答:LAST_OK", {
        prompt_tokens: 4321,
        completion_tokens: 6,
        total_tokens: 4327,
      });
    },
  },
]);
console.log("✅ mock 路由已注册");

// ---- 面板 + 配置 ----
const sidepanel = await openPanel(browser, extId);

const check = makeChecker();

/** 写 providers 配置(新 schema;SW 每次 run 现读)。models 里 cheap-test
 *  供「压缩用模型」场景引用 */
async function setModelCfg(contextTokens) {
  const models = [{ id: "gpt-test", ...(contextTokens ? { contextTokens } : {}) }, { id: "cheap-test" }];
  await seedProviders(sidepanel, models);
}
const setCompactCfg = (patch) =>
  sidepanel.evaluate((p) => chrome.storage.local.set(p), patch);

/** 直接种一个会话:rounds 轮(user+assistant),每条消息 cjkChars 个汉字
 *  + 唯一标记(估算按 CJK≈1.1 tok/字,估算量级可控) */
async function seedSession(id, title, rounds, cjkChars) {
  await sidepanel.evaluate(
    ({ id, title, rounds, cjkChars }) =>
      new Promise((done, fail) => {
        const msgs = [];
        for (let i = 0; i < rounds; i++) {
          msgs.push({
            role: "user",
            content: `第${i}轮问题 MARK-${id}-R${i} ${"测".repeat(cjkChars)}`,
          });
          msgs.push({
            role: "assistant",
            content: `第${i}轮回答 ANS-${id}-R${i} ${"测".repeat(cjkChars)}`,
          });
        }
        const req = indexedDB.open("tars");
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(["sessions", "messages"], "readwrite");
          msgs.forEach((msg, seq) => {
            tx.objectStore("messages").put({ sessionId: id, seq, msg });
          });
          tx.objectStore("sessions").put({
            id,
            title,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            msgCount: msgs.length,
          });
          tx.oncomplete = () => {
            db.close();
            done();
          };
          tx.onerror = () => fail(tx.error);
        };
        req.onerror = () => fail(req.error);
      }),
    { id, title, rounds, cjkChars },
  );
}

/** 读会话行(compaction/ctx/msgCount 断言用) */
const readSessionRow = (sessionId) =>
  sidepanel.evaluate(
    (sessionId) =>
      new Promise((done, fail) => {
        const req = indexedDB.open("tars");
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("sessions", "readonly");
          const q = tx.objectStore("sessions").get(sessionId);
          q.onsuccess = () => {
            db.close();
            done(q.result);
          };
          q.onerror = () => fail(q.error);
        };
      }),
    sessionId,
  );

/** 裸 port 驱动一次 run(不经 UI):发 USER_MESSAGE,等 agent_done/error */
const runAsk = (sessionId, text) => runAskViaPort(sidepanel, sessionId, text);

/** 裸 port 拉 HISTORY(载荷形状断言用) */
const loadHistoryPayload = (sessionId) =>
  sidepanel.evaluate(
    (sessionId) =>
      new Promise((resolve) => {
        const port = chrome.runtime.connect({ name: "agent-port" });
        port.onMessage.addListener((msg) => {
          if (msg.type === "history") {
            port.disconnect();
            resolve(msg);
          }
        });
        port.postMessage({ type: "load_history", sessionId });
      }),
    sessionId,
  );

const summaryCallsSince = (n) =>
  llm.calls.filter((c) => c.isSummary).length - n;

/** 轮询等待某条「本 run 窗口内」的日志出现(与 waitForRunLog 同语义,包一层
 *  只为断言写法简洁;storage 写入偶发晚于 run 结束,一次性读取会假阴性) */
const waitRunLog = (predicate, label) =>
  waitForRunLog(sidepanel, predicate, label);

// ---- S1:触发 + 摘要注入 + 全量历史保留 + 滚动 ----
console.log("\n===== S1. 触发:摘要调用 + <context-summary> 注入 + 库保全量 =====");
await setModelCfg(8000); // usable = 8000-4096-1600 = 2304;标准档阈值 1728,种子历史远超
await setCompactCfg({ compact: "standard" });
await seedSession("s-main", "压缩主会话", 3, 1100);
{
  const rowsBefore = (await idbMessages(sidepanel, "s-main")).length;
  const before = llm.calls.length;
  const done = await runAsk("s-main", "新问题:总结一下前面聊的(S1)");
  check(done.type === "agent_done", "S1-0 run 正常完成", JSON.stringify(done));

  const summaryCount = llm.calls.slice(before).filter((c) => c.isSummary).length;
  check(summaryCount === 1, `S1-1 run 前恰好一次摘要调用(${summaryCount})`);
  check(lastAgentBody?.model === "gpt-test",
    "S1-2 未配压缩模型时摘要/主对话都用当前模型", lastAgentBody?.model);
  const agentText = JSON.stringify(lastAgentBody);
  check(agentText.includes("<context-summary>"),
    "S1-3 agent 请求含压缩摘要消息", agentText.slice(0, 200));
  check(!agentText.includes("MARK-s-main-R0"),
    "S1-4 被压缩的第一轮原文不再进入 prompt");
  check(agentText.includes("MARK-s-main-R2"),
    "S1-5 保留尾部的最后一轮原文仍在 prompt");

  const rowsAfter = await idbMessages(sidepanel, "s-main");
  check(rowsAfter.length === rowsBefore + 2,
    `S1-6 库保全量:行数 ${rowsBefore} → ${rowsAfter.length}(+2 本轮新增)`);
  const row = await readSessionRow("s-main");
  check(row?.compaction && row.compaction.uptoSeq >= 1,
    "S1-7 会话行写入压缩元数据(uptoSeq)", JSON.stringify(row?.compaction));
  check(row?.msgCount === rowsAfter.length,
    `S1-8 msgCount=实际行数(${row?.msgCount} vs ${rowsAfter.length})`);
  check(row?.ctx?.promptTokens === 4321,
    "S1-9 实测 token 基线已存会话行", JSON.stringify(row?.ctx));
}
console.log("\n===== S1b. 滚动压缩:二次触发合并旧摘要 =====");
{
  const before = llm.calls.length;
  await runAsk("s-main", "新问题:再总结一次(S1b)");
  const summaryCount = llm.calls.slice(before).filter((c) => c.isSummary).length;
  check(summaryCount === 1, `S1b-1 二次 run 又一次摘要调用(${summaryCount})`);
  const inputText = JSON.stringify(lastSummaryInput);
  check(inputText.includes("<previous_summary>") && inputText.includes("摘要#1"),
    "S1b-2 摘要输入含旧摘要(rolling)", inputText.slice(0, 200));
}

console.log("\n===== S1c. HISTORY 载荷 + 压缩分隔条 =====");
{
  const payload = await loadHistoryPayload("s-main");
  check(payload.messages.length > 0 && payload.messages.every((m) => typeof m.seq === "number"),
    "S1c-1 HISTORY 消息带 seq");
  check(payload.compaction && typeof payload.compaction.uptoSeq === "number",
    "S1c-2 HISTORY 载荷带 compaction 元数据", JSON.stringify(payload.compaction));

  // UI:会话列表 → 点开 s-main → 分隔条出现在压缩点(前一段是最后一条
  // 被压缩的消息,后一段是压缩点之后的首条 —— 位置错误照常 FAIL)
  await sidepanel.locator(`button[aria-label="${zh.chat.openSessions}"]`).click();
  await sidepanel.locator('li button', { hasText: "压缩主会话" }).first().click();
  await sidepanel.locator(".ctx-divider").waitFor({ timeout: 5000 });
  const upto = payload.compaction.uptoSeq;
  const firstAfter = payload.messages.find((m) => m.seq > upto);
  const lastBefore = [...payload.messages].reverse().find((m) => m.seq <= upto);
  const markerOf = (m) => (m.content.match(/MARK-\S+/) ?? [""])[0];
  const split = await sidepanel.evaluate(() => {
    const divider = document.querySelector(".ctx-divider");
    if (!divider?.parentElement) return null;
    const kids = [...divider.parentElement.children];
    const di = kids.indexOf(divider);
    return {
      prev: kids[di - 1]?.textContent ?? "",
      next: kids[di + 1]?.textContent ?? "",
    };
  });
  check(
    split?.prev.includes(markerOf(lastBefore)) === true &&
      split?.prev.includes(markerOf(firstAfter)) === false,
    "S1c-3 分隔条位于压缩点:前一段是最后一条被压缩的消息",
    JSON.stringify({ upto, prev: split?.prev.slice(0, 120) }),
  );
  check(
    split?.next.includes(markerOf(firstAfter)) === true,
    "S1c-3b 分隔条后是压缩点之后的首条消息",
    JSON.stringify({ firstAfter: markerOf(firstAfter), next: split?.next.slice(0, 120) }),
  );
  await sidepanel.locator(`button[aria-label="${zh.chat.newChat}"]`).click();
}

// ---- S2:压缩用模型 ----
console.log("\n===== S2. 压缩用模型:摘要走 cheap-test =====");
await seedSession("s-model", "压缩模型会话", 3, 1100);
await setCompactCfg({ compactProvider: "prov-1", compactModel: "cheap-test" });
{
  const before = llm.calls.length;
  await runAsk("s-model", "新问题(S2)");
  const summaryCall = llm.calls.slice(before).find((c) => c.isSummary);
  check(summaryCall?.model === "cheap-test",
    "S2-1 摘要请求 model=cheap-test", JSON.stringify(summaryCall));
  check(lastAgentBody?.model === "gpt-test",
    "S2-2 agent 请求仍是主模型", lastAgentBody?.model);
}

console.log("\n===== S2b. 压缩用模型失效:回落当前模型 =====");
await seedSession("s-model2", "压缩模型失效会话", 3, 1100);
await setCompactCfg({ compactModel: "ghost-model" });
{
  const before = llm.calls.length;
  await runAsk("s-model2", "新问题(S2b)");
  const summaryCall = llm.calls.slice(before).find((c) => c.isSummary);
  check(summaryCall?.model === "gpt-test",
    "S2b-1 引用失效回落主模型", JSON.stringify(summaryCall));
  const logs = await waitRunLog((e) => e.msg.includes("压缩用模型配置失效"),
    "回落告警日志");
  check(logs.some((e) => e.msg.includes("压缩用模型配置失效")),
    "S2b-2 回落时有告警日志");
  await setCompactCfg({ compactProvider: "", compactModel: "" });
}

// ---- S3:摘要调用 500 → 回退裁剪 ----
console.log("\n===== S3. 摘要失败:回退溢出裁剪,run 完成 =====");
await seedSession("s-500", "摘要失败会话", 3, 1100);
llm.summaryMode = "500";
{
  const done = await runAsk("s-500", "新问题(S3)");
  llm.summaryMode = "ok";
  check(done.type === "agent_done", "S3-1 摘要失败不打断 run", JSON.stringify(done));
  const logs = await waitRunLog((e) => e.msg.includes("上下文压缩失败"),
    "回退告警日志");
  check(logs.some((e) => e.msg.includes("上下文压缩失败")),
    "S3-2 有回退告警日志");
  check(JSON.stringify(lastAgentBody).includes("MARK-s-500-R2"),
    "S3-3 裁剪兜底:最近一轮原文仍在(挤出空间靠 trim)");
  check(!JSON.stringify(lastAgentBody).includes("<context-summary>"),
    "S3-4 摘要未注入(失败路径无半成品)");
}

// ---- S4:档位生效 ----
console.log("\n===== S4. 档位:early 触发 / late 不触发(同一份历史)=====");
await setModelCfg(20000); // usable = 20000-4096-4000 = 11904;early 7142 / late 10714
await seedSession("s-gear-e", "档位early会话", 3, 1100); // 基线 ≈ 8900,落在两档之间
await seedSession("s-gear-l", "档位late会话", 3, 1100);
{
  await setCompactCfg({ compact: "early" });
  const before = llm.calls.length;
  await runAsk("s-gear-e", "新问题(S4-early)");
  check(summaryCallsSince(0) > 0 && llm.calls.slice(before).some((c) => c.isSummary),
    "S4-1 early 档(60%)触发压缩");

  await setCompactCfg({ compact: "late" });
  const before2 = llm.calls.length;
  await runAsk("s-gear-l", "新问题(S4-late)");
  check(llm.calls.slice(before2).every((c) => !c.isSummary),
    "S4-2 late 档(90%)不触发压缩");
  const budgetLogs = await waitRunLog((e) => e.msg === "context budget",
    "context budget 日志");
  const budgetLog = budgetLogs.find((e) => e.msg === "context budget");
  check(!!budgetLog && (budgetLog.data ?? "").includes('"threshold":0.9'),
    "S4-3 context budget 日志带档位阈值", budgetLog?.data);
  await setCompactCfg({ compact: "standard" });
}

// ---- S5:未配 contextTokens 永不触发 ----
console.log("\n===== S5. 未配 contextTokens:不触发 =====");
await setModelCfg(0);
await seedSession("s-none", "无窗口会话", 3, 1100);
{
  const before = llm.calls.length;
  await runAsk("s-none", "新问题(S5)");
  check(llm.calls.slice(before).every((c) => !c.isSummary),
    "S5-1 没有窗口配置就没有摘要调用");
}

// ---- S6:run 中途撞窗 → 紧急压缩重试 ----
console.log("\n===== S6. 撞窗重试:400 → 紧急压缩 → 重试成功 =====");
await setModelCfg(20000); // 种子很小,run 开始不会触发压缩;首请求被 mock 打 400
await seedSession("s-ovf", "撞窗会话", 1, 30);
llm.overflowArmed = true;
llm.overflowDone = false;
{
  const before = llm.calls.length;
  const done = await runAsk("s-ovf", "新问题(S6)");
  llm.overflowArmed = false;
  check(done.type === "agent_done", "S6-1 紧急压缩后重试成功,run 完成", JSON.stringify(done));
  const logs = await waitRunLog((e) => e.msg.includes("紧急压缩后重试"),
    "撞窗重试日志");
  check(logs.some((e) => e.msg.includes("紧急压缩后重试")),
    "S6-2 撞窗被识别并触发紧急压缩");
  check(llm.calls.slice(before).some((c) => c.isSummary),
    "S6-3 紧急摘要调用发生");
  check(JSON.stringify(lastAgentBody).includes("<context-summary>"),
    "S6-4 重试请求带上了紧急摘要");
}

// ---- 汇总 ----
console.log("\n========================================");
if (check.failures.length > 0) {
  console.log("❌ VERDICT: FAIL —", check.failures.join("; "));
  await browser.close();
  process.exit(1);
}
console.log("✅ VERDICT: PASS");
await browser.close();
process.exit(0);
