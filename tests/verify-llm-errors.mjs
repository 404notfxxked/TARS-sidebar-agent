// LLM 端点异常路径 e2e:401 鉴权失败 / 流中途错误帧 / 网络层断连 /
// finish_reason=length 截断。此前异常覆盖只有 500(摘要)/400(撞窗)/
// 429(搜索)散在各域,LLM 侧鉴权与网络层失败零覆盖(2026-09 评审 T9)。
// 用法: pnpm build && node tests/verify-llm-errors.mjs

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { answerSSE, idbGetAll, injectTestConfig, launchWithCdp, makeChecker, runAskViaPort, sse } from "./lib-cdp-mock.mjs";

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
  // runAsk 走裸 port,panel 未必渲染该轮文本;断言持久层 assistant 行
  const rows = await idbGetAll(sidepanel, "messages");
  const hit = rows.some(
    (r) =>
      r.msg?.role === "assistant" &&
      String(r.msg.content ?? "").includes("半截回答"),
  );
  check(hit, "截断前的内容已落库(assistant 行)");
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
