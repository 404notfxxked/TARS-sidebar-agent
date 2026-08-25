// Side panel ↔ Service Worker 共享的消息协议
// 任何一端修改时务必保持双向一致

export const PORT_NAME = 'agent-port' as const

export const MSG = {
  // Side panel → Background
  USER_MESSAGE: 'user_message',
  CANCEL_RUN: 'cancel_run',
  LOAD_HISTORY: 'load_history',
  CLEAR_HISTORY: 'clear_history',

  // Background → Side panel（流式事件）
  AGENT_STARTED: 'agent_started',
  AGENT_THINKING: 'agent_thinking',
  AGENT_REASONING: 'agent_reasoning',
  AGENT_TOOL_CALL: 'agent_tool_call',
  AGENT_TOOL_RESULT: 'agent_tool_result',
  AGENT_MESSAGE: 'agent_message',
  AGENT_DONE: 'agent_done',
  AGENT_ERROR: 'agent_error',
  AGENT_USAGE: 'agent_usage',
  HISTORY: 'history',
} as const

export type MsgType = (typeof MSG)[keyof typeof MSG]

// ---------- Payload 类型 ----------

export interface UserMessagePayload {
  text: string
  sessionId?: string
  /** 提交时激活的 tab,供 agent 工具读取(避免执行时误读切换后的 tab) */
  tabId?: number
}

export interface CancelRunPayload {
  sessionId: string
}

export type SideToBg =
  | { type: typeof MSG.USER_MESSAGE; payload: UserMessagePayload }
  | { type: typeof MSG.CANCEL_RUN; sessionId: string }
  | { type: typeof MSG.LOAD_HISTORY; sessionId: string }
  | { type: typeof MSG.CLEAR_HISTORY; sessionId: string }

// ---------- 面板展示用消息(前后端一致的精简形状) ----------

/** 前端渲染用:只含 user/assistant 文本,不含 tool 内部消息 */
export interface ChatRecord {
  role: "user" | "assistant";
  content: string;
}

// ---------- Agent 流式事件（discriminated union） ----------

export type AgentEvent =
  | { type: typeof MSG.AGENT_STARTED; sessionId: string }
  | { type: typeof MSG.AGENT_THINKING; turn: number }
  /** 思考过程增量(DeepSeek reasoning_content,流式);先于 content 到达 */
  | { type: typeof MSG.AGENT_REASONING; delta: string }
  | {
      type: typeof MSG.AGENT_TOOL_CALL;
      id: string;
      name: string;
      displayName?: string;
      args?: unknown;
    }
  | {
      type: typeof MSG.AGENT_TOOL_RESULT;
      id: string;
      name: string;
      ok: boolean;
      result: unknown;
    }
  | { type: typeof MSG.AGENT_MESSAGE; delta: string }
  | { type: typeof MSG.AGENT_DONE }
  | { type: typeof MSG.AGENT_ERROR; error: string }
  | { type: typeof MSG.AGENT_USAGE; used: number; max: number }
  | { type: typeof MSG.HISTORY; messages: ChatRecord[] }
