// 面板 UI 小 hooks:两段确认的自动复位、复制成功的轻反馈、语言订阅。
// 都是从设置/历史/记忆页反复出现的同款逻辑收拢而来。

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { LocalePref } from "../../shared/configStore";
import { getLocale, subscribeLocale } from "../../shared/i18n";

/** 订阅面板语言:t() 是普通函数,组件须调用本 hook 才会在切换语言时重渲染。
 *  memo 组件里渲染文案的也必须各自调用 —— 父级重渲染穿不透 memo */
export function useLocale(): LocalePref {
  return useSyncExternalStore(subscribeLocale, getLocale);
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
