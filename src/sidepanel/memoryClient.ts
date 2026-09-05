// 面板侧 MEM_* 轻客户端:一次性端口发一条请求,等后台回全量列表。
// 设置页(摘要入口行)与记忆页(增删改查)共用;CRUD 全走消息,
// 面板不碰 IDB(SW 是唯一读写方,同 SessionsView 的约束)。

import { MSG, PORT_NAME, type MemoryItem } from "../shared/messages";

export function memReq(msg: Record<string, unknown>): Promise<MemoryItem[]> {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: PORT_NAME });
    port.onMessage.addListener(
      (evt: { type?: string; memories?: MemoryItem[] }) => {
        if (evt.type === MSG.MEMORIES) {
          resolve(evt.memories ?? []);
          port.disconnect();
        }
      },
    );
    port.onDisconnect.addListener(() => reject(new Error("port closed")));
    port.postMessage(msg);
  });
}
