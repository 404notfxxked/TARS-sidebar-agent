// 面板侧 MEM_* 轻客户端:一次性端口发一条请求,等后台回全量列表。
// 设置页(摘要入口行)与记忆页(增删改查)共用;CRUD 全走消息,
// 面板不碰 IDB(SW 是唯一读写方,同 SessionsView 的约束)。

import { MSG, type MemoryItem } from "../../shared/messages";
import { portReq } from "./portRequest";

/** MEM_* 请求 → MEMORIES 应答(全量列表 + 可选 error:存储抛错时后台
 *  仍回包,面板就地展示 —— 调用方拿列表照常刷新,错误按需呈现) */
export async function memReq(msg: Record<string, unknown>): Promise<{
  memories: MemoryItem[];
  error?: string;
}> {
  const evt = await portReq<{ memories?: MemoryItem[]; error?: string }>(
    msg,
    MSG.MEMORIES,
  );
  return { memories: evt.memories ?? [], error: evt.error };
}
