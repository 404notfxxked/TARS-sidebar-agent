// 验证 ask_user 反问工具端到端
// 用法: pnpm build && node tests/run.mjs ask
//
// CDP Fetch 拦截 LLM 端点,mock 模型调 ask_user 后按工具结果收尾,断言:
//   场景 A1:单问单选 —— 点选项即作答,答案以结构化 JSON(问题文本为键 +
//   selected)回填给模型,run 正常收口;trace 行名走面板字典(向你提问)
//   场景 A2:两问含多选 —— 未答齐提交禁用,答齐后卡片级提交,两问答案齐回
//   场景 A3:「其他」自由输入(单选也可只给 text),text 通道回填给模型
//   场景 A4:作答前取消 —— run 立即收口,模型收到 status=unanswered(而非
//   卡死等待);未作答徽记在已答态卡片上可见
//   场景 A5:历史回放 —— 重载面板后由 tool 记录(args+result)重渲染已答
//   反问卡:问题/选项在场、选中高亮、无提交钮(实况=回放)

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  injectTestConfig,
  launchWithCdp,
  makeChecker,
  openPanel,
  readRunLogs,
  sse,
} from "./lib-cdp-mock.mjs";
import { zh } from "./lib-i18n.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(__dirname, "..", "dist");
const USER_DATA_DIR = `/tmp/verify-ask-${Date.now()}`;

const { browser, extId, mock } = await launchWithCdp({
  extDir: EXT_DIR,
  userDataDir: USER_DATA_DIR,
});
console.log("✅ 扩展:", extId);

