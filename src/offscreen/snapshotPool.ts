// 快照池:per-tab 虚拟文档缓存 + 单飞(single-flight)构建合并,LRU 淘汰。
// 从 main.ts 拆出的纯协调层——采集动作以回调注入,不碰 chrome.* 与 DOM,
// 并发语义可单测(snapshotPool.test.ts)。
//
// 关键取舍(refresh 语义,2026-10-05 修):普通请求并入在飞构建省一次真实
// 采集;refresh 请求只并入同为 refresh 的在飞构建 —— refresh 是 SPA 换路后
// 重建快照的唯一手段,并入更早启动的普通构建会把旧路由快照当「新」的还给
// 模型(refresh 被静默吞掉)。此时串行化:等在飞构建收口(成败都不阻塞)
// 再发起自己的采集,落库以后到者为准。
// 清理纪律:inflight 条目条件清除(仍是自己的 entry 才删),并发覆盖单槽时
// 不越权删别人的(同 toolContext 的 current === mine 判据)。

import { lruEvict } from "./lru";

export class SnapshotPool<V> {
  private snapshots = new Map<number, { doc: V; capturedAt: number }>();
  private inflight = new Map<number, { promise: Promise<V>; refresh: boolean }>();

  constructor(
    /** 采集动作:必须是 async 函数(同步抛错会绕过 inflight 登记);
     *  refresh 标记 = 触发本次构建的请求是否要求重建(仅诊断用) */
    private capture: (tabId: number, refresh: boolean) => Promise<V>,
    private maxEntries: number,
  ) {}

  async get(tabId: number, refresh?: boolean): Promise<V> {
    if (!refresh) {
      const hit = this.snapshots.get(tabId);
      if (hit) {
        hit.capturedAt = Date.now();
        return hit.doc;
      }
    }
    const building = this.inflight.get(tabId);
    if (building) {
      if (!refresh || building.refresh) return building.promise;
      // refresh 撞上普通构建:等它收口后走自己的重建路径
      await building.promise.catch(() => {});
    }
    return this.build(tabId, refresh === true);
  }

  invalidate(tabId: number): void {
    this.snapshots.delete(tabId);
  }

  private build(tabId: number, refresh: boolean): Promise<V> {
    // 先登记再启动:采集同步失败时 finally 也能正确清掉自己的条目
    const entry = { promise: null as unknown as Promise<V>, refresh };
    this.inflight.set(tabId, entry);
    entry.promise = (async () => {
      try {
        const doc = await this.capture(tabId, refresh);
        this.snapshots.set(tabId, { doc, capturedAt: Date.now() });
        lruEvict(this.snapshots, this.maxEntries, (e) => e.capturedAt);
        return doc;
      } finally {
        if (this.inflight.get(tabId) === entry) this.inflight.delete(tabId);
      }
    })();
    return entry.promise;
  }
}
