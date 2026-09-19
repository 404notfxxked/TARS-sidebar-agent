// LLM 端点异常路径 e2e:401 鉴权失败 / 流中途错误帧 / 网络层断连 /
// finish_reason=length 截断。此前异常覆盖只有 500(摘要)/400(撞窗)/
// 429(搜索)散在各域,LLM 侧鉴权与网络层失败零覆盖(2026-09 评审 T9)。
// 用法: pnpm build && node tests/verify-llm-errors.mjs

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { answerSSE, idbGetAll, injectTestConfig, launchWithCdp, makeChecker, runAskViaPort, sse } from "./lib-cdp-mock.mjs";
import { zh } from "./lib-i18n.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(__dirname, "..", "dist");
const USER_DATA_DIR = `/tmp/verify-llm-errors-${Date.now()}`;

const { browser, extId, mock } = await launchWithCdp({ extDir: EXT_DIR, userDataDir: USER_DATA_DIR });
console.log("✅ 扩展:", extId);

const check = makeChecker();
// LLM mock 状态机:按场景切换应答形态
const llm = { mode: "401" };

mock.setRoutes([
  {
    match: (url) => url.includes("/chat/completions"),
    handle: async (ctx) => {
      const body = JSON.parse(ctx.params.request.postData ?? "{}");
      if (llm.mode === "401") {
        await ctx.fulfill({
          status: 401,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: { message: "invalid api key" } }),
        });
        return;
      }
      if (llm.mode === "stream-error") {
        // 内容 delta 正常推送一帧后,服务端推错误帧(OpenAI 形状,无 choices)
        await ctx.fulfill({
          headers: { "Content-Type": "text/event-stream" },
          body: sse(
            { choices: [{ delta: { content: "写到一半" } }] },
            { error: { message: "quota exceeded upstream", code: "insufficient_quota" } },
          ),
        });
        return;
      }
      if (llm.mode === "net-fail") {
        await ctx.failNetwork();
        return;
      }
      if (llm.mode === "reasoning") {
        // 思考模型两跳:首轮 reasoning_content + 工具调用(get_tabs,本地只读
        // 即可执行),工具结果回填后末轮再给 reasoning + content —— 中间工具轮
        // 的思考只有随过程卡投影才能在回放里活下来(回归钉子)
        const messages = body.messages ?? [];
        const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
        const sawTool = messages
          .slice(lastUserIdx + 1)
          .some((m) => m.role === "tool");
        if (!sawTool) {
          // 跨 run 回传契约(每次 run 首请求刷新):历史工具行必须带着
          // reasoning_content 回来(DeepSeek thinking 缺失即 400),
          // 历史回答行必须剥离(思考不回灌)
          llm.histToolReasoning = messages.some(
            (m) =>
              m.role === "assistant" &&
              m.tool_calls?.length &&
              typeof m.reasoning_content === "string" &&
              m.reasoning_content.length > 0,
          );
          llm.histAnswerReasoning = messages.some(
            (m) =>
              m.role === "assistant" && !m.tool_calls && m.reasoning_content !== undefined,
          );
          await ctx.fulfill({
            headers: { "Content-Type": "text/event-stream" },
            body: sse(
              { choices: [{ delta: { reasoning_content: "第一轮思考 TOOL_TURN" } }] },
              { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-think-1", function: { name: "get_tabs", arguments: "{}" } }] } }] },
              { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
            ),
          });
          return;
        }
        // 思考模型形状:reasoning_content delta 先行,content 随后
        await ctx.fulfill({
          headers: { "Content-Type": "text/event-stream" },
          body: sse(
            { choices: [{ delta: { reasoning_content: "深层思考 ABC" } }] },
            { choices: [{ delta: { content: "最终回答" } }] },
            { choices: [{ delta: {}, finish_reason: "stop" }] },
          ),
        });
        return;
      }
      // "length":截断收尾
      await answerSSE(ctx, "半截回答", { finish: "length" });
    },
  },
]);
console.log("✅ CDP Fetch 拦截已就绪");

