// memory 域 port handler 的兜底契约(审计 §1.3):存储操作抛错(如指向
// 不存在/已删条目的 id)时,handler 仍必须回 MEMORIES 包(全量列表 +
// error),否则面板 await 永久挂起,只能重载。协议对照:SKILLS 早已带
// 可选 error,MEMORIES 此前没有 —— 挂死 = 无回包而非错误回包。

import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { MSG } from "../../shared/messages";
import type { PortCtx } from "./context";
import { handleMemoryMessage } from "./memoryHandlers";
import { addMemory, clearMemories } from "../memory/memoryStore";

// 桩 port:收集全部出站消息
const sent: unknown[] = [];
const ctx = {
  port: { postMessage: (m: unknown) => sent.push(m) },
} as unknown as PortCtx;

beforeEach(async () => {
  sent.length = 0;
  await clearMemories();
  await addMemory("种子记忆", "user");
});

describe("handleMemoryMessage 兜底契约(审计 §1.3 回归)", () => {
  it("MEM_PIN 指向不存在的 id:仍回 MEMORIES 包(列表 + error)", async () => {
    const handled = await handleMemoryMessage(
      { type: MSG.MEM_PIN, id: "ghost-id", pinned: true },
      ctx,
    );
    expect(handled).toBe(true);
    expect(sent).toHaveLength(1);
    const evt = sent[0] as { type: string; memories?: unknown[]; error?: string };
    expect(evt.type).toBe(MSG.MEMORIES);
    expect(Array.isArray(evt.memories)).toBe(true);
    expect(evt.memories?.length).toBe(1); // 全量列表仍在(种子记忆未受影响)
    expect(typeof evt.error).toBe("string");
  });

  it("MEM_UPDATE 指向不存在的 id:仍回 MEMORIES 包(列表 + error)", async () => {
    const handled = await handleMemoryMessage(
      { type: MSG.MEM_UPDATE, id: "ghost-id", text: "改不存在的记忆" },
      ctx,
    );
    expect(handled).toBe(true);
    expect(sent).toHaveLength(1);
    const evt = sent[0] as { type: string; memories?: unknown[]; error?: string };
    expect(evt.type).toBe(MSG.MEMORIES);
    expect(typeof evt.error).toBe("string");
  });

  it("正常路径:回包无 error 字段(不带空 error 噪声)", async () => {
    await handleMemoryMessage({ type: MSG.MEM_LIST }, ctx);
    expect(sent).toHaveLength(1);
    const evt = sent[0] as { type: string; error?: string };
    expect(evt.type).toBe(MSG.MEMORIES);
    expect(evt.error).toBeUndefined();
  });
});
