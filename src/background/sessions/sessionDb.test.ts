// sessionDb 的键序回归测试:messages 第二键是数字(seq)、images 第二键是
// 字符串(uuid),IDB 键序 number < string —— 用 [id, Infinity] 做会话前缀
// 上界时图片行一条都删不到(真实泄漏)。这类 bug 只有按「键序」
// 维度断言才拦得住:用 fake-indexeddb(实现了 IDB 键序算法)钉死行为。
// fake-indexeddb/auto 会把 globalThis.indexedDB 换成内存实现,node 环境可跑。

import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendMessages,
  clearAllRows,
  deleteMessagesFrom,
  deleteSessionRows,
  deleteSessions,
  getImage,
  listSessions,
  loadMessageRows,
  type ImageRow,
  type SessionRow,
} from "./sessionDb";

afterEach(async () => {
  await clearAllRows();
});

const meta = (id: string, msgCount: number): SessionRow => ({
  id,
  title: `会话 ${id}`,
  createdAt: 0,
  updatedAt: 0,
  msgCount,
});

const imgRow = (sessionId: string, id: string): ImageRow => ({
  sessionId,
  id,
  mime: "image/jpeg",
  w: 2,
  h: 2,
  bytes: new Uint8Array([1, 2, 3]),
});

async function countStore(store: string): Promise<number> {
  // 直读 store 计数,绕过封装:封装本身就是要被测的对象
  return new Promise((done, fail) => {
    const req = indexedDB.open("tars");
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(store, "readonly");
      const q = tx.objectStore(store).count();
      q.onsuccess = () => {
        db.close();
        done(q.result);
      };
      q.onerror = () => fail(q.error);
    };
    req.onerror = () => fail(req.error);
  });
}

describe("sessionDb 会话删除的图片级联回收(键序回归)", () => {
  it("deleteSessionRows 删单会话:字符串主键的图片行一并消失", async () => {
    const sid = "session-a";
    const imgA = crypto.randomUUID();
    const imgB = crypto.randomUUID();
    await appendMessages(
      sid,
      meta(sid, 2),
      [
        { role: "user", content: "看这张图" },
        { role: "assistant", content: "好的" },
      ],
      0,
      [imgRow(sid, imgA), imgRow(sid, imgB)],
    );
    expect(await countStore("messages")).toBe(2);
    expect(await countStore("images")).toBe(2);

    await deleteSessionRows(sid);

    expect(await countStore("sessions")).toBe(0);
    expect(await countStore("messages")).toBe(0);
    expect(await countStore("images")).toBe(0);
    expect(await getImage(imgA)).toBeUndefined();
  });

  it("deleteSessions 批量删(保留期清理):图片行同样回收,邻会话不受影响", async () => {
    const old1Img = crypto.randomUUID();
    const keepImg = crypto.randomUUID();
    await appendMessages(
      "old-1",
      meta("old-1", 1),
      [{ role: "user", content: "旧一" }],
      0,
      [imgRow("old-1", old1Img)],
    );
    await appendMessages(
      "old-2",
      meta("old-2", 1),
      [{ role: "user", content: "旧二" }],
      0,
      [imgRow("old-2", crypto.randomUUID())],
    );
    await appendMessages(
      "keep-me",
      meta("keep-me", 1),
      [{ role: "user", content: "活跃" }],
      0,
      [imgRow("keep-me", keepImg)],
    );

    await deleteSessions(["old-1", "old-2"]);

    const sessions = await listSessions();
    expect(sessions.map((s) => s.id)).toEqual(["keep-me"]);
    expect(await countStore("images")).toBe(1);
    // 面板读图走 byId 索引:孤儿行曾因此仍可被读到,这里钉住两端
    expect(await getImage(old1Img)).toBeUndefined();
    expect((await getImage(keepImg))?.sessionId).toBe("keep-me");
  });

  it("deleteMessagesFrom 只截消息行,图片行留待会话级删除回收(现状)", async () => {
    const sid = "regen";
    await appendMessages(
      sid,
      meta(sid, 2),
      [
        { role: "user", content: "第一问" },
        { role: "assistant", content: "第一答" },
      ],
      0,
      [imgRow(sid, crypto.randomUUID())],
    );
    await appendMessages(
      sid,
      meta(sid, 4),
      [
        { role: "user", content: "第二问" },
        { role: "assistant", content: "第二答" },
      ],
      2,
      [imgRow(sid, crypto.randomUUID())],
    );

    await deleteMessagesFrom(sid, 2);

    const rows = await loadMessageRows(sid);
    expect(rows).toHaveLength(2);
  });

  it("deleteMessagesFrom 级联回收截断段引用的图片行,未截断轮次的不受影响", async () => {
    const sid = "regen-img";
    const keepId = crypto.randomUUID();
    const doomedId = crypto.randomUUID();
    await appendMessages(
      sid,
      meta(sid, 2),
      [
        {
          role: "user",
          content: "第一问",
          images: [{ id: keepId, mime: "image/jpeg", w: 2, h: 2 }],
        },
        { role: "assistant", content: "第一答" },
      ],
      0,
      [imgRow(sid, keepId)],
    );
    await appendMessages(
      sid,
      meta(sid, 4),
      [
        {
          role: "user",
          content: "第二问",
          images: [{ id: doomedId, mime: "image/jpeg", w: 2, h: 2 }],
        },
        { role: "assistant", content: "第二答" },
      ],
      2,
      [imgRow(sid, doomedId)],
    );

    await deleteMessagesFrom(sid, 2, 1);

    // 截断段(第二问)引用的图片字节已随消息行一起回收;第一问的还在
    expect(await getImage(keepId)).toBeDefined();
    expect(await getImage(doomedId)).toBeUndefined();
    // db 层不产可见口径:该会话行从未写过 visibleCount(appendMessages 直写),
    // 缓存缺省语义 = 不动,读侧回落扫描
    const session = (await listSessions()).find((r) => r.id === sid);
    expect(session?.visibleCount).toBeUndefined();
  });
});
