// Side panel ↔ Service Worker 共享的消息协议
// 任何一端修改时务必保持双向一致

export const PORT_NAME = 'agent-port' as const

import type { McpServerEntry } from "./mcp"
import type { MemoryTag } from "./memory"

export const MSG = {
  // Side panel → Background
  USER_MESSAGE: 'user_message',
  // 重新生成:截掉末轮(自末条 user 行含),用原内容重跑一轮
  REGENERATE: 'regenerate',
  CANCEL_RUN: 'cancel_run',
  LOAD_HISTORY: 'load_history',
  LIST_SESSIONS: 'list_sessions',
  DELETE_SESSION: 'delete_session',
  CLEAR_ALL_HISTORY: 'clear_all_history',
  GET_IMAGE: 'get_image',
  MEM_LIST: 'mem_list',
  MEM_ADD: 'mem_add',
  MEM_UPDATE: 'mem_update',
  MEM_PIN: 'mem_pin',
  MEM_DELETE: 'mem_delete',
  MEM_CLEAR: 'mem_clear',
  SKILL_LIST: 'skill_list',
  SKILL_ADD: 'skill_add',
  SKILL_GET: 'skill_get',
  SKILL_UPDATE: 'skill_update',
  SKILL_TOGGLE: 'skill_toggle',
  SKILL_DELETE: 'skill_delete',
  MCP_TEST: 'mcp_test',
  MCP_TOOLS: 'mcp_tools',
  PANEL_VISIBILITY: 'panel_visibility',
  CONFIRM_RESPONSE: 'confirm_response',

  // Background → Side panel（流式事件）
  AGENT_STARTED: 'agent_started',
  AGENT_THINKING: 'agent_thinking',
  AGENT_REASONING: 'agent_reasoning',
  AGENT_TOOL_CALL: 'agent_tool_call',
  AGENT_TOOL_RESULT: 'agent_tool_result',
  AGENT_CONFIRM_REQUEST: 'agent_confirm_request',
  AGENT_MESSAGE: 'agent_message',
  AGENT_DONE: 'agent_done',
  AGENT_ERROR: 'agent_error',
  HISTORY: 'history',
  SESSIONS: 'sessions',
  IMAGE_DATA: 'image_data',
  MEMORIES: 'memories',
  SKILLS: 'skills',
  SKILL_RAW: 'skill_raw',
  MCP_TEST_RESULT: 'mcp_test_result',
  MCP_TOOLS_RESULT: 'mcp_tools_result',
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
  | { type: typeof MSG.REGENERATE; sessionId: string }
  | { type: typeof MSG.CANCEL_RUN; sessionId: string }
  | { type: typeof MSG.PANEL_VISIBILITY; hidden: boolean }
  | { type: typeof MSG.CONFIRM_RESPONSE; requestId: string; approved: boolean }
  | { type: typeof MSG.LOAD_HISTORY; sessionId: string; resync?: boolean }
  | { type: typeof MSG.LIST_SESSIONS }
  | { type: typeof MSG.DELETE_SESSION; sessionId: string }
  | { type: typeof MSG.CLEAR_ALL_HISTORY }
  | { type: typeof MSG.GET_IMAGE; id: string }
  | { type: typeof MSG.MEM_LIST }
  | { type: typeof MSG.MEM_ADD; text: string }
  | { type: typeof MSG.MEM_UPDATE; id: string; text: string }
  | { type: typeof MSG.MEM_PIN; id: string; pinned: boolean }
  | { type: typeof MSG.MEM_DELETE; id: string }
  | { type: typeof MSG.MEM_CLEAR }
  | { type: typeof MSG.SKILL_LIST }
  | { type: typeof MSG.SKILL_ADD; raw: string }
  | { type: typeof MSG.SKILL_GET; id: string }
  | { type: typeof MSG.SKILL_UPDATE; id: string; raw: string }
  | { type: typeof MSG.SKILL_TOGGLE; id: string; enabled: boolean }
  | { type: typeof MSG.SKILL_DELETE; id: string }
  | { type: typeof MSG.MCP_TEST; server: McpServerEntry }
  | { type: typeof MSG.MCP_TOOLS; server: McpServerEntry }

// ---------- 面板展示用消息(前后端一致的精简形状) ----------

/** 会话元数据(历史列表用):title 是首条用户消息的截断 */
export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  msgCount: number;
}

/** 回放过程项:历史 run 内的思考/中间文案/工具调用+结果,按到达顺序排列,
 *  由后台投影聚合(sessionHistory toChatRecords),面板 ReplayProcessCard 渲染。
 *  落库没有结构化的工具成败标记,按 wire 约定「Error: 」前缀判错误态 */
export type ProcessItem =
  | { kind: "reasoning"; text: string }
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      args?: unknown;
      /** 工具结果原文(投影侧超长截断并标注体量);配对的 tool 行缺失时无此字段 */
      result?: string;
      error?: boolean;
    };

