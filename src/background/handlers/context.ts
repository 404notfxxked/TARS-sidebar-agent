// port 消息分发上下文(S4 从 index.ts 拆出):RunState / PanelState 两个
// 类型随拆分迁入并导出;PortCtx 把 index.ts 独有的单例借给各域 handler
// —— 单例的所有权与生命周期仍归 index.ts,此处只声明形状,不出现第二个所有者。
import type { UserMessagePayload } from "../../shared/messages";

/** 单个 agent 运行的状态:持有一个 AbortController,取消时中断正在进行的网络请求 */
export interface RunState {
  abort: AbortController;
  /** 提交时激活的 tab(可观测性,暂未消费) */
  tabId?: number;
  /** 归属面板的 port:每个浏览器窗口各有一个侧栏实例,断开/取消只处理
   *  自己名下的 run,不殃及其他窗口正在进行的对话 */
  port: chrome.runtime.Port;
}

/** 面板实例的可见性记账(任务完成通知的打扰判据) */
export interface PanelState {
  hidden: boolean;
}

/** port 消息分发上下文:单例仍由 index.ts 唯一持有,只是借给 handler 用 */
export interface PortCtx {
  port: chrome.runtime.Port;
  activeRuns: Map<string, RunState>;
  panels: Map<chrome.runtime.Port, PanelState>;
  preparingSessions: Set<string>;
  sessionBusy: (sessionId: string) => boolean;
  launchRun: (
    port: chrome.runtime.Port,
    payload: UserMessagePayload,
  ) => Promise<void>;
}
