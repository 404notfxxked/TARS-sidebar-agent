// Background service worker 入口
// 职责:管理 side panel ↔ agent loop 的长连接
// - chrome.runtime.onConnect:监听侧栏发起的命名端口(PORT_NAME)
// - activeRuns:记录每个正在运行的 agent 会话(带 AbortController,支持取消)
// - content script 的调用走 shared/contentTools(onMessage),不走这里

import { MSG, PORT_NAME, type SideToBg, type UserMessagePayload } from "../shared/messages";
import { bytesToBase64 } from "../shared/imageCodec";
import {
  LOG_HELLO,
  LOG_HELLO_ACK,
  createLogger,
  installGlobalErrorHook,
} from "../shared/logger";
import { runAgentLoop, type AgentPort } from "./agent/agent";
import { resolveConfirmation } from "./agent/confirmations";
import { zhCN } from "../shared/i18n/locales/zh-CN";
import { enUS } from "../shared/i18n/locales/en-US";
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
  deleteSkill,
  importSkill,
  listSkills,
  setSkillEnabled,
  updateSkill,
} from "./skills/skillStore";
import { renderSkillMarkdown } from "../shared/skills";
import type { SkillInfo } from "../shared/messages";
import { loadConfig } from "../shared/configStore";
import {
  clearAllSessions,
  deleteSession,
  getCompactionMark,
  listSessions,
  loadImage,
  loadHistory,
  migrateLegacySessionStorage,
  prepareRegenerate,
  pruneExpiredSessions,
  toChatRecords,
} from "./sessions/sessionHistory";
import { getSkillRow } from "./sessions/sessionDb";

/** SkillRow → 面板展示形状(不含正文;chars 做量级提示) */
async function skillInfos(): Promise<SkillInfo[]> {
  return (await listSkills()).map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    enabled: r.enabled,
    updatedAt: r.updatedAt,
    chars: r.body.length,
  }));
}
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
  /** 归属面板的 port:每个浏览器窗口各有一个侧栏实例,断开/取消只处理
   *  自己名下的 run,不殃及其他窗口正在进行的对话 */
  port: chrome.runtime.Port;
}

// 每个运行中的 agent 会话 → 取消句柄(以 sessionId 为 key)
// 注意:SW 休眠时此 Map 会被清空(内存态,本就不该跨唤醒存活);
// 需跨唤醒存活的数据(会话历史)走 chrome.storage.session,不在这里。
const activeRuns = new Map<string, RunState>();

// 面板可见性(每个窗口的侧栏实例各一份):任务完成通知据此判断
// 「这个 run 的主人是否正看着」。面板不可见 = 收到通知才有意义
const panels = new Map<chrome.runtime.Port, { hidden: boolean }>();

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
      error: err instanceof Error ? err.message : String(err),
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
  // 所以先 as 断言到协议类型,再用 switch 做真正的收窄
  port.onMessage.addListener(async (raw: unknown) => {
    const msg = raw as SideToBg;
    switch (msg.type) {
      case MSG.USER_MESSAGE: {
        await launchRun(port, msg.payload);
        break;
      }
      case MSG.REGENERATE: {
        // 已有 run 在跑的会话不接受重答(面板也有 idle 门控,双保险)
        if (activeRuns.has(msg.sessionId)) {
          log.warn("agent", "regenerate ignored, run in progress", {
            sessionId: msg.sessionId,
          });
          break;
        }
        const prep = await prepareRegenerate(msg.sessionId);
        if (!prep) {
          log.warn("agent", "regenerate: no user turn to replay", {
            sessionId: msg.sessionId,
          });
          break;
        }
        // tabId 不还原:重答按当时的活动 tab 取页面上下文,与手发一致
        await launchRun(port, prep);
        break;
      }
      case MSG.CANCEL_RUN: {
        const run = activeRuns.get(msg.sessionId);
        log.warn("agent", "cancel requested", {
          sessionId: msg.sessionId,
          found: run !== undefined && run.port === port,
        });
        // 只响应归属面板的取消:历史列表是跨窗口共享的,别的窗口
        // 正在运行的会话不该被这里误杀
        if (run && run.port === port) run.abort.abort();
        break;
      }
      case MSG.PANEL_VISIBILITY: {
        // 面板可见性:任务完成通知的「是否打扰」判据(按面板实例记账)
        const panel = panels.get(port);
        if (panel) panel.hidden = msg.hidden;
        break;
      }
      case MSG.CONFIRM_RESPONSE: {
        // 确认卡的答复;未知/过期 requestId 在确认门内静默忽略
        resolveConfirmation(msg.requestId, msg.approved);
        break;
      }
      case MSG.LOAD_HISTORY: {
        // 从历史列表切回某会话时,把该会话消息回给前端渲染;
        // 有压缩时带上压缩点,面板据此渲染分隔条(历史本身始终全量)。
        // resync = 断连重同步,原样回显给面板走「按库替换」分支。
        // sessionId 必须回带:面板按「响应会话 == 当前会话」判定新鲜度,
        // 缺了它,快速切会话时旧回包会把 A 的转写盖上 B 的 id(评审 §5.2)
        const history = await loadHistory(msg.sessionId);
        const compaction = await getCompactionMark(msg.sessionId);
        port.postMessage({
          type: MSG.HISTORY,
          sessionId: msg.sessionId,
          messages: toChatRecords(history),
          ...(compaction ? { compaction } : {}),
          ...(msg.resync ? { resync: true } : {}),
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
      case MSG.SKILL_LIST: {
        port.postMessage({ type: MSG.SKILLS, skills: await skillInfos() });
        break;
      }
      case MSG.SKILL_ADD: {
        // 解析失败(缺字段/超限)不静默:错误随 SKILLS 回面板就地展示,
        // 列表仍回后台实际状态 —— 面板不需要再发一次 LIST
        try {
          await importSkill(msg.raw);
          port.postMessage({ type: MSG.SKILLS, skills: await skillInfos() });
        } catch (err) {
          log.warn("skills", "技能导入失败", {
            error: err instanceof Error ? err.message : String(err),
          });
          port.postMessage({
            type: MSG.SKILLS,
            skills: await skillInfos(),
            error: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }
      case MSG.SKILL_GET: {
        // 编辑视图:行重组回 SKILL.md 原文(frontmatter 由 name/description 还原)
        const row = await getSkillRow(msg.id).catch(() => undefined);
        port.postMessage({
          type: MSG.SKILL_RAW,
          id: msg.id,
          ...(row
            ? {
                raw: renderSkillMarkdown(row.name, row.description, row.body),
              }
            : {}),
        });
        break;
      }
      case MSG.SKILL_UPDATE: {
        try {
          await updateSkill(msg.id, msg.raw);
          port.postMessage({ type: MSG.SKILLS, skills: await skillInfos() });
        } catch (err) {
          log.warn("skills", "技能更新失败", {
            error: err instanceof Error ? err.message : String(err),
          });
          port.postMessage({
            type: MSG.SKILLS,
            skills: await skillInfos(),
            error: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }
      case MSG.SKILL_TOGGLE: {
        try {
          await setSkillEnabled(msg.id, msg.enabled);
          port.postMessage({ type: MSG.SKILLS, skills: await skillInfos() });
        } catch (err) {
          port.postMessage({
            type: MSG.SKILLS,
            skills: await skillInfos(),
            error: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }
      case MSG.SKILL_DELETE: {
        await deleteSkill(msg.id);
        port.postMessage({ type: MSG.SKILLS, skills: await skillInfos() });
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
