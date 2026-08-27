// Background service worker 入口
// 职责:管理 side panel ↔ agent loop 的长连接
// - chrome.runtime.onConnect:监听侧栏发起的命名端口(PORT_NAME)
// - activeRuns:记录每个正在运行的 agent 会话(带 AbortController,支持取消)
// - content script 的调用走 shared/contentTools(onMessage),不走这里

import { MSG, PORT_NAME, type SideToBg } from "../shared/messages";
import {
  LOG_HELLO,
  LOG_HELLO_ACK,
  createLogger,
  installGlobalErrorHook,
} from "../shared/logger";
import { runAgentLoop, type AgentPort } from "./agent";
import { clearHistory, loadHistory, toChatRecords } from "./sessionHistory";

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

/** 单个 agent 运行的状态:持有一个 AbortController,取消时中断正在进行的网络请求 */
interface RunState {
  abort: AbortController;
  /** 提交时激活的 tab(可观测性,暂未消费) */
  tabId?: number;
}

// 每个运行中的 agent 会话 → 取消句柄(以 sessionId 为 key)
// 注意:SW 休眠时此 Map 会被清空(内存态,本就不该跨唤醒存活);
// 需跨唤醒存活的数据(会话历史)走 chrome.storage.session,不在这里。
const activeRuns = new Map<string, RunState>();

// MV3 事件驱动:onConnect 触发时 SW 被唤醒并分发事件
chrome.runtime.onConnect.addListener((port: chrome.runtime.Port) => {
  if (port.name !== PORT_NAME) return;
  log.info("port", "connected");

  // 侧栏关闭 / 刷新 → 端口断开 → 取消并清理所有运行中的 agent
  port.onDisconnect.addListener(() => {
    log.warn("port", "disconnected, cleaning up runs", {
      runs: activeRuns.size,
    });
    for (const [sessionId, run] of activeRuns) {
      run.abort.abort();
      activeRuns.delete(sessionId);
    }
  });

  // 每条消息运行时都是任意形状(Chrome 类型里是 any),
  // 所以先 as 断言到协议类型,再用 switch 做真正的收窄
  port.onMessage.addListener(async (raw: unknown) => {
    const msg = raw as SideToBg;
    switch (msg.type) {
      case MSG.USER_MESSAGE: {
        const sessionId = msg.payload.sessionId ?? crypto.randomUUID();
        const run: RunState = {
          abort: new AbortController(),
          tabId: msg.payload.tabId,
        };
        activeRuns.set(sessionId, run);
        log.info("agent", "run started", { sessionId, tabId: msg.payload.tabId });
        try {
          await runAgentLoop(
            { ...msg.payload, sessionId },
            wrapPort(port, sessionId),
            run.abort.signal,
          );
        } finally {
          activeRuns.delete(sessionId);
          log.info("agent", "run ended", { sessionId });
          // 用原始 port 通知前端 run 结束(包括被取消的情况——wrapPort 已拒绝发送)
          try {
            port.postMessage({ type: MSG.AGENT_DONE });
          } catch {
            /* 端口已断开,前端反正也收不到 */
          }
        }
        break;
      }
      case MSG.CANCEL_RUN: {
        const run = activeRuns.get(msg.sessionId);
        log.warn("agent", "cancel requested", {
          sessionId: msg.sessionId,
          found: run !== undefined,
        });
        run?.abort.abort();
        break;
      }
      case MSG.LOAD_HISTORY: {
        // 面板重开 / 切会话时,把该会话历史回给前端渲染
        const history = await loadHistory(msg.sessionId);
        port.postMessage({
          type: MSG.HISTORY,
          messages: toChatRecords(history),
        });
        break;
      }
      case MSG.CLEAR_HISTORY: {
        // 「开始新对话」:清掉该会话后台持久化历史,
        // 否则面板重开 / 切回此 tab 时旧对话会被 loadHistory 捞回来
        log.debug("port", "clear history", { sessionId: msg.sessionId });
        await clearHistory(msg.sessionId);
        break;
      }
    }
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
