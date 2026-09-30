// 验证 MCP 接入(远程 Streamable HTTP 客户端:工具注入 / 调用 / 错误处理 /
// 旧版兼容 / 设置页 UI)
// 用法: pnpm build && node tests/verify-mcp.mjs
//
// CDP Fetch 拦截三类端点:
//   - 现代 MCP 服务器(2026-07-28 无状态):tools/list / tools/call 直答
//   - 旧版 MCP 服务器:首个 tools/list 回 400 → initialize 握手发
//     mcp-session-id → 重试成功(覆盖兼容探测主路径)
//   - 宕机服务器:恒 500(验证失败隔离,不拖垮 run)
// 断言:
//   T1. 总开关关:LLM 请求无 mcp_ 工具、MCP 端点零请求
//   T2. 开关开:双服务器 schema 并入;模型调 mcp 工具 → tools/call 执行 →
//       结果回填;现代头(Mcp-Name/Mcp-Method/Protocol-Version)与静态
//       请求头(Authorization)正确;旧版握手 + 会话头正确
//   T3. isError 结果 → Error 文本回给模型,run 正常收束
//   T4. 一台服务器宕机:其余工具照常注入,告警日志出现,user 消息注入
//       <mcp-status>(点名宕机服务器,且在 <user-request> 包裹外);
//       健康轮(T2)反向断言不注入
//   T5. 设置页 UI:开关/添加/展开自动拉工具清单/测试连接

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { answerSSE, launchWithCdp, makeChecker, openPanel, runAskViaPort, seedProviders, toolCallSSE, waitForRunLog } from "./lib-cdp-mock.mjs";
import { zh } from "./lib-i18n.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(__dirname, "..", "dist");
const USER_DATA_DIR = `/tmp/verify-mcp-${Date.now()}`;

// 客户端身份声明的期望版本:读 manifest 真源(不是抄一个字面量 —— 抄一份
// 就等于把「发版时忘了 bump」这个 bug 复制进测试,断言随之恒真)
const MANIFEST_VERSION = JSON.parse(
  readFileSync(resolve(__dirname, "..", "public", "manifest.json"), "utf8"),
).version;

const MODERN_URL = "https://mcp.modern-test.example.com/mcp";
const LEGACY_URL = "https://mcp.legacy-test.example.com/mcp";
const DOWN_URL = "https://mcp.down-test.example.com/mcp";

const WIRE_GET_ISSUE = "mcp_GitHub_get_issue";
const WIRE_FAIL_TOOL = "mcp_GitHub_fail_tool";
const WIRE_LIST_DOCS = "mcp_Legacy_list_docs";

// ---- MCP 请求档案:每场景前清空,断言头与调用序列 ----
let mcpLog = [];
const resetMcpLog = () => (mcpLog = []);
const record = (ctx, body) => {
  const headers = {};
  // CDP 的 request.headers 是 {name: value} 映射,不是数组
  for (const [name, value] of Object.entries(ctx.params.request.headers ?? {})) {
    headers[name.toLowerCase()] = value;
  }
  mcpLog.push({ url: ctx.params.request.url, headers, body });
};
const json = (ctx, status, obj, extraHeaders = {}) =>
  ctx.fulfill({
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(obj),
  });

// ---- LLM mock 状态机 ----
const llm = { mode: "normal" }; // normal | call-mcp | call-mcp-error
let lastAgentBody = null;

const answer = answerSSE;
const toolCall = toolCallSSE;