const answer = (ctx, text) =>
  ctx.fulfill({
    headers: { "Content-Type": "text/event-stream" },
    body: sse({ choices: [{ delta: { role: "assistant", content: text } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] }),
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
                  index: 0,
                  id: `call_ask_${Math.random().toString(36).slice(2, 8)}`,
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

const Q_ONE = [
  {
    question: "要操作哪个标签页?",
    header: "选哪个",
    options: [
      { label: "结算页", description: "示例站的结算流程" },
      { label: "商品列表" },
    ],
  },
];
const Q_MULTI = [
  { question: "先处理哪件事?", options: [{ label: "改标题" }, { label: "补库存" }] },
  {
    question: "要导出哪些列?",
    options: [{ label: "价格" }, { label: "库存" }, { label: "评分" }],
    multiSelect: true,
  },
];
const Q_OTHER = [
  {
    question: "用哪个称呼?",
    options: [{ label: "同学" }, { label: "老师" }],
  },
];
const Q_CANCEL = [
  { question: "继续吗?", options: [{ label: "继续" }, { label: "放弃" }] },
];

/** 模型收到的 ask_user 工具结果(每轮覆盖;断言用) */
let lastToolContent = null;
let toolRoundSeen = false;
mock.setRoutes([
  {
    match: (url) => url.includes("/chat/completions"),
    handle: async (ctx) => {
      const body = JSON.parse(ctx.params.request.postData ?? "{}");
      const msgs = body.messages ?? [];
      const lastUserIdx = msgs.map((m) => m.role).lastIndexOf("user");
      const lastUser = String(msgs[lastUserIdx]?.content ?? "");
      const toolMsgs = msgs
        .slice(lastUserIdx + 1)
        .filter((m) => m.role === "tool");
      if (toolMsgs.length > 0) {
        toolRoundSeen = true;
        lastToolContent = toolMsgs.map((m) => String(m.content ?? "")).join("|");
      }
      if (/问我用哪个/.test(lastUser)) {
        if (toolMsgs.length === 0) return toolCall(ctx, "ask_user", { questions: Q_ONE });
        return answer(ctx, "好的,已按选择继续。终答:ASK_A1_OK");
      }
      if (/再多问一轮/.test(lastUser)) {
        if (toolMsgs.length === 0) return toolCall(ctx, "ask_user", { questions: Q_MULTI });
        return answer(ctx, "收到全部选择。终答:ASK_A2_OK");
      }
      if (/试试其他输入/.test(lastUser)) {
        if (toolMsgs.length === 0) return toolCall(ctx, "ask_user", { questions: Q_OTHER });
        return answer(ctx, "收到自定义称呼。终答:ASK_A3_OK");
      }
      if (/问完就取消/.test(lastUser)) {
        if (toolMsgs.length === 0) return toolCall(ctx, "ask_user", { questions: Q_CANCEL });
        return answer(ctx, "已按未答处理。终答:ASK_A4_OK");
      }
      return answer(ctx, "终答:ASK_OK");
    },
  },
]);
console.log("✅ LLM mock 就绪");

const sidepanel = await openPanel(browser, extId, { configure: injectTestConfig });
await sidepanel.setViewportSize({ width: 340, height: 760 });

const input = `textarea[aria-label="${zh.chat.askInput}"]`;
const sendBtn = `button[aria-label="${zh.chat.send}"]`;
const stopBtn = `button[aria-label="${zh.chat.stop}"]`;
const submitBtn = `button[aria-label="${zh.chat.askSubmit}"]`;
const otherBtn = `button[aria-label="${zh.chat.askOther}"]`;
const otherBox = `textarea[aria-label="${zh.chat.askOtherPlaceholder}"]`;
const waitIdle = () =>
  sidepanel.locator(sendBtn).waitFor({ state: "visible", timeout: 20000 });
/** 发消息但不等 run 结束(反问卡会挂起等作答) */
const sendOnly = async (text) => {
  await sidepanel.locator(input).waitFor({ timeout: 5000 });
  await sidepanel.locator(input).fill(text);
  await sidepanel.locator(sendBtn).click();
};

const check = makeChecker();
const freshTool = async () => {
  lastToolContent = null;
  toolRoundSeen = false;
};

try {
  // ---- A1 单问单选 ----
  console.log("\n── A1 单问单选:点选即答,答案回填模型 ──");
  await freshTool();
  await sendOnly("问我用哪个页面");
  await sidepanel.locator(otherBtn).first().waitFor({ timeout: 20000 });
  // trace 行名走面板字典(SW 侧不泄漏)
  check(
    (await sidepanel.getByText(zh.chat.tool.askUser).count()) > 0,
    "trace 行名 = 字典「向你提问」",
  );
  check(
    (await sidepanel.getByText("5 分钟未作答，将由模型自行判断").count()) > 0,
    "超时口径上卡",
  );
  await sidepanel.screenshot({ path: "/tmp/tars-ask-shots/e2e-a1.png" });
  await sidepanel.locator('button:has-text("结算页")').click();
  await sidepanel.locator(submitBtn).click();
  await waitIdle();
  check(
    toolRoundSeen && /"selected":\["结算页"\]/.test(lastToolContent ?? ""),
    "答案结构化回填(问题为键 + selected)",
    (lastToolContent ?? "").slice(0, 160),
  );
  check(
    (lastToolContent ?? "").includes("要操作哪个标签页?"),
    "答案回显问题文本(模型可对号)",
  );

  // ---- A2 两问含多选:逐题展示 ----
  console.log("\n── A2 逐题展示:进度 1/2,确认进下一题,末题提交 ──");
  await freshTool();
  await sendOnly("再多问一轮帮我确认");
  const prog = (i, n) =>
    zh.chat.askProgress.replace("{i}", String(i)).replace("{n}", String(n));
  await sidepanel.getByText(prog(1, 2)).waitFor({ timeout: 20000 });
  check(
    (await sidepanel.getByText("要导出哪些列?").count()) === 0,
    "逐题展示:第二问不在场",
  );
  const nextBtn = `button[aria-label="${zh.chat.askNext}"]`;
  check(await sidepanel.locator(nextBtn).isDisabled(), "当前题未答时下一题禁用");
  await sidepanel.locator('button:has-text("改标题")').click();
  await sidepanel.locator(nextBtn).click();
  await sidepanel.getByText("要导出哪些列?").waitFor({ timeout: 10000 });
  check(
    (await sidepanel.getByText("先处理哪件事?").count()) === 0,
    "确认后第一问退场,进度推进 2/2",
    `progress=${await sidepanel.getByText(prog(2, 2)).count()}`,
  );
  await sidepanel.locator('button:has-text("价格")').click();
  await sidepanel.locator('button:has-text("评分")').click();
  await sidepanel.locator(submitBtn).click();
  await waitIdle();
  check(
    /"selected":\["改标题"\]/.test(lastToolContent ?? "") &&
      /"selected":\["价格","评分"\]/.test(lastToolContent ?? ""),
    "两问答案齐回填(逐题作答一次回填,多选合并数组)",
    (lastToolContent ?? "").slice(0, 200),
  );

  // ---- A3 「其他」自由输入 ----
  console.log("\n── A3 其他输入:text 通道回填 ──");
  await freshTool();
  await sendOnly("试试其他输入的方式");
  await sidepanel.locator(otherBtn).first().waitFor({ timeout: 20000 });
  await sidepanel.locator(otherBtn).first().click();
  await sidepanel.locator(otherBox).fill("就叫我为小助手");
  await sidepanel.locator(submitBtn).click();
  await waitIdle();
  check(
    /"text":"就叫我为小助手"/.test(lastToolContent ?? "") &&
      /"selected":\[\]/.test(lastToolContent ?? ""),
    "自由文本随 text 字段回填(未选项为空数组)",
    (lastToolContent ?? "").slice(0, 160),
  );

  // ---- A4 作答前取消 ----
  // 取消语义(loop.ts 定案):用户取消不回填观察结果,run 快速静默退出 ——
  // 模型不再收到新轮调用,反问卡随收口失去交互控件(不挂死、不残留可点)
  console.log("\n── A4 作答前取消:run 立即收口,不留挂起 ──");
  await freshTool();
  await sendOnly("问完就取消这个任务");
  await sidepanel.locator(otherBtn).first().waitFor({ timeout: 20000 });
  await sidepanel.locator(stopBtn).click();
  await waitIdle();
  check(!toolRoundSeen, "取消 → 模型不再收到新轮调用(不回填观察结果)");
  const entries4 = await readRunLogs(sidepanel);
  // ask_user 的取消结算走 resolve(未答)而非 throw:日志是「完成」且结果带
  // unanswered —— 恰好端到端验证超时/取消共用的未答结算语义
  const cancelLog = entries4.find(
    (e) =>
      `${e.ctx}/${e.tag}` === "bg/tool" &&
      /ask_user 完成/.test(e.msg) &&
      /unanswered/.test(e.data ?? "{}"),
  );
  check(!!cancelLog, "取消 → 工具按未答结算并留日志(unanswered)");
  await sidepanel.locator(".trace-summary").click();
  const afterCancel = await sidepanel.evaluate((submitLabel) => {
    const card = [...document.querySelectorAll(".rounded-lg")].find((c) =>
      c.textContent?.includes("继续吗?"),
    );
    if (!card) return "no-card";
    return `submit=${!!card.querySelector(`button[aria-label="${submitLabel}"]`)}`;
  }, zh.chat.askSubmit);
  check(
    afterCancel === "submit=false",
    "收口后反问卡失去交互控件(不残留可点)",
    afterCancel,
  );

  // ---- A5 历史回放 ----
  console.log("\n── A5 历史回放:tool 记录重渲染已答卡 ──");
  await sidepanel.reload();
  await sidepanel.locator(input).waitFor({ timeout: 10000 });
  await sidepanel
    .locator(`button[aria-label="${zh.chat.openSessions}"]`)
    .click();
  const sessionRow = sidepanel.getByText("问我用哪个页面").first();
  await sessionRow.waitFor({ timeout: 10000 });
  await sessionRow.click();
  // 回放过程卡默认折叠:展开后断言已答卡(问题在场/选中高亮/无提交钮)
  await sidepanel.locator(".trace-summary").first().waitFor({ timeout: 10000 });
  await sidepanel.locator(".trace-summary").first().click();
  await sidepanel.getByText("要操作哪个标签页?").waitFor({ timeout: 10000 });
  const replay = await sidepanel.evaluate((submitLabel) => {
    const card = [...document.querySelectorAll(".rounded-lg")].find((c) =>
      c.textContent?.includes("要操作哪个标签页"),
    );
    if (!card) return "no-card";
    // 摘要 chip 已收敛为中性容器片(bg-surface-container-highest):回放态
    // 卡片折叠,该容器片只会出现在摘要 chip 上,以此钉「答案在场」;
    // 主题色高亮只存在于展开态的已选中选项行
    const chip = [...card.querySelectorAll("div")].filter((d) =>
      d.className.includes("bg-surface-container-highest"),
    ).length;
    const submit = card.querySelector(`button[aria-label="${submitLabel}"]`);
    return `chip=${chip} submit=${!!submit}`;
  }, zh.chat.askSubmit);
  check(replay !== "no-card", "回放渲染已答反问卡", replay);
  check(
    replay.includes("chip=1") && replay.includes("submit=false"),
    "回放:摘要 chip(中性底)在场且无交互控件(实况=回放)",
    replay,
  );

  console.log(`\n结果:异常断言 ${check.failures.length} 条`);
  if (check.failures.length > 0) {
    console.log("失败项:", check.failures.join(" | "));
    process.exitCode = 1;
  }
} finally {
  await browser.close().catch(() => {});
}
