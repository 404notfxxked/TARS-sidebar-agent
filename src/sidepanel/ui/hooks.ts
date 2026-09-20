// 面板 UI 小 hooks:两段确认的自动复位与删除包装、行入场 stagger、复制成功
// 的轻反馈、语言订阅。都是从设置/历史/记忆/技能/MCP 页反复出现的同款逻辑
// 收拢而来。

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { LocalePref } from "../../shared/configStore";
import { createT, getLocale, subscribeLocale } from "../../shared/i18n";

/** 订阅面板语言:t() 是普通函数,组件须调用本 hook 才会在切换语言时重渲染。
 *  React Compiler 下所有组件都被自动记忆化,渲染 t() 文案的组件必须各自调用
 *  useT() 拿绑定语言的 t —— 编译器把 t 的函数身份当依赖,语言切换即重算文案;
 *  模块级 t() 与「父级重渲染」都穿不透自动记忆化 */
export function useLocale(): LocalePref {
  return useSyncExternalStore(subscribeLocale, getLocale);
}

/** 绑定当前语言的 t:按 locale 记忆化 createT 产物,身份稳定、切换语言才换。
 *  渲染 t() 文案的组件一律用它代替模块级 t(理由见 useLocale 注) */
export function useT() {
  const locale = useLocale();
  return useMemo(() => createT(locale), [locale]);
}

/** 两段确认状态:arm(v) 进入待确认态,ms 内未跟进自动复位(危险动作不单击直发)。
 *  返回 [待确认值, 进入待确认, 手动复位];值的形态由调用方定 —— 行 id(删除
 *  某一行)或 true(清空类单目标动作)。第二次点击 = 先查值再 reset 后执行 */
export function useConfirmReset<T extends string | boolean>(ms = 3000) {
  const [value, setValue] = useState<T | null>(null);
  const timer = useRef<number | null>(null);
  // 稳定引用:arm/reset 的依赖数组靠它保持恒定,不随渲染换身份
  const clear = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);
  const arm = useCallback((v: T) => {
    clear();
    setValue(v);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setValue(null);
    }, ms);
  }, [ms, clear]);
  const reset = useCallback(() => {
    clear();
    setValue(null);
  }, [clear]);
  // 卸载时清残留定时器
  useEffect(() => clear, [clear]);
  return [value, arm, reset] as const;
}

/** 复制文本到剪贴板 + 「已复制」轻反馈(ms 后自动熄灭);失败静默(剪贴板被拒等)。
 *  返回 [是否刚复制成功, copy(text)] */
export function useCopyFlash(ms = 1600) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  const copy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), ms);
      } catch {
        /* 剪贴板被拒等:静默 */
      }
    },
    [ms],
  );
  return [copied, copy] as const;
}

/** 行入场延迟:全局序号封顶 8,30ms/行(记忆页/历史页共用) */
export function useRowStagger<T extends { id: string }>(
  items: readonly T[] | null | undefined,
): Map<string, number> {
  return useMemo(() => {
    const m = new Map<string, number>();
    items?.forEach((it, i) => {
      m.set(it.id, Math.min(i, 8) * 30);
    });
    return m;
  }, [items]);
}

/** 两段确认删除:首调进入待确认(3s 自动复位),再调执行 run(id) */
export function useConfirmDelete<T extends string>(
  run: (id: T) => void | Promise<void>,
) {
  const [confirmingId, arm, reset] = useConfirmReset<T>();
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  }); // 渲染后同步最新闭包,不在渲染期写 ref;remove 身份不随 run 漂移
  const remove = useCallback(
    (id: T) => {
      if (confirmingId !== id) {
        arm(id);
        return;
      }
      reset();
      void runRef.current(id);
    },
    [confirmingId, arm, reset],
  );
  return { confirmingId, remove, reset };
}
