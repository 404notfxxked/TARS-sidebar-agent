// 面板侧 MEM_* 轻客户端:一次性端口发一条请求,等后台回全量列表。
// 设置页(摘要入口行)与记忆页(增删改查)共用;CRUD 全走消息,
// 面板不碰 IDB(SW 是唯一读写方,同 SessionsView 的约束)。

import { MSG, type MemoryItem } from "../../shared/messages";
import { portReq } from "./portRequest";

export async function memReq(
  msg: Record<string, unknown>,
): Promise<MemoryItem[]> {
  const evt = await portReq<{ memories?: MemoryItem[] }>(msg, MSG.MEMORIES);
  return evt.memories ?? [];
}
