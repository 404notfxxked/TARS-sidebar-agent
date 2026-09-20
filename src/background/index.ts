// Background service worker 入口
// 职责:管理 side panel ↔ agent loop 的长连接
// - chrome.runtime.onConnect:监听侧栏发起的命名端口(PORT_NAME)
// - activeRuns:记录每个正在运行的 agent 会话(带 AbortController,支持取消)
// - port.onMessage 按域分发到 handlers/(run/session/memory/skill/mcp):
//   单例与 port 的所有权都留在这里,handler 只经 ctx 借用
// - content script 的调用走 shared/contentTools(onMessage),不走这里

import { MSG, PORT_NAME, type SideToBg, type UserMessagePayload } from "../shared/messages";
import { errText } from "../shared/errors";
import {
  LOG_HELLO,
  LOG_HELLO_ACK,
  createLogger,
  installGlobalErrorHook,
} from "../shared/logger";
import { runAgentLoop, type AgentPort } from "./agent/agent";
import { zhCN } from "../shared/i18n/locales/zh-CN";
import { enUS } from "../shared/i18n/locales/en-US";
import { loadConfig } from "../shared/configStore";
import {
  migrateLegacySessionStorage,
  pruneExpiredSessions,
} from "./sessions/sessionHistory";
import { maybeProbeEngines } from "./web/engineHealth";
import type { PanelState, PortCtx, RunState } from "./handlers/context";
import { handleRunMessage } from "./handlers/runHandlers";
import { handleSessionMessage } from "./handlers/sessionHandlers";
import { handleMemoryMessage } from "./handlers/memoryHandlers";
import { handleSkillMessage } from "./handlers/skillHandlers";
import { handleMcpMessage } from "./handlers/mcpHandlers";

const log = createLogger({ ctx: "bg" });
installGlobalErrorHook(log);

// 点击工具栏图标 → 打开侧边栏
chrome.action.onClicked.addListener((tab: chrome.tabs.Tab) => {
  if (tab.id !== undefined) {
    chrome.sidePanel.open({ tabId: tab.id });
  }
});

// content script 报到:回它自己的 tabId,其日志副本据此落到 log:tab:<id>
chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  const msg = raw as { type?: string };
  if (msg?.type !== LOG_HELLO) return false;
  sendResponse({ type: LOG_HELLO_ACK, tabId: sender.tab?.id });
  return false;
});

/** 清理已关闭 tab 的内容脚本日志 key(日志本体有环形上限,key 本身不限) */
async function pruneDeadTabLogKeys(): Promise<void> {
  try {
    const bag = await chrome.storage.local.get(null);
    const tabKeys = Object.keys(bag).filter((k) => /^log:tab:\d+$/.test(k));
    if (tabKeys.length === 0) return;
    const alive = new Set(
      (await chrome.tabs.query({})).map((t) => t.id),
    );
    const stale = tabKeys.filter((k) => !alive.has(Number(k.split(":")[2])));
    if (stale.length > 0) await chrome.storage.local.remove(stale);
  } catch {
    /* 日志清理失败无关紧要 */
  }
}
void pruneDeadTabLogKeys();

// 引擎健康表:缺失/超龄(>6h)时探测一次网络环境可达性(SW fetch 各引擎
// 首页,4s 超时),供搜索引擎动态排序;fire-and-forget,不阻塞启动
void maybeProbeEngines();

// 会话历史:旧版 storage.session 里的数据搬进 IndexedDB,再按保留期清一次
// (都有内部捕获,失败只记日志,不阻塞 SW 启动)
void migrateLegacySessionStorage().then(() => pruneExpiredSessions());

// 每个运行中的 agent 会话 → 取消句柄(以 sessionId 为 key)
// 注意:SW 休眠时此 Map 会被清空(内存态,本就不该跨唤醒存活);
// 需跨唤醒存活的持久数据走 IndexedDB(见 sessions/sessionHistory.ts),不在这里。
const activeRuns = new Map<string, RunState>();

// REGENERATE 的 prepareRegenerate(读库 + 截库)是跨 await 的窗口:防重若等到
// launchRun 才登记,窗口内到达的同会话请求会通过检查并与截库并发跑同一条会话
// (写库 seq 互踩)。这里为那个窗口补一段占位登记,与 activeRuns 一起构成
// 「会话忙」判据 —— SW 休眠清空同 activeRuns,本就不该跨唤醒存活
const preparingSessions = new Set<string>();

/** 会话是否已有在途任务(含 REGENERATE 的截库窗口) */
function sessionBusy(sessionId: string): boolean {
  return activeRuns.has(sessionId) || preparingSessions.has(sessionId);
}

// 面板可见性(每个窗口的侧栏实例各一份):任务完成通知据此判断
// 「这个 run 的主人是否正看着」。面板不可见 = 收到通知才有意义
const panels = new Map<chrome.runtime.Port, PanelState>();

/** 通知正文里的任务名:用户首条消息截断 */
function taskLabel(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 48 ? `${line.slice(0, 48)}…` : line;
}

/**
 * run 结束通知:开关开着 + 面板不可见(或浏览器窗口失焦)才发;
 * 用户取消的 run 不打扰。文案按面板语言现取,点按通知拉回浏览器窗口。
 */
