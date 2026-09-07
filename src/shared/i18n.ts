// 轻量 i18n:类型安全的字典 + t() 查找。刻意不引依赖 ——
// 键即字典结构(t("settings.title")),插值用 {name} 占位。
// 只收拢「给用户看」的文案;给模型看的(工具 description、后台错误串)
// 与日志文案不进字典,它们不是 UI。

import { zhCN } from "./locales/zh-CN";

export type Dict = typeof zhCN;

/** 字典路径查值,如 t("settings.title") / t("sessions.count", { n: 3 }) */
export function t(path: string, vars?: Record<string, string | number>): string {
  let cur: unknown = zhCN;
  for (const key of path.split(".")) {
    if (cur == null || typeof cur !== "object") {
      console.warn(`[i18n] 缺少文案键: ${path}`);
      return path;
    }
    cur = (cur as Record<string, unknown>)[key];
  }
  if (typeof cur !== "string") {
    console.warn(`[i18n] 缺少文案键: ${path}`);
    return path;
  }
  if (!vars) return cur;
  return cur.replace(/\{(\w+)\}/g, (_, name) =>
    vars[name] != null ? String(vars[name]) : `{${name}}`,
  );
}