const { browser, extId, mock } = await launchWithCdp({
  extDir: EXT_DIR,
  userDataDir: USER_DATA_DIR,
});
console.log("✅ 扩展:", extId);

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
      lastAgentBody = body;
      if (llm.mode === "call-mcp") {
        if (!usedTool) return toolCall(ctx, WIRE_GET_ISSUE, { issue_number: 42 });
        return answer(ctx, "终答:MCP_OK");
      }
      if (llm.mode === "call-mcp-error") {
        if (!usedTool) return toolCall(ctx, WIRE_FAIL_TOOL, {});
        return answer(ctx, "终答:MCP_ERR_HANDLED");
      }
      return answer(ctx, "终答:MCP_OK");
    },
  },
  {
    // 现代 MCP 服务器(2026-07-28 无状态)
    match: (url) => url.startsWith(MODERN_URL),
    handle: async (ctx) => {
      const body = JSON.parse(ctx.params.request.postData ?? "{}");
      record(ctx, body);
      if (body.method === "tools/list") {
        return json(ctx, 200, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [
              {
                name: "get_issue",
                description: "获取 GitHub issue 详情",
                inputSchema: {
                  type: "object",
                  properties: { issue_number: { type: "number" } },
                  required: ["issue_number"],
                },
              },
              {
                name: "fail_tool",
                description: "总是返回 isError 的测试工具",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          },
        });
      }
      if (body.method === "tools/call") {
        if (body.params?.name === "fail_tool") {
          return json(ctx, 200, {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              content: [{ type: "text", text: "repo not found" }],
              isError: true,
            },
          });
        }
        return json(ctx, 200, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            content: [{ type: "text", text: "issue #42: mock 内容" }],
          },
        });
      }
      return json(ctx, 200, { jsonrpc: "2.0", id: body.id, result: {} });
    },
  },
  {
    // 旧版 MCP 服务器(initialize 握手 + 会话头)
    match: (url) => url.startsWith(LEGACY_URL),
    handle: async (ctx) => {
      const body = JSON.parse(ctx.params.request.postData ?? "{}");
      record(ctx, body);
      if (body.method === "initialize") {
        return json(
          ctx,
          200,
          {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              serverInfo: { name: "legacy-mock", version: "1.0.0" },
            },
          },
          { "mcp-session-id": "sess-123" },
        );
      }
      if (body.method?.startsWith("notifications/")) {
        return ctx.fulfill({ status: 202, headers: {}, body: "" });
      }
      // 带会话头之前的业务请求:400(触发客户端兼容探测)
      if (!mcpLog.at(-1)?.headers["mcp-session-id"]) {
        return ctx.fulfill({
          status: 400,
          headers: { "Content-Type": "text/plain" },
          body: "no session",
        });
      }
      return json(ctx, 200, {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          tools: [
            {
              name: "list_docs",
              description: "列出服务器上的文档",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        },
      });
    },
  },
  {
    // 宕机服务器:恒 500
    match: (url) => url.startsWith(DOWN_URL),
    handle: async (ctx) =>
      ctx.fulfill({
        status: 500,
        headers: { "Content-Type": "text/plain" },
        body: "boom",
      }),
  },
]);
console.log("✅ mock 路由已注册(LLM + 现代/旧版/宕机 MCP 服务器)");

// ---- 面板 + 基础配置 ----
const sidepanel = await openPanel(browser, extId);

const check = makeChecker();

await seedProviders(sidepanel, [{ id: "gpt-test" }]);

/** 写 mcp 配置(整包) */
const setMcp = (mcp) =>
  sidepanel.evaluate((m) => chrome.storage.local.set({ mcp: m }), mcp);

const mcpOff = { enabled: false, servers: [] };
const mcpOn = {
  enabled: true,
  servers: [
    {
      id: "srv-modern",
      name: "GitHub",
      url: MODERN_URL,
      headers: { Authorization: "Bearer ghp-test" },
      enabled: true,
    },
    {
      id: "srv-legacy",
      name: "Legacy",
      url: LEGACY_URL,
      headers: {},
      enabled: true,
    },
  ],
};

/** 裸 port 驱动一次 run(不经 UI):发 USER_MESSAGE,等 agent_done/error。
 *  autoConfirm 自动应答写操作确认门 —— mcp_ 工具自 2026-09 起逐次过门
 *  (与页面写动作同款),「门后链路」套件靠它穿过,确认卡交互由 confirm 套件专测 */
const runAsk = (sessionId, text) =>
  runAskViaPort(sidepanel, sessionId, text, { autoConfirm: true });

/** 钉 mcp 确认门:与 runAsk 同链路,但记录 agent_confirm_request。
 *  确认请求只发给 run 自己的 port,无法从第二个 port 偷听,故 T2 用本变体 */