const sidepanel = await browser.newPage();
await sidepanel.goto(`chrome-extension://${extId}/sidepanel.html`);
await new Promise((r) => setTimeout(r, 1000));
await injectTestConfig(sidepanel);
await sidepanel.reload();
await new Promise((r) => setTimeout(r, 1500));

let seq = 0;
const askRaw = (text) => runAskViaPort(sidepanel, `s-llm-${++seq}`, text);

try {
  // ---- A. 401:明确错误不重试,服务端文案透传给用户 ----
  console.log("\n── A. 401 鉴权失败 ──");
  llm.mode = "401";
  const a = await askRaw("触发鉴权失败");
  check(a.type === "agent_error", "run 以 agent_error 收束", JSON.stringify(a));
  check(/401/.test(a.error ?? ""), "错误信息带 HTTP 401", a.error);
  check(/invalid api key/i.test(a.error ?? ""), "错误体透传服务端文案", a.error);
  // 失败轮错误行:回放有错误语义,提问不再悬空(审计 2026-09-18 A)
  {
    const errRow = (await idbGetAll(sidepanel, "messages"))
      .map((r) => r.msg)
      .find((m) => m.role === "assistant" && m.error);
    check(
      !!errRow && /401/.test(String(errRow.content ?? "")),
      "失败轮错误行已落库(error 标 + 401 文本)",
      JSON.stringify(errRow)?.slice(0, 140),
    );
    const records = await sidepanel.evaluate(
      (sessionId) =>
        new Promise((resolve, reject) => {
          const port = chrome.runtime.connect({ name: "agent-port" });
          const timer = setTimeout(() => reject(new Error("history 超时")), 10000);
          port.onMessage.addListener((msg) => {
            if (msg.type === "history") {
              clearTimeout(timer);
              port.disconnect();
              resolve(msg.messages);
            }
          });
          port.postMessage({ type: "load_history", sessionId });
        }),
      "s-llm-1",
    );
    check(
      records.some((r) => r.role === "assistant" && r.error === true),
      "历史投影错误行带 error 标(回放渲染错误气泡)",
    );
  }

  // ---- B. 流中途错误帧:抛出服务端消息而非静默吞成空回答 ----
  console.log("\n── B. 流中途错误帧 ──");
  llm.mode = "stream-error";
  const b = await askRaw("触发流中错误");
  check(b.type === "agent_error", "run 以 agent_error 收束", JSON.stringify(b));
  check(
    /LLM stream error: quota exceeded upstream/.test(b.error ?? ""),
    "错误信息带服务端错误帧原文",
    b.error,
  );

  // ---- C. 网络层断连:fetch reject 走重试,耗尽后报错 ----
  console.log("\n── C. 网络层失败(Fetch.failRequest)──");
  llm.mode = "net-fail";
  const c = await askRaw("触发网络断连");
  check(c.type === "agent_error", "重试耗尽后 agent_error", JSON.stringify(c));
  check(/fetch failed|Failed to fetch/i.test(c.error ?? ""), "错误为网络层语义", c.error);

  // ---- D. finish_reason=length:截断内容正常上屏,不伪装成功也不报错 ----
  console.log("\n── D. length 截断 ──");
  llm.mode = "length";
  const d = await askRaw("触发截断");
  check(d.type === "agent_done", "截断不算错误,run 正常收束", JSON.stringify(d));
  // 收束原因必须与正常完成区分:面板据此补系统提示条(2026-09 审计 P2-1),
  // 报 complete 会让「答案半截」看起来像正常收尾
  check(
    d.reason === "truncated",
    "done 原因为 truncated(不谎报 complete)",
    JSON.stringify(d),
  );
  // runAsk 走裸 port,panel 未必渲染该轮文本;断言持久层 assistant 行
  const rows = await idbGetAll(sidepanel, "messages");
  const hit = rows.some(
    (r) =>
      r.msg?.role === "assistant" &&
      String(r.msg.content ?? "").includes("半截回答"),
  );
  check(hit, "截断前的内容已落库(assistant 行)");

  // ---- E. 思考落盘、跨 run 回传与过程卡回放(含中间工具轮) ----
  console.log("\n── E. 思考落盘、跨 run 回传与过程卡回放 ──");
  llm.mode = "reasoning";
  const e = await askRaw("触发思考");
  check(e.type === "agent_done", "run 正常收束", JSON.stringify(e));
  {
    // 两跳应答:工具轮(reasoning + get_tabs)+ 最终轮(reasoning + 回答)
    const aRows = (await idbGetAll(sidepanel, "messages"))
      .filter((r) => r.sessionId === "s-llm-5")
      .map((r) => r.msg)
      .filter((m) => m.role === "assistant" && m.reasoning_content);
    const toolTurn = aRows.find((m) => m.toolCalls?.length);
    check(
      aRows.length === 2,
      "两轮思考均全量落库",
      JSON.stringify(aRows.map((m) => [m.content, m.reasoning_content]))?.slice(0, 160),
    );
    check(
      !!toolTurn && !toolTurn.content &&
        String(toolTurn.reasoning_content).includes("第一轮思考"),
      "工具轮思考行落库(content 空 + toolCalls + reasoning)",
      JSON.stringify(toolTurn)?.slice(0, 140),
    );

    // 跨 run:同会话继续追问,续跑请求里的历史工具行必须带回 reasoning_content
    // (DeepSeek thinking 缺失即 400),历史回答行必须剥离
    const e2 = await runAskViaPort(sidepanel, "s-llm-5", "追问继续");
    check(e2.type === "agent_done", "续跑同会话正常收束", JSON.stringify(e2));
    check(
      llm.histToolReasoning === true,
      "跨 run 请求:历史工具行随 reasoning_content 回传",
    );
    check(
      llm.histAnswerReasoning === false,
      "跨 run 请求:历史回答行不携带 reasoning_content",
    );

    // 回放 UI:重开面板(本地态清空)→ 历史切回,两个 run 各出一张过程卡,
    // 卡内思考/工具行可回看,收尾气泡照常
    await sidepanel.reload();
    await new Promise((r) => setTimeout(r, 1500));
    await sidepanel
      .locator(`button[aria-label="${zh.chat.openSessions}"]`)
      .click();
    await sidepanel
      .locator(`h2:has-text("${zh.sessions.title}")`)
      .waitFor({ timeout: 5000 });
    await sidepanel
      .locator("li")
      .filter({ hasText: "触发思考" })
      .first()
      .click();
    // 每个含工具的 run 一张卡,chip 只报步数(思考+工具+思考 = 3 步,无时长)
    const chips = sidepanel.getByText(zh.chat.trace.replaySteps.replace("{n}", "3"));
    await chips.first().waitFor({ timeout: 5000 });
    const chipCount = await chips.count();
    check(chipCount === 2, "两个 run 各出一张过程卡(步数 chip,无时长)", `实际 ${chipCount}`);
    await chips.first().click();
    check(
      (await sidepanel.getByText(zh.chat.tool.getTabs).count()) >= 1,
      "过程卡内工具行可回看",
    );
    const thoughtRows = sidepanel.getByText(zh.chat.trace.reasoning);
    const thoughtCount = await thoughtRows.count();
    check(thoughtCount === 4, "两张卡各含两轮思考行", `实际 ${thoughtCount}`);
    await thoughtRows.first().click();
    check(
      await sidepanel.getByText("第一轮思考 TOOL_TURN").first().isVisible(),
      "工具轮思考可展开回看",
    );
    await thoughtRows.nth(1).click();
    check(
      await sidepanel.getByText("深层思考 ABC").first().isVisible(),
      "最终轮思考可展开回看",
    );
    check(
      await sidepanel.getByText("最终回答").first().isVisible(),
      "过程卡下方回答气泡照常",
    );
  }
} catch (err) {
  check(false, "套件执行异常", err.stack ?? String(err));
} finally {
  await browser.close();
}

console.log("\n========================================");
if (check.failures.length > 0) {
  console.log(`❌ VERDICT: FAIL(${check.failures.length} 条)`);
  for (const f of check.failures) console.log("  -", f);
  process.exit(1);
}
console.log("✅ VERDICT: PASS");
process.exit(0);