/** 前端渲染用:只含 user/assistant 文本(+ 图片元信息),不含 tool 内部消息。
 *  图片字节经 GET_IMAGE/IMAGE_DATA 单独取,不随消息列表传。
 *  seq = 该记录对应消息在库里的序号(0 基稠密),压缩分隔条据此定位 */
export interface ChatRecord {
  role: "user" | "assistant";
  content: string;
  images?: ImageMeta[];
  seq?: number;
  /** 后台注入给模型的伪 user 消息(截图附件的系统注记):消息本身全量落盘
   *  (虚拟上下文地基),但面板不作真实用户气泡渲染,只展示附件图片 */
  synthetic?: true;
  /** 运行失败占位行:回放渲染错误气泡(与实况同文同源) */
  error?: true;
  /** 纯过程行:该 run 没有收尾记录(取消/SW 被杀,历史停在工具结果上),
   *  过程数据无气泡可挂,以此载体行独立成卡 */
  processOnly?: true;
  /** 该 run 的过程数据(思考/中间文案/工具调用+结果):挂在收尾记录
   *  (回答/error)或 processOnly 载体行上,回放渲染为过程卡 */
  processItems?: ProcessItem[];
}

/** 会话压缩元数据(面板展示用):seq ≤ uptoSeq 的消息已压缩为摘要,
 *  摘要文本本身留在后台(会话行),面板只需要压缩点位置来渲染分隔条 */
export interface CompactionMark {
  uptoSeq: number;
  at: number;
}

/** 长期记忆条目(面板展示用):与后台 MemoryRow 一致的精简形状。
 *  key/subject/tag 是卡片态可选字段,与 MemoryRow 同步改(契约 1) */
export interface MemoryItem {
  id: string;
  text: string;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  source: "user" | "model";
  key?: string;
  subject?: string;
  tag?: MemoryTag;
}

/** 技能条目(技能页 / 菜单展示用):不含正文 —— 正文较大且展示层用不到,
 *  编辑时经 SKILL_GET/SKILL_RAW 单独取 */
export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  updatedAt: number;
  /** 正文体积(字符),列表行做量级提示 */
  chars: number;
}

/** MCP 工具清单项(设置页展示用;description 已是服务器原文,面板自行截断) */
export interface McpToolInfo {
  name: string;
  description: string;
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
  /** 写操作确认门:SW 在执行 click_element / fill_input 前发出,
   *  面板弹确认卡,用户答复后经 CONFIRM_RESPONSE 回来;超时视为拒绝 */
  | {
      type: typeof MSG.AGENT_CONFIRM_REQUEST;
      requestId: string;
      name: string;
      displayName?: string;
      args?: unknown;
      /** 目标标签页(确认卡展示「操作将落在哪个页面」);取不到时缺省 */
      tabTitle?: string;
      tabUrl?: string;
    }
  | { type: typeof MSG.AGENT_MESSAGE; delta: string }
  /** reason 缺省 = 兜底/取消路径发的 DONE(如 index.ts 的 finally);"max-turns" = 步数耗尽后收尾 */
  | { type: typeof MSG.AGENT_DONE; reason?: "complete" | "max-turns" }
  | { type: typeof MSG.AGENT_ERROR; error: string }
  | {
      type: typeof MSG.HISTORY;
      /** 该份历史所属会话:面板据此做「响应会话 == 当前会话」新鲜度判定,
       *  快速切会话时迟到的旧回包不得盖上新会话的 id */
      sessionId: string;
      messages: ChatRecord[];
      /** 该会话存在压缩时带上:面板在压缩点渲染分隔条 */
      compaction?: CompactionMark | null;
      /** 回显 LOAD_HISTORY.resync:面板据此走「按库替换」而非「本地空才填」 */
      resync?: boolean;
    }
  | { type: typeof MSG.SESSIONS; sessions: SessionMeta[] }
  | { type: typeof MSG.MEMORIES; memories: MemoryItem[] }
  /** 技能列表:增删改/启停后都回全量(同 MEMORIES);error = 操作失败原因
   *  (解析错误等),面板就地展示,列表仍以后台实际状态为准 */
  | { type: typeof MSG.SKILLS; skills: SkillInfo[]; error?: string }
  | { type: typeof MSG.SKILL_RAW; id: string; raw?: string }
  | {
      type: typeof MSG.MCP_TEST_RESULT;
      ok: boolean;
      toolCount?: number;
      era?: string;
      error?: string;
    }
  | { type: typeof MSG.MCP_TOOLS_RESULT; tools: McpToolInfo[]; error?: string }
  /** base64 缺省 = 图片已不存在(被清理/清空),面板显示失效占位 */
  | {
      type: typeof MSG.IMAGE_DATA;
      id: string;
      mime?: string;
      base64?: string;
      w?: number;
      h?: number;
    }
