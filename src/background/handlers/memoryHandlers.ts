// memory 域 port 消息 handler:记忆列表/增改/置顶/删除/清空,每个写动作
// 都回全量列表(面板以回包为准刷新)。存储访问走 memory/memoryStore,
// port 仍归 index.ts 所有,此处只经 ctx 访问。

import { MSG, type SideToBg } from "../../shared/messages";
import {
  addMemory,
  clearMemories,
  deleteMemoryById,
  loadMemories,
  setMemoryPinned,
  updateMemory,
} from "../memory/memoryStore";
import type { PortCtx } from "./context";

export async function handleMemoryMessage(
  msg: SideToBg,
  ctx: PortCtx,
): Promise<boolean> {
  const { port } = ctx;
  switch (msg.type) {
    case MSG.MEM_LIST: {
      port.postMessage({
        type: MSG.MEMORIES,
        memories: await loadMemories(),
      });
      return true;
    }
    case MSG.MEM_ADD: {
      await addMemory(msg.text, "user");
      port.postMessage({
        type: MSG.MEMORIES,
        memories: await loadMemories(),
      });
      return true;
    }
    case MSG.MEM_UPDATE: {
      await updateMemory(msg.id, msg.text);
      port.postMessage({
        type: MSG.MEMORIES,
        memories: await loadMemories(),
      });
      return true;
    }
    case MSG.MEM_PIN: {
      await setMemoryPinned(msg.id, msg.pinned);
      port.postMessage({
        type: MSG.MEMORIES,
        memories: await loadMemories(),
      });
      return true;
    }
    case MSG.MEM_DELETE: {
      await deleteMemoryById(msg.id);
      port.postMessage({
        type: MSG.MEMORIES,
        memories: await loadMemories(),
      });
      return true;
    }
    case MSG.MEM_CLEAR: {
      await clearMemories();
      port.postMessage({
        type: MSG.MEMORIES,
        memories: await loadMemories(),
      });
      return true;
    }
    default:
      return false;
  }
}
