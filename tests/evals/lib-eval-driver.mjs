// evals 的 port 驱动与轨迹提取:原始结构只在此处摸,case 只拿投影。
// - askWithPolicy:照 lib-cdp-mock runAskViaPort 的模式自造,监听
//   agent_confirm_request 按策略答复(auto_deny / deny_first_approve_rest /
//   approve_all),agent_done / agent_error 收口;单次 run 超时(缺省 300s)
//   不抛错,resolve {timeout: true} 让 runner 抓 readRunLogs 附进失败详情
//   (消息形状以 src/shared/messages.ts 的 AgentEvent 为准)。
// - extractTrajectory:loadHistoryViaPort 的 toChatRecords 投影(src/background/
//   sessions/sessionHistory.ts)→ 工具调用序列(name/args/result/error,挂在
//   收尾记录的 processItems 上)与最终回答;readRunLogs 的「当前 run」窗口
//   日志一并返回,确认事件类判分的日志锚点用法照 verify-confirm。
// - fixture 页:Playwright 在扩展同 context 开标签页,回填路由由 runner 统一
//   组装后 setRoutes(match 前缀,fulfill HTML,照 verify-web-search 的引擎页
//   模式);要求 fixture 页是除面板外唯一普通标签页 —— page_* 工具的 tabId
//   回退链(port 驱动不带 tabId)落「实时激活 tab」。

import { loadHistoryViaPort, readLogs } from "../lib-cdp-mock.mjs";

/**
 * memories store 行:区分「未建」与「已建行」,读取异常向上抛
 * 不吞——`.catch(() => [])` 会把 IDB 读路径回归折叠成「0 行=通过」。
 * - 库未建 / store 未建 → { exists: false }(语义 = 0 行,判分按 0 行通过)
 * - 已建 → { exists: true, rows: [全部行](FAIL 时 detail 可带行原文) }
 * - 其他异常(打开失败等)→ reject,由调用方判 FAIL 并带错误原文
 */
export function memoriesRowCount(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const rq = indexedDB.open("tars");
        rq.onsuccess = () => {
          const db = rq.result;
          if (!db.objectStoreNames.contains("memories")) {
            db.close();
            resolve({ exists: false });
            return;
          }
          const tx = db.transaction("memories", "readonly");
          const q = tx.objectStore("memories").getAll();
          q.onsuccess = () => {
            db.close();
            resolve({ exists: true, rows: q.result });
          };
          q.onerror = () => {
            db.close();
            reject(q.error ?? new Error("memories getAll failed"));
          };
        };
        rq.onerror = () => reject(rq.error ?? new Error("indexedDB open failed"));
      }),
  );
}

export const CONFIRM_POLICIES = [
  "auto_deny",
  "deny_first_approve_rest",
  "approve_all",
];

/**
 * 经 port 发一条指令并等 run 收口,确认卡按策略自动答复。
 * 返回 {timeout, done, confirms, maxTurn}:
 * - done:收口消息(agent_done 带 reason;agent_error 带 error);超时为 null
 * - confirms:按到达顺序记录的确认事件 {name, requestId, approved}
 * - maxTurn:agent_thinking 的最大 turn(0 基),轮次判分用;无轮为 -1
 */
