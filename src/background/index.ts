// Background service worker 入口
// 职责:管理 side panel ↔ agent loop 的长连接
// - chrome.runtime.onConnect:监听侧栏发起的命名端口(PORT_NAME)
// - activeRuns:记录每个正在运行的 agent 会话(带 AbortController,支持取消)
// - content script 的调用走 shared/contentTools(onMessage),不走这里

import { MSG, PORT_NAME, type SideToBg } from "../shared/messages";
import { runAgentLoop, type AgentPort } from "./agent";

// 点击工具栏图标 → 打开侧边栏
chrome.action.onClicked.addListener((tab: chrome.tabs.Tab) => {
  if (tab.id !== undefined) {
    chrome.sidePanel.open({ tabId: tab.id });
  }
});

/** 单个 agent 运行的状态:持有一个 AbortController,取消时中断正在进行的网络请求 */
interface RunState {
  abort: AbortController;
}

// 每个运行中的 agent 会话 → 取消句柄(以 sessionId 为 key)
const activeRuns = new Map<string, RunState>();

chrome.runtime.onConnect.addListener((port: chrome.runtime.Port) => {
  if (port.name !== PORT_NAME) return;
  console.log("[sw] port connected");

  // 侧栏关闭 / 刷新 → 端口断开 → 取消并清理所有运行中的 agent
  port.onDisconnect.addListener(() => {
    console.log("[sw] port disconnected, cleaning up", activeRuns.size, "runs");
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
        const run: RunState = { abort: new AbortController() };
        activeRuns.set(sessionId, run);
        console.log("[agent] run started", sessionId);
        try {
          await runAgentLoop(
            { ...msg.payload, sessionId },
            wrapPort(port, sessionId),
            run.abort.signal,
          );
        } finally {
          activeRuns.delete(sessionId);
          console.log("[agent] run ended", sessionId);
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
        console.log(
          "[agent] cancel requested",
          msg.sessionId,
          run ? "found — aborting" : "NOT FOUND — no-op",
        );
        run?.abort.abort();
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