const runAskWithConfirmLog = (sessionId, text) =>
  sidepanel.evaluate(
    ({ sessionId, text }) =>
      new Promise((resolve, reject) => {
        const port = chrome.runtime.connect({ name: "agent-port" });
        const confirmed = [];
        const timer = setTimeout(() => reject(new Error("run 超时")), 60000);
        port.onMessage.addListener((msg) => {
          if (msg.type === "agent_confirm_request") {
            confirmed.push(msg.name);
            port.postMessage({
              type: "confirm_response",
              requestId: msg.requestId,
              approved: true,
            });
            return;
          }
          if (msg.type === "agent_done" || msg.type === "agent_error") {
            clearTimeout(timer);
            port.disconnect();
            resolve({ type: msg.type, confirmed });
          }
        });
        port.postMessage({ type: "user_message", payload: { text, sessionId } });
      }),
    { sessionId, text },
  );

// ---- T1. 总开关关 ----
console.log("\n===== T1. 总开关关:无 mcp_ 工具、零 MCP 请求 =====");
await setMcp(mcpOff);
{
  resetMcpLog();
  await runAsk("s-t1", "开关关闭时的提问");
  const names = (lastAgentBody.tools ?? []).map((t) => t.function?.name);
  check(
    !names.some((n) => n?.startsWith("mcp_")),
    "T1-1 请求不含 mcp_ 工具",
    JSON.stringify(names),
  );
  check(mcpLog.length === 0, "T1-2 MCP 端点零请求", `count=${mcpLog.length}`);
}

