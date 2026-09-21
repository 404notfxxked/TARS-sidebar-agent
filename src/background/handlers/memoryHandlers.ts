// memory 域 port 消息 handler:记忆列表/增改/置顶/删除/清空,每个写动作
// 都回全量列表(面板以回包为准刷新)。存储访问走 memory/memoryStore,
// port 仍归 index.ts 所有,此处只经 ctx 访问。
//
// 兜底契约(审计 §1.3):存储操作抛错(指向不存在/已删条目等)时仍回
// MEMORIES 包(当前列表 + error)—— 面板的 await 靠回包收口,无回包 =
// 永久挂起。措辞经 errText 透传原始错误,日志记 warn 供诊断。

import { MSG, type SideToBg } from "../../shared/messages";
import { errText } from "../../shared/errors";
import { createLogger } from "../../shared/logger";
import {
  addMemory,
  clearMemories,
  deleteMemoryById,
  loadMemories,
  setMemoryPinned,
  updateMemory,
} from "../memory/memoryStore";
import type { PortCtx } from "./context";

const log = createLogger({ ctx: "bg" });

export async function handleMemoryMessage(
  msg: SideToBg,
  ctx: PortCtx,
): Promise<boolean> {
  const { port } = ctx;
  // 回包永不抛:列表读取失败时回空列表 + error,让面板的 await 一定收口
  const reply = async (error?: string) => {
    const memories = await loadMemories().catch(() => []);
    port.postMessage({
      type: MSG.MEMORIES,
      memories,
      ...(error ? { error } : {}),
    });
  };
  const failed = async (op: string, e: unknown) => {
    log.warn("memory", "记忆操作失败,回当前列表兜底", {
      op,
      error: errText(e),
    });
    await reply(errText(e));
  };
  switch (msg.type) {
    case MSG.MEM_LIST: {
      await reply();
      return true;
    }
    case MSG.MEM_ADD: {
      try {
        await addMemory(msg.text, "user");
      } catch (e) {
        await failed("add", e);
        return true;
      }
      await reply();
      return true;
    }
    case MSG.MEM_UPDATE: {
      try {
        await updateMemory(msg.id, msg.text);
      } catch (e) {
        await failed("update", e);
        return true;
      }
      await reply();
      return true;
    }
    case MSG.MEM_PIN: {
      try {
        await setMemoryPinned(msg.id, msg.pinned);
      } catch (e) {
        await failed("pin", e);
        return true;
      }
      await reply();
      return true;
    }
    case MSG.MEM_DELETE: {
      try {
        await deleteMemoryById(msg.id);
      } catch (e) {
        await failed("delete", e);
        return true;
      }
      await reply();
      return true;
    }
    case MSG.MEM_CLEAR: {
      try {
        await clearMemories();
      } catch (e) {
        await failed("clear", e);
        return true;
      }
      await reply();
      return true;
    }
    default:
      return false;
  }
}
