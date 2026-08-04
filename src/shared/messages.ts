// Side panel ↔ Service Worker 共享的消息协议
// 任何一端修改时务必保持双向一致

export const PORT_NAME = 'agent-port' as const

export const MSG = {
  // Side panel → Background
  USER_MESSAGE: 'user_message',
  CANCEL_RUN: 'cancel_run',

  // Background → Side panel（流式事件）
  AGENT_STARTED: 'agent_started',
  AGENT_THINKING: 'agent_thinking',
  AGENT_TOOL_CALL: 'agent_tool_call',
  AGENT_TOOL_RESULT: 'agent_tool_result',
  AGENT_MESSAGE: 'agent_message',
  AGENT_DONE: 'agent_done',
  AGENT_ERROR: 'agent_error',
} as const

export type MsgType = (typeof MSG)[keyof typeof MSG]

// ---------- Payload 类型 ----------

export interface UserMessagePayload {
  text: string
  sessionId?: string
}

export interface CancelRunPayload {
  sessionId: string
}

export type SideToBg =
  | { type: typeof MSG.USER_MESSAGE; payload: UserMessagePayload }
  | { type: typeof MSG.CANCEL_RUN; sessionId: string }

// ---------- Agent 流式事件（discriminated union） ----------

export type AgentEvent =
  | { type: typeof MSG.AGENT_STARTED; sessionId: string }
  | { type: typeof MSG.AGENT_THINKING; turn: number }
  | { type: typeof MSG.AGENT_TOOL_CALL; name: string; args?: unknown }
  | { type: typeof MSG.AGENT_TOOL_RESULT; name: string; result: unknown }
  | { type: typeof MSG.AGENT_MESSAGE; delta: string }
  | { type: typeof MSG.AGENT_DONE }
  | { type: typeof MSG.AGENT_ERROR; error: string }
