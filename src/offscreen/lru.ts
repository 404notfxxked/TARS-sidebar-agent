/** LRU 淘汰(纯函数):份数超上限时反复删「时间戳最早」的条目直到塞得下。
 *  时间字段由调用方给出(快照缓存 capturedAt / fetch 缓存 at,各自语义不变);
 *  以 undefined 判「没找到」,真实缓存键(数字 tabId / 非空 URL)不会撞 */
export function lruEvict<K, V>(
  map: Map<K, V>,
  max: number,
  tsOf: (v: V) => number,
): void {
  while (map.size > max) {
    let oldestKey: K | undefined;
    let oldestAt = Infinity;
    for (const [k, v] of map) {
      if (tsOf(v) < oldestAt) {
        oldestAt = tsOf(v);
        oldestKey = k;
      }
    }
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}
