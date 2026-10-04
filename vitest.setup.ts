// 单测全局环境:内存版 chrome.storage 桩。
// 被测模块大多不直接依赖 chrome,但三条路径会碰到:
//  - logger 在 emit 时写 chrome.storage.local(compaction 的 info 日志)
//  - loadConfig 读 chrome.storage.session / local
//  - SW 模块(tools.ts → docBridge)在模块求值期注册 chrome 事件监听
//    (启动时序,有意为之)—— 测试文件的静态 import 早于 beforeEach,
//    求值期桩垫在下方;import 链需要的 API 面以报错为准逐个补齐
// 每个用例前换新实例,用例间互不污染。

import { beforeEach } from "vitest";

// 求值期最小桩:只接住「模块顶层 addListener」的注册动作,无行为;
// 不含 storage —— 依赖 storage 的调用都发生在 beforeEach 之后
(globalThis as Record<string, unknown>).chrome ??= {
  runtime: {
    lastError: null,
    onMessage: { addListener: () => {} },
    sendMessage: () => {},
  },
  tabs: {
    onUpdated: { addListener: () => {} },
    onRemoved: { addListener: () => {} },
    onReplaced: { addListener: () => {} },
  },
};

function makeStorageArea(
  area: string,
  listeners: Set<
    (
      changes: Record<string, { oldValue?: unknown; newValue: unknown }>,
      areaName: string,
    ) => void
  >,
) {
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
      const changes: Record<string, { oldValue?: unknown; newValue: unknown }> =
        {};
      for (const [k, v] of Object.entries(obj)) {
        changes[k] = {
          oldValue: data.has(k) ? structuredClone(data.get(k)) : undefined,
          newValue: structuredClone(v),
        };
        data.set(k, structuredClone(v));
      }
      // 同步派发(生产是异步事件,测试内 act 同步 flush 更稳);
      // useChatModels / useConfirmLevel 的订阅路径靠它覆盖
      for (const l of listeners) l(changes, area);
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
    storage: (() => {
      // onChanged 在 Chrome 的 storage 命名空间层(跨 area),不在 area 内;
      // local/session 共享同一组监听器,set 时以 area 名派发
      const storageListeners = new Set<
        (
          changes: Record<
            string,
            { oldValue?: unknown; newValue?: unknown }
          >,
          areaName: string,
        ) => void
      >();
      return {
        local: makeStorageArea("local", storageListeners),
        session: makeStorageArea("session", storageListeners),
        onChanged: {
          addListener: (l: (typeof storageListeners) extends Set<infer T> ? T : never) =>
            storageListeners.add(l),
          removeListener: (l: (typeof storageListeners) extends Set<infer T> ? T : never) =>
            storageListeners.delete(l),
        },
      };
    })(),
    runtime: {
      lastError: null,
      // docBridge 的 capture_doc 中继 / tabs 生命周期监听(SW 启动时序)
      onMessage: { addListener: () => {} },
      sendMessage: () => {},
    },
    tabs: {
      onUpdated: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
      onReplaced: { addListener: () => {} },
    },
    // hostAccess 的权限查询桩:默认视为已授权(生产 manifest 走
    // optional_host_permissions,contains 由运行时授予态决定;单测里
    // 需要验证「未授权」路径的用例自行覆写此桩)
    permissions: {
      contains: () => Promise.resolve(true),
      request: () => Promise.resolve(true),
      remove: () => Promise.resolve(),
    },
  };
});
