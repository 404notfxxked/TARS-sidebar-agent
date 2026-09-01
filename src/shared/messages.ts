// Side panel ↔ Service Worker 共享的消息协议
// 任何一端修改时务必保持双向一致

export const PORT_NAME = 'agent-port' as const

export const MSG = {
  // Side panel → Background
  USER_MESSAGE: 'user_message',
  CANCEL_RUN: 'cancel_run',
  LOAD_HISTORY: 'load_history',
  LIST_SESSIONS: 'list_sessions',
  DELETE_SESSION: 'delete_session',
  CLEAR_ALL_HISTORY: 'clear_all_history',
  GET_IMAGE: 'get_image',

  // Background → Side panel（流式事件）
  AGENT_STARTED: 'agent_started',
  AGENT_THINKING: 'agent_thinking',
  AGENT_REASONING: 'agent_reasoning',
  AGENT_TOOL_CALL: 'agent_tool_call',
  AGENT_TOOL_RESULT: 'agent_tool_result',
  AGENT_MESSAGE: 'agent_message',
  AGENT_DONE: 'agent_done',
  AGENT_ERROR: 'agent_error',
  HISTORY: 'history',
  SESSIONS: 'sessions',
  IMAGE_DATA: 'image_data',
} as const

export type MsgType = (typeof MSG)[keyof typeof MSG]

// ---------- Payload 类型 ----------

/** 图片附件元信息:历史引用与气泡渲染用,不含字节 */
export interface ImageMeta {
  id: string;
  mime: string;
  w: number;
  h: number;
}

/** 面板 → 后端的图片负载:压缩结果以 base64 传输(port 消息是 JSON 语义,
 *  ArrayBuffer 过不去,见 shared/imageCodec) */
export interface ImageUpload {
  mime: string;
  base64: string;
  w: number;
  h: number;
}

export interface UserMessagePayload {
  text: string
  sessionId?: string
  /** 提交时激活的 tab,供 agent 工具读取(避免执行时误读切换后的 tab) */
  tabId?: number
  /** 随消息发送的图片(面板已完成门控/压缩;agent 侧按模型能力二次把关) */
  images?: ImageUpload[]
}

export interface CancelRunPayload {
  sessionId: string
}

export type SideToBg =
  | { type: typeof MSG.USER_MESSAGE; payload: UserMessagePayload }
  | { type: typeof MSG.CANCEL_RUN; sessionId: string }
  | { type: typeof MSG.LOAD_HISTORY; sessionId: string }
  | { type: typeof MSG.LIST_SESSIONS }
  | { type: typeof MSG.DELETE_SESSION; sessionId: string }
  | { type: typeof MSG.CLEAR_ALL_HISTORY }
  | { type: typeof MSG.GET_IMAGE; id: string }

// ---------- 面板展示用消息(前后端一致的精简形状) ----------

/** 会话元数据(历史列表用):title 是首条用户消息的截断 */
export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  msgCount: number;
}

/** 前端渲染用:只含 user/assistant 文本(+ 图片元信息),不含 tool 内部消息。
 *  图片字节经 GET_IMAGE/IMAGE_DATA 单独取,不随消息列表传 */
export interface ChatRecord {
  role: "user" | "assistant";
  content: string;
  images?: ImageMeta[];
}

// ---------- Agent 流式事件（discriminated union） ----------

export type AgentEvent =
  | { type: typeof MSG.AGENT_STARTED; sessionId: string }
  | { type: typeof MSG.AGENT_THINKING; turn: number }
  /** 思考过程增量(reasoning_content / reasoning 方言,流式);先于 content 到达 */
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
  /** reason 缺省 = 兜底/取消路径发的 DONE(如 index.ts 的 finally);"max-turns" = 步数耗尽后收尾 */
  | { type: typeof MSG.AGENT_DONE; reason?: "complete" | "max-turns" }
  | { type: typeof MSG.AGENT_ERROR; error: string }
  | { type: typeof MSG.HISTORY; messages: ChatRecord[] }
  | { type: typeof MSG.SESSIONS; sessions: SessionMeta[] }
  /** base64 缺省 = 图片已不存在(被清理/清空),面板显示失效占位 */
  | {
      type: typeof MSG.IMAGE_DATA;
      id: string;
      mime?: string;
      base64?: string;
      w?: number;
      h?: number;
    }
