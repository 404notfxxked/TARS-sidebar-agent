// 单测全局环境:内存版 chrome.storage 桩。
// 被测模块大多不直接依赖 chrome,但两条路径会碰到:
//  - logger 在 emit 时写 chrome.storage.local(compaction 的 info 日志)
//  - loadConfig 读 chrome.storage.session / local
// 每个用例前换新实例,用例间互不污染。

import { beforeEach } from "vitest";

function makeStorageArea() {
  const data = new Map<string, unknown>();
  const dump = (keys: unknown) => {
    const out: Record<string, unknown> = {};
    const take = (k: string) => {
      if (data.has(k)) out[k] = structuredClone(data.get(k));
    };
    if (keys === null || keys === undefined) {
      for (const k of data.keys()) take(k);
    } else if (Array.isArray(keys)) {
      for (const k of keys) if (typeof k === "string") take(k);
    } else if (typeof keys === "string") {
      take(keys);
    }
    return out;
  };
  return {
    get: (keys: unknown = null) => Promise.resolve(dump(keys)),
    set: (obj: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(obj)) data.set(k, structuredClone(v));
      return Promise.resolve();
    },
    remove: (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
      return Promise.resolve();
    },
    clear: () => {
      data.clear();
      return Promise.resolve();
    },
  };
}

beforeEach(() => {
  (globalThis as Record<string, unknown>).chrome = {
    storage: { local: makeStorageArea(), session: makeStorageArea() },
    runtime: { lastError: null },
  };
});