export function askWithPolicy(
  sidepanel,
  sessionId,
  text,
  policy,
  { timeoutMs = 300_000 } = {},
) {
  if (!CONFIRM_POLICIES.includes(policy)) {
    throw new Error(`未知确认策略: ${policy}(合法值:${CONFIRM_POLICIES.join("/")})`);
  }
  return sidepanel.evaluate(
    ({ sessionId, text, policy, timeoutMs }) =>
      new Promise((resolve) => {
        const port = chrome.runtime.connect({ name: "agent-port" });
        const confirms = [];
        let maxTurn = -1;
        // deny_first_approve_rest:第一张拒,其后批;其余策略是常量答复
        let denyNext = policy === "deny_first_approve_rest";
        const timer = setTimeout(() => {
          port.disconnect();
          resolve({ timeout: true, done: null, confirms, maxTurn });
        }, timeoutMs);
        port.onMessage.addListener((msg) => {
          if (msg.type === "agent_thinking") {
            if (typeof msg.turn === "number") maxTurn = Math.max(maxTurn, msg.turn);
            return;
          }
          if (msg.type === "agent_confirm_request") {
            const approved =
              policy === "auto_deny"
                ? false
                : policy === "approve_all"
                  ? true
                  : !denyNext;
            denyNext = false;
            confirms.push({ name: msg.name, requestId: msg.requestId, approved });
            port.postMessage({
              type: "confirm_response",
              requestId: msg.requestId,
              approved,
            });
            return;
          }
          if (msg.type === "agent_done" || msg.type === "agent_error") {
            clearTimeout(timer);
            port.disconnect();
            resolve({ timeout: false, done: msg, confirms, maxTurn });
          }
        });
        port.postMessage({ type: "user_message", payload: { text, sessionId } });
      }),
    { sessionId, text, policy, timeoutMs },
  );
}

/**
 * 轨迹提取:历史投影(工具调用序列 + 最终回答)+ 当前 run 的窗口日志。
 * toChatRecords 把工具调用以 processItems(kind:"tool")挂在收尾记录上,
 * 单 run 场景下全部工具项都在同一批记录里且顺序 = 执行顺序。
 */
export async function extractTrajectory(sidepanel, sessionId) {
  const records = await loadHistoryViaPort(sidepanel, sessionId);
  const toolCalls = [];
  let finalAnswer = null;
  for (const rec of records) {
    for (const item of rec.processItems ?? []) {
      if (item.kind === "tool") {
        toolCalls.push({
          name: item.name,
          args: item.args,
          result: typeof item.result === "string" ? item.result : "",
          error: item.error === true,
        });
      }
    }
    if (
      rec.role === "assistant" &&
      !rec.error &&
      !rec.processOnly &&
      typeof rec.content === "string" &&
      rec.content.trim()
    ) {
      finalAnswer = rec.content;
    }
  }
  // 日志用全量会话窗口而不是「最后一次 run started」窗口:两段式 case
  // (steps)的 step 1 日志落在最后一个 run 窗口之外,窗口化会丢掉
  // 「fill_input 失败+declined」这类 step 1 证据。evals 的 profile 每次
  // 全新,会话日志 ≡ 本次运行,全量即正确口径
  const runLogs = await readLogs(sidepanel, 0);
  return { records, toolCalls, finalAnswer, runLogs };
}

/**
 * 取「最后一条真实 user 消息之后」的工具调用(两段式 case 的步内判分用:
 * step 2 的写调用 = 最后一条 user 记录之后的全部 tool 项)。synthetic
 * user(截图注记等)不是轮次边界,跳过。
 */
export function toolCallsAfterLastUser(traj) {
  const calls = [];
  for (const rec of traj.records) {
    if (rec.role === "user" && !rec.synthetic) {
      calls.length = 0;
      continue;
    }
    for (const item of rec.processItems ?? []) {
      if (item.kind === "tool") {
        calls.push({
          name: item.name,
          args: item.args,
          result: typeof item.result === "string" ? item.result : "",
          error: item.error === true,
        });
      }
    }
  }
  return calls;
}

/** fixture 页回填路由:match 前缀命中即 fulfill HTML(永不触真网) */
export function fixtureRoute(urlPrefix, html) {
  return {
    match: (url) => url.startsWith(urlPrefix),
    handle: async (ctx) => {
      await ctx.fulfill({
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
        body: html,
      });
    },
  };
}

/**
 * 开 fixture 标签页并等就绪(load + body 非空,事件驱动)。调用方保证此刻
 * 面板页已在,本页是除面板外唯一普通标签页,且是最后打开的活动标签 ——
 * page_* 工具的目标 tab 靠它。
 */
export async function openFixturePage(browser, url) {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(
    () => !!document.body && document.body.innerText.length > 0,
  );
  return page;
}