async function maybeNotifyRunEnd(opts: {
  aborted: boolean;
  error: string;
  text: string;
  /** 归属面板自报的可见性(port 已断开时按隐藏处理) */
  hidden: boolean;
}): Promise<void> {
  try {
    if (opts.aborted) return;
    const config = await loadConfig();
    if (!config.notifyDone) return;
    if (!opts.hidden) {
      // 面板自报可见,再核对窗口焦点:面板文档在窗口失焦时仍算 visible
      const win = await chrome.windows.getLastFocused().catch(() => null);
      if (win?.focused) return;
    }
    const dict = config.locale === "en-US" ? enUS : zhCN;
    const title = opts.error ? dict.notify.failTitle : dict.notify.doneTitle;
    const label = taskLabel(opts.text) || "…";
    const message = opts.error
      ? `${dict.notify.failBody}${label} ${opts.error.slice(0, 120)}`
      : dict.notify.doneBody.replace("{title}", label);
    await chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon-128.png",
      title,
      message,
    });
  } catch (err) {
    log.warn("notify", "run-end notification failed", {
      error: errText(err),
    });
  }
}

// 点通知 → 把浏览器窗口拉回前台(具体落点由 Chrome 决定)
chrome.notifications.onClicked.addListener(() => {
  chrome.windows
    .getAll({ windowTypes: ["normal"] })
    .then((wins) => {
      const win = wins.find((w) => w.id !== undefined);
      if (win?.id !== undefined) {
        chrome.windows.update(win.id, { focused: true }).catch(() => undefined);
      }
    })
    .catch(() => undefined);
});

/** 启动一轮 agent run:登记 RunState(可取消)、事件经 wrapPort 回面板、
 *  收口时补 AGENT_DONE 与结束通知。USER_MESSAGE 与 REGENERATE 共用;
 *  sessionId 缺省(面板首问)时在此生成。 */
async function launchRun(
  port: chrome.runtime.Port,
  payload: UserMessagePayload,
): Promise<void> {
  const sessionId = payload.sessionId ?? crypto.randomUUID();
  const run: RunState = {
    abort: new AbortController(),
    tabId: payload.tabId,
    port,
  };
  activeRuns.set(sessionId, run);
  // run 档案首条(e2e 以此为 run 边界):sessionId/tabId + 用户原文,
  // 复盘搜索质量时串「用户问了什么 → 模型提了什么词」用
  log.info("agent", "run started", {
    sessionId,
    tabId: payload.tabId,
    text: payload.text,
  });
  // 观察层:顺带记录 run 是否以错误收场,供结束通知区分文案
  let runError = "";
  const agentPort = wrapPort(port, sessionId);
  const observed: AgentPort = {
    postMessage: (event) => {
      if (event.type === MSG.AGENT_ERROR) runError = event.error;
      agentPort.postMessage(event);
    },
  };
  try {
    await runAgentLoop({ ...payload, sessionId }, observed, run.abort.signal);
  } finally {
    activeRuns.delete(sessionId);
    log.info("agent", "run ended", { sessionId });
    // 用原始 port 通知前端 run 结束(包括被取消的情况——wrapPort 已拒绝发送)
    try {
      port.postMessage({ type: MSG.AGENT_DONE });
    } catch {
      /* 端口已断开,前端反正也收不到 */
    }
    void maybeNotifyRunEnd({
      aborted: run.abort.signal.aborted,
      error: runError,
      text: payload.text,
      // port 已断开时 run 早已被 abort,这里取不到只是兜底
      hidden: panels.get(port)?.hidden ?? true,
    });
  }
}

// MV3 事件驱动:onConnect 触发时 SW 被唤醒并分发事件
chrome.runtime.onConnect.addListener((port: chrome.runtime.Port) => {
  if (port.name !== PORT_NAME) return;
  log.info("port", "connected");
  panels.set(port, { hidden: false });

  // 侧栏关闭 / 刷新 → 端口断开 → 只取消该面板名下的 run;
  // 其他窗口侧栏的运行中对话不受影响
  port.onDisconnect.addListener(() => {
    panels.delete(port);
    let killed = 0;
    for (const [sessionId, run] of activeRuns) {
      if (run.port !== port) continue;
      run.abort.abort();
      activeRuns.delete(sessionId);
      killed++;
    }
    if (killed > 0) {
      log.warn("port", "disconnected, cleaning up runs", { runs: killed });
    }
  });

  // 每条消息运行时都是任意形状(Chrome 类型里是 any),
  // 所以先 as 断言到协议类型,再由各域 handler 用 switch 收窄
  port.onMessage.addListener(async (raw: unknown) => {
    const msg = raw as SideToBg;
    // 面板可见性:port 生命周期的事,留在入口(任务完成通知的「是否打扰」判据,
    // 按面板实例记账),不属任何域
    if (msg.type === MSG.PANEL_VISIBILITY) {
      const panel = panels.get(port);
      if (panel) panel.hidden = msg.hidden;
      return;
    }
    const ctx: PortCtx = { port, activeRuns, panels, preparingSessions, sessionBusy, launchRun };
    if (await handleRunMessage(msg, ctx)) return;
    if (await handleSessionMessage(msg, ctx)) return;
    if (await handleMemoryMessage(msg, ctx)) return;
    if (await handleSkillMessage(msg, ctx)) return;
    if (await handleMcpMessage(msg, ctx)) return;
    // 未知类型:原 switch 无 default(静默忽略),保持现状 —— 不要加日志
  });
});

/** 包装 port:会话被取消后,拒绝再向 UI 发事件(真正中断请求靠 AbortController) */
function wrapPort(port: chrome.runtime.Port, sessionId: string): AgentPort {
  return {
    postMessage(event) {
      if (activeRuns.get(sessionId)?.abort.signal.aborted) {
        throw new Error("cancelled");
      }
      port.postMessage(event);
    },
  };
}