// ---- T2. 双服务器注入 + 工具调用 + 协议头 ----
console.log("\n===== T2. 注入/调用/协议头/旧版握手 =====");
await setMcp(mcpOn);
{
  resetMcpLog();
  llm.mode = "call-mcp";
  const done = await runAskWithConfirmLog("s-t2", "帮我看下 issue 42");
  // mcp_ 工具与页面写动作同款逐次过确认门(2026-09 审计 P1-4):门必须
  // 先于执行出现,自动批准后链路继续(T2-1 起的行为断言依赖这次批准)
  check(
    done.confirmed.includes(WIRE_GET_ISSUE),
    "T2-0 mcp 工具调用先经写操作确认门",
    JSON.stringify(done.confirmed),
  );
  const names = (lastAgentBody.tools ?? []).map((t) => t.function?.name);
  check(
    names.includes(WIRE_GET_ISSUE),
    "T2-1 现代服务器工具已并入 schema",
    JSON.stringify(names),
  );
  check(
    names.includes(WIRE_LIST_DOCS),
    "T2-2 旧版服务器工具已并入 schema(握手成功)",
    JSON.stringify(names),
  );

  // 工具执行结果回填(log/tool 完成事件的 data 里带结果原文)
  try {
    const logs = await waitForRunLog(
      sidepanel,
      (e) =>
        e.tag === "tool" &&
        e.msg === `${WIRE_GET_ISSUE} 完成` &&
        (e.data ?? "").includes("issue #42"),
      "mcp 工具结果日志",
      15000,
    );
    check(
      logs.some((e) => e.tag === "tool" && e.msg === `${WIRE_GET_ISSUE} 完成`),
      "T2-3 tools/call 结果回填给模型",
      `run 日志 ${logs.length} 条,未见 tool 完成事件`,
    );
  } catch (err) {
    console.log("DEBUG 日志转储:\n", err.message);
    check(false, "T2-3 tools/call 结果回填给模型", "日志未找到");
  }

  // 现代服务器协议头 + 静态头
  const modernCall = mcpLog.find(
    (m) => m.url.startsWith(MODERN_URL) && m.body.method === "tools/call",
  );
  check(!!modernCall, "T2-4 现代 tools/call 请求发生");
  check(
    modernCall?.headers["mcp-protocol-version"] === "2026-07-28" &&
      modernCall?.headers["mcp-method"] === "tools/call" &&
      modernCall?.headers["mcp-name"] === WIRE_GET_ISSUE,
    "T2-5 现代必备头齐全(Protocol-Version/Method/Name)",
    JSON.stringify(modernCall?.headers),
  );
  check(
    modernCall?.headers.authorization === "Bearer ghp-test",
    "T2-6 静态请求头透传",
  );
  check(
    modernCall?.body.params?.name === "get_issue" &&
      modernCall?.body.params?.arguments?.issue_number === 42,
    "T2-7 tools/call 用服务器侧原名与参数",
    JSON.stringify(modernCall?.body.params),
  );
  check(
    !!modernCall?.body.params?._meta?.["io.modelcontextprotocol/protocolVersion"],
    "T2-8 现代请求带 _meta 协议元数据",
  );

  // 旧版:握手序列 + 会话头
  const legacyInit = mcpLog.find(
    (m) => m.url.startsWith(LEGACY_URL) && m.body.method === "initialize",
  );
  check(!!legacyInit, "T2-9 旧版服务器触发 initialize 握手");
  // 身份声明版本取自 manifest:硬编码 1.1.0 曾静默漂移过一个版本才被发现
  check(
    legacyInit?.body.params?.clientInfo?.name === "TARS" && // i18n-ok 协议常量
      legacyInit?.body.params?.clientInfo?.version === MANIFEST_VERSION,
    "T2-12 旧版握手 clientInfo 声明 manifest 版本",
    JSON.stringify(legacyInit?.body.params?.clientInfo),
  );
  check(
    modernCall?.body.params?._meta?.["io.modelcontextprotocol/clientInfo"]
      ?.version === MANIFEST_VERSION,
    "T2-13 现代请求 _meta clientInfo 声明 manifest 版本",
    JSON.stringify(
      modernCall?.body.params?._meta?.["io.modelcontextprotocol/clientInfo"],
    ),
  );
  const legacyRetry = mcpLog.find(
    (m) =>
      m.url.startsWith(LEGACY_URL) &&
      m.body.method === "tools/list" &&
      !!m.headers["mcp-session-id"],
  );
  check(
    !!legacyRetry && legacyRetry.headers["mcp-session-id"] === "sess-123",
    "T2-10 重试请求携带会话头",
  );
  check(
    mcpLog.some(
      (m) =>
        m.url.startsWith(LEGACY_URL) &&
        m.body.method === "notifications/initialized",
    ),
    "T2-11 握手后发 initialized 通知",
  );
  // 无失败服务器时不得注入状态块(反向断言:块只在有失败时出现)
  check(
    !JSON.stringify(lastAgentBody.messages ?? []).includes("<mcp-status>"),
    "T2-12 全部健康时不注入 <mcp-status>",
  );
}

// ---- T3. isError 结果 → 错误文本回给模型 ----
console.log("\n===== T3. 工具执行错误回传 =====");
{
  resetMcpLog();
  llm.mode = "call-mcp-error";
  const done = await runAsk("s-t3", "调一个会失败的工具");
  check(
    done.type === "agent_done",
    "T3-1 run 正常收束(错误不中断 agent)",
    JSON.stringify(done),
  );
  try {
    await waitForRunLog(
      sidepanel,
      (e) =>
        e.tag === "tool" &&
        e.msg.includes("失败") && // i18n-ok:日志语义(后台文案与字典同文不同源)
        (e.data ?? "").includes("repo not found"),
      "isError 错误日志",
      15000,
    );
    check(true, "T3-2 isError 文本进入错误回执");
  } catch (err) {
    console.log("DEBUG 日志转储:\n", err.message);
    check(false, "T3-2 isError 文本进入错误回执", "日志未找到");
  }
  llm.mode = "normal";
}

