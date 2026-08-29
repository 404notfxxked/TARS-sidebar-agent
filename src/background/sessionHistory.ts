// 会话历史存储:按 sessionId 持久化「完整」InternalMsg[](含 tool call/result)
// 方案 A:后端是历史的唯一持有者,前端只发最新消息、只显示精简投影

import type { InternalMsg } from "./provider/types";
import type { ChatRecord } from "../shared/messages";

const KEY = (sessionId: string) => `history:${sessionId}`;

/** 读某会话历史;没有则返回空数组 */
export async function loadHistory(sessionId: string): Promise<InternalMsg[]> {
  if (!sessionId) return [];
  const data = await chrome.storage.session.get(KEY(sessionId));
  const msgs = data[KEY(sessionId)];
  return Array.isArray(msgs) ? (msgs as InternalMsg[]) : [];
}

/** 覆盖写某会话历史(调用方保证传入完整的最新数组)。
 *  落盘前剥离思考内容(reasoning_content):严格按 OpenAI 规范校验的端点(官方
 *  API 属于这类)对 assistant 消息里的未知字段直接 400,DeepSeek 官方则忽略之
 *  —— 统一不回传。单次 run 内的逐轮回传不受影响(agent 循环直接用内存
 *  messages,不经这里,兼容要求一致性的 vLLM 工具循环部署);UI 也不从历史
 *  回放思考内容,剥离零损失。 */
export async function saveHistory(
  sessionId: string,
  msgs: InternalMsg[],
): Promise<void> {
  if (!sessionId) return;
  const persistable = msgs.map((m) =>
    m.role === "assistant" && m.reasoning_content !== undefined
      ? {
          // 重建对象以彻底去掉 reasoning_content 键(undefined 值可能被存储层保留)
          role: "assistant" as const,
          content: m.content,
          ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
          ...(m.model ? { model: m.model } : {}),
        }
      : m,
  );
  await chrome.storage.session.set({ [KEY(sessionId)]: persistable });
}

/** 清空某会话历史(预留:将来「新建会话」按钮用) */
export async function clearHistory(sessionId: string): Promise<void> {
  if (!sessionId) return;
  await chrome.storage.session.remove(KEY(sessionId));
}

/** 完整 InternalMsg[] → 前端展示用的精简投影(只留 user/assistant 文本) */
export function toChatRecords(msgs: InternalMsg[]): ChatRecord[] {
  const out: ChatRecord[] = [];
  for (const m of msgs) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant" && m.content) {
      out.push({ role: "assistant", content: m.content });
    }
    // tool / 空 assistant 不展示
  }
  return out;
}
