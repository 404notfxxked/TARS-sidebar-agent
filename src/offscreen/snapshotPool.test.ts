// SnapshotPool 单飞合并与 refresh 语义:不碰 chrome.* / DOM,纯逻辑单测。
// 核心回归:refresh 曾被同批在飞的普通构建吞掉(offscreen/main.ts 旧实现
// 按 tabId 无条件并入),而 refresh 是 SPA 换路后重建快照的唯一手段。

import { describe, expect, it } from "vitest";
import { SnapshotPool } from "./snapshotPool";

interface FakeDoc {
  tag: string;
}

describe("SnapshotPool 单飞合并", () => {
  it("普通请求并入在飞构建:同 tab 只采集一次", async () => {
    let gate!: () => void;
    const opened = new Promise<void>((r) => (gate = r));
    let calls = 0;
    const pool = new SnapshotPool<FakeDoc>(async () => {
      calls++;
      if (calls === 1) await opened; // 第一笔挂起,制造「在飞」窗口
      return { tag: `doc${calls}` };
    }, 6);
    const a = pool.get(1);
    const b = pool.get(1);
    gate();
    const [da, db] = await Promise.all([a, b]);
    expect(calls).toBe(1);
    expect(da.tag).toBe("doc1");
    expect(db.tag).toBe("doc1");
  });

  it("refresh 不并入更早启动的普通构建:触发自己的采集并以后到结果为准", async () => {
    let gate!: () => void;
    const opened = new Promise<void>((r) => (gate = r));
    let calls = 0;
    const pool = new SnapshotPool<FakeDoc>(async () => {
      calls++;
      if (calls === 1) await opened;
      return { tag: `doc${calls}` };
    }, 6);
    const plain = pool.get(1); // 普通构建在飞
    const refreshed = pool.get(1, true); // refresh 撞上在飞:不许并入
    gate();
    const [, db] = await Promise.all([plain, refreshed]);
    expect(calls).toBe(2);
    expect(db.tag).toBe("doc2");
    // 落库以后到者为准:后续普通请求拿重建后的快照
    await expect(pool.get(1)).resolves.toEqual({ tag: "doc2" });
  });

  it("refresh 并入同为 refresh 的在飞构建:不重复采集", async () => {
    let gate!: () => void;
    const opened = new Promise<void>((r) => (gate = r));
    let calls = 0;
    const pool = new SnapshotPool<FakeDoc>(async () => {
      calls++;
      if (calls === 1) await opened;
      return { tag: `doc${calls}` };
    }, 6);
    const a = pool.get(1, true);
    const b = pool.get(1, true);
    gate();
    const [da, db] = await Promise.all([a, b]);
    expect(calls).toBe(1);
    expect(da.tag).toBe("doc1");
    expect(db.tag).toBe("doc1");
  });

  it("普通请求可并入在飞的 refresh 构建(refresh 产物更新,无害)", async () => {
    let gate!: () => void;
    const opened = new Promise<void>((r) => (gate = r));
    let calls = 0;
    const pool = new SnapshotPool<FakeDoc>(async () => {
      calls++;
      if (calls === 1) await opened;
      return { tag: `doc${calls}` };
    }, 6);
    const a = pool.get(1, true);
    const b = pool.get(1);
    gate();
    await Promise.all([a, b]);
    expect(calls).toBe(1);
  });

  it("invalidate 清缓存:下次重新采集;在飞构建不受影响", async () => {
    let calls = 0;
    const pool = new SnapshotPool<FakeDoc>(async () => {
      calls++;
      return { tag: `doc${calls}` };
    }, 6);
    await pool.get(1);
    pool.invalidate(1);
    await expect(pool.get(1)).resolves.toEqual({ tag: "doc2" });
    expect(calls).toBe(2);
  });

  it("构建失败不污染缓存:inflight 收口后下次重试,成功请求可继续落库", async () => {
    let calls = 0;
    const pool = new SnapshotPool<FakeDoc>(async () => {
      calls++;
      if (calls === 1) throw new Error("capture boom");
      return { tag: `doc${calls}` };
    }, 6);
    await expect(pool.get(1)).rejects.toThrow("capture boom");
    await expect(pool.get(1)).resolves.toEqual({ tag: "doc2" });
    expect(calls).toBe(2);
  });

  it("LRU 淘汰:超上限丢最早条目", async () => {
    // 有意不在中途刷新 1 的新鲜度:同毫秒重建时 capturedAt 并列,
    // lruEvict 按插入序淘汰(插入序 = 真实年龄序),测试不依赖时钟推进
    let calls = 0;
    const pool = new SnapshotPool<FakeDoc>(async () => {
      calls++;
      return { tag: `doc${calls}` };
    }, 2);
    await pool.get(1);
    await pool.get(2);
    await pool.get(3); // 挤掉 1
    await expect(pool.get(1)).resolves.toEqual({ tag: "doc4" }); // 1 已被淘汰重采
    await expect(pool.get(3)).resolves.toEqual({ tag: "doc3" }); // 3 仍在缓存
    expect(calls).toBe(4);
  });
});
