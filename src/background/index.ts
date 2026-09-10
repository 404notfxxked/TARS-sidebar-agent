// Background service worker 入口
// 职责:管理 side panel ↔ agent loop 的长连接
// - chrome.runtime.onConnect:监听侧栏发起的命名端口(PORT_NAME)
// - activeRuns:记录每个正在运行的 agent 会话(带 AbortController,支持取消)
// - content script 的调用走 shared/contentTools(onMessage),不走这里

import { MSG, PORT_NAME, type SideToBg } from "../shared/messages";
import { bytesToBase64 } from "../shared/imageCodec";
import {
  LOG_HELLO,
  LOG_HELLO_ACK,
  createLogger,
  installGlobalErrorHook,
} from "../shared/logger";
import { runAgentLoop, type AgentPort } from "./agent/agent";
import {
  listServerTools,
  testServer,
} from "./mcp/mcpManager";
import {
  addMemory,
  clearMemories,
  deleteMemoryById,
  loadMemories,
  setMemoryPinned,
  updateMemory,
} from "./memory/memoryStore";
import {
  clearAllSessions,
  deleteSession,
  getCompactionMark,
  listSessions,
  loadImage,
  loadHistory,
  migrateLegacySessionStorage,
  pruneExpiredSessions,
  toChatRecords,
} from "./sessions/sessionHistory";
import { maybeProbeEngines } from "./web/engineHealth";

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
        // run 档案首条(e2e 以此为 run 边界):sessionId/tabId + 用户原文,
        // 复盘搜索质量时串「用户问了什么 → 模型提了什么词」用
        log.info("agent", "run started", {
          sessionId,
          tabId: msg.payload.tabId,
          text: msg.payload.text,
        });
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
        // 从历史列表切回某会话时,把该会话消息回给前端渲染;
        // 有压缩时带上压缩点,面板据此渲染分隔条(历史本身始终全量)
        const history = await loadHistory(msg.sessionId);
        const compaction = await getCompactionMark(msg.sessionId);
        port.postMessage({
          type: MSG.HISTORY,
          messages: toChatRecords(history),
          ...(compaction ? { compaction } : {}),
        });
        break;
      }
      case MSG.LIST_SESSIONS: {
        const sessions = await listSessions();
        port.postMessage({ type: MSG.SESSIONS, sessions });
        break;
      }
      case MSG.DELETE_SESSION: {
        await deleteSession(msg.sessionId);
        break;
      }
      case MSG.CLEAR_ALL_HISTORY: {
        await clearAllSessions();
        break;
      }
      case MSG.GET_IMAGE: {
        // 历史气泡渲染图片:字节单独走这条通道(消息列表只带元数据)。
        // base64 传输 —— port 消息是 JSON 语义,TypedArray 过不去
        const img = await loadImage(msg.id).catch(() => undefined);
        try {
          port.postMessage({
            type: MSG.IMAGE_DATA,
            id: msg.id,
            ...(img
              ? {
                  mime: img.mime,
                  base64: bytesToBase64(img.bytes),
                  w: img.w,
                  h: img.h,
                }
              : {}),
          });
        } catch {
          /* 端口已断开,面板侧反正也收不到 */
        }
        break;
      }
      case MSG.MEM_LIST: {
        port.postMessage({
          type: MSG.MEMORIES,
          memories: await loadMemories(),
        });
        break;
      }
      case MSG.MEM_ADD: {
        await addMemory(msg.text, "user");
        port.postMessage({
          type: MSG.MEMORIES,
          memories: await loadMemories(),
        });
        break;
      }
      case MSG.MEM_UPDATE: {
        await updateMemory(msg.id, msg.text);
        port.postMessage({
          type: MSG.MEMORIES,
          memories: await loadMemories(),
        });
        break;
      }
      case MSG.MEM_PIN: {
        await setMemoryPinned(msg.id, msg.pinned);
        port.postMessage({
          type: MSG.MEMORIES,
          memories: await loadMemories(),
        });
        break;
      }
      case MSG.MEM_DELETE: {
        await deleteMemoryById(msg.id);
        port.postMessage({
          type: MSG.MEMORIES,
          memories: await loadMemories(),
        });
        break;
      }
      case MSG.MEM_CLEAR: {
        await clearMemories();
        port.postMessage({
          type: MSG.MEMORIES,
          memories: await loadMemories(),
        });
        break;
      }
      case MSG.MCP_TEST: {
        // 测试连接:连 tools/list 一起拉(同一条缓存,成功即预热下次 run)
        try {
          port.postMessage({ type: MSG.MCP_TEST_RESULT, ...(await testServer(msg.server)) });
        } catch (err) {
          port.postMessage({
            type: MSG.MCP_TEST_RESULT,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }
      case MSG.MCP_TOOLS: {
        try {
          port.postMessage({ type: MSG.MCP_TOOLS_RESULT, tools: await listServerTools(msg.server) });
        } catch (err) {
          port.postMessage({
            type: MSG.MCP_TOOLS_RESULT,
            tools: [],
            error: err instanceof Error ? err.message : String(err),
          });
        }
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
