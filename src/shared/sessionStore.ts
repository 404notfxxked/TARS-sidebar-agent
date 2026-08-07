// 会话 id 存储:以 tab 为维度,持久化到 chrome.storage.session
// - 为什么按 tab:agent 读取的内容是「当前激活 tab」的页面,对话上下文应跟随阅读对象
// - 为什么用 session storage:面板重开 / SW 休眠后仍可取回,浏览器重启自动清空(会话语义)
// - P0 边界:同 tab 内导航到另一篇文章不会重置会话,后续可按 URL 进一步细分

const KEY_PREFIX = "sessionId:";

/** 取某 tab 的会话 id;没有则创建并持久化(供面板重开、多轮记忆按会话取回) */
export async function getOrCreateSessionId(tabId: number): Promise<string> {
  const key = KEY_PREFIX + tabId;
  const data = await chrome.storage.session.get(key);
  const existing = data[key] as string | undefined;
  if (existing) return existing;
  const id = crypto.randomUUID();
  await chrome.storage.session.set({ [key]: id });
  return id;
}
