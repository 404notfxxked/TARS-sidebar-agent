// 会话 id 存储:全局单会话,持久化到 chrome.storage.session
// 会话与 tab 解耦:sessionId 只代表一段对话,页面上下文由消息级 tabId 承载
// 为什么用 session storage:面板重开 / SW 休眠后仍可取回,浏览器重启自动清空(会话语义)

const GLOBAL_KEY = "sessionId:default";

/** 取全局会话 id;没有则创建并持久化(多轮记忆按此 id 取回) */
export async function getOrCreateSessionId(): Promise<string> {
  const data = await chrome.storage.session.get(GLOBAL_KEY);
  const existing = data[GLOBAL_KEY] as string | undefined;
  if (existing) return existing;
  const id = crypto.randomUUID();
  await chrome.storage.session.set({ [GLOBAL_KEY]: id });
  return id;
}