// ---- T4. 宕机服务器失败隔离 ----
console.log("\n===== T4. 单台宕机:其余工具照常 =====");
{
  await setMcp({
    enabled: true,
    servers: [
      ...mcpOn.servers,
      { id: "srv-down", name: "Down", url: DOWN_URL, headers: {}, enabled: true },
    ],
  });
  resetMcpLog();
  llm.mode = "call-mcp";
  const done = await runAsk("s-t4", "宕机隔离测试");
  check(done.type === "agent_done", "T4-1 run 正常收束");
  const names = (lastAgentBody.tools ?? []).map((t) => t.function?.name);
  check(
    names.includes(WIRE_GET_ISSUE) && !names.includes("mcp_Down_"),
    "T4-2 健康服务器工具在、宕机服务器工具不在",
    JSON.stringify(names),
  );
  await waitForRunLog(
    sidepanel,
    (e) =>
      e.msg.includes("连接失败") && (e.data ?? "").includes("Down"), // i18n-ok:日志语义
    "宕机告警日志",
    15000,
  ).then(
    () => check(true, "T4-3 记录服务器连接失败告警"),
    (err) => {
      console.log("DEBUG 日志转储:\n", err.message);
      check(false, "T4-3 记录服务器连接失败告警", "日志未找到");
    },
  );
  // <mcp-status> 注入断言:在 user 消息里点名宕机服务器,且位于
  // <user-request> 包裹外(回放投影的自动丢弃区,与技能块同层)
  const userText4 = JSON.stringify(lastAgentBody.messages ?? []);
  const statusIdx = userText4.indexOf("<mcp-status>");
  const wrapIdx = userText4.indexOf("<user-request>");
  check(
    statusIdx !== -1 && userText4.includes("Down"),
    "T4-4 user 消息注入 <mcp-status> 并点名宕机服务器",
    `statusIdx=${statusIdx}`,
  );
  check(
    statusIdx !== -1 && wrapIdx !== -1 && statusIdx < wrapIdx,
    "T4-5 状态块在 <user-request> 包裹外",
    `status=${statusIdx} wrap=${wrapIdx}`,
  );
  await setMcp(mcpOn);
}

// ---- T5. 设置页 UI ----
console.log("\n===== T5. 设置页:开关/添加/工具清单/测试连接 =====");
{
  await setMcp(mcpOff);
  await sidepanel.locator(`button[aria-label="${zh.chat.openSettings}"]`).click();
  await sidepanel.locator(`h2:has-text("${zh.settings.title}")`).waitFor({ timeout: 5000 });
  await sidepanel.locator("#settings-mcp").waitFor({ timeout: 5000 });

  await sidepanel.locator("#settings-mcp").click();
  await sidepanel.locator(`button:has-text("${zh.settings.addServer}")`).waitFor({ timeout: 5000 });
  await sidepanel.locator(`button:has-text("${zh.settings.addServer}")`).click();
  // 新卡自动展开:填名称与 URL
  await sidepanel.locator('input[id^="mcp-name-"]').fill("GitHub");
  const urlInput = sidepanel.locator('input[id^="mcp-url-"]');
  await urlInput.fill(MODERN_URL);
  // 失焦落盘并触发工具清单拉取
  await urlInput.blur();
  const toolRow = sidepanel.locator('p:has-text("get_issue")');
  await toolRow.waitFor({ timeout: 15000 });
  const toolText = (await toolRow.first().textContent()) ?? "";
  check(
    toolText.includes("get_issue"),
    "T5-1 展开态自动拉取并展示工具清单",
    `渲染内容:${toolText}`,
  );

  await sidepanel.locator(`button:has-text("${zh.settings.testConnection}")`).click();
  const connState = await sidepanel
    .locator(`span:has-text("${zh.settings.testOk.split("{")[0]}")`)
    .first()
    .textContent();
  check(
    !!connState &&
      connState.includes(zh.settings.testOk.split("{")[0].trim()),
    "T5-2 测试连接显示成功与工具数",
    `状态文案:${connState}`,
  );

  // 落盘校验:storage 里 mcp 配置完整
  const saved = await sidepanel.evaluate(
    () => chrome.storage.local.get("mcp").then((b) => b.mcp),
  );
  check(
    saved.enabled === true &&
      saved.servers.length === 1 &&
      saved.servers[0].url === MODERN_URL &&
      saved.servers[0].enabled === true,
    "T5-3 配置整包落盘",
    JSON.stringify(saved),
  );

  // 收尾:关开关,恢复默认态
  await sidepanel.locator("#settings-mcp").click();
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
