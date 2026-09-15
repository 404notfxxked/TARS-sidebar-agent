// 轻量 i18n:类型安全的字典 + t() 查找。刻意不引依赖 ——
// 键即字典结构(t("settings.title")),插值用 {name} 占位。
// 只收拢「给用户看」的文案;给模型看的(工具 description、后台错误串)
// 与日志文案不进字典,它们不是 UI。
// 语言只有面板在用:current 是面板运行态,启动时 main.tsx 从配置读入,
// 设置页切换;SW 侧文案(模型可见)始终英文,不走这里。

import type { LocalePref } from "../configStore";
import { zhCN } from "./locales/zh-CN";
import { enUS } from "./locales/en-US";

/** 把字面量字典放宽成 string 树:各语言字典按它做键位结构校验(缺键 = 编译错) */
type Widen<T> = { [K in keyof T]: T[K] extends string ? string : Widen<T[K]> };
export type Dict = Widen<typeof zhCN>;

const DICTS: Record<LocalePref, Dict> = { "zh-CN": zhCN, "en-US": enUS };

let current: LocalePref = "zh-CN";
const listeners = new Set<() => void>();

export function getLocale(): LocalePref {
  return current;
}

/** 切换面板语言并广播订阅者;落盘由设置页 savePrefs 负责,这里只改内存态 */
export function setLocale(l: LocalePref): void {
  if (l === current) return;
  current = l;
  for (const fn of listeners) fn();
}

export function subscribeLocale(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 沿字典路径取字符串;缺失返回 undefined,由调用方决定回落 */
function resolve(dict: unknown, path: string): string | undefined {
  let node: unknown = dict;
  for (const key of path.split(".")) {
    if (node == null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return typeof node === "string" ? node : undefined;
}

/** 字典路径查值,如 t("settings.title") / t("sessions.msgCount", { n: 3 })。
 *  当前语言缺键回落中文,新增键漏译时也不会把裸键名亮给用户 */
export function t(path: string, vars?: Record<string, string | number>): string {
  return createT(current)(path, vars);
}

/** 绑定语言的 t 工厂:useT()(ui/hooks)按当前 locale 记忆化产出,React
 *  Compiler 把返回的函数身份当依赖 —— 语言切换时组件里的 t("…") 调用随之
 *  重算。模块级 t() 读的是可变模块状态,编译器视为零依赖缓存,静态键位
 *  收集(check-i18n)仍以 t("…") 调用形态为准,两者共存 */
export function createT(locale: LocalePref) {
  const dict = DICTS[locale];
  return (path: string, vars?: Record<string, string | number>): string => {
    const raw = resolve(dict, path) ?? resolve(zhCN, path);
    if (raw === undefined) {
      console.warn(`[i18n] 缺少文案键: ${path}`);
      return path;
    }
    if (!vars) return raw;
    return raw.replace(/\{(\w+)\}/g, (_, name) =>
      vars[name] != null ? String(vars[name]) : `{${name}}`,
    );
  };
}

/** 绑定语言的 t 函数类型:render 期辅助函数(toolLabel/truncate 等)以此
 *  收参,由调用方传 useT() 产物进来 */
export type TFn = ReturnType<typeof createT>;
