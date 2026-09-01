// 主题:三态偏好(system/light/dark)→ <html data-theme>。
// 颜色本体在 styles/tokens.css 里随 data-theme 翻转,color-scheme 也由 CSS 声明,
// 这里只负责把偏好落到 DOM 属性上

import type { AccentPref, ThemePref } from "../shared/configStore";

const mq = window.matchMedia("(prefers-color-scheme: dark)");

/** 当前生效偏好:system 态下由媒体查询变化驱动重算 */
let pref: ThemePref = "system";

export function resolveTheme(p: ThemePref = pref): "light" | "dark" {
  return p === "system" ? (mq.matches ? "dark" : "light") : p;
}

/** 应用偏好(只改内存态 + DOM,不写 storage —— 落盘由设置页的自动保存负责) */
export function applyThemePreference(p: ThemePref): void {
  pref = p;
  document.documentElement.dataset.theme = resolveTheme();
}

/** 应用主题色:默认源色不带属性,其余挂 data-accent(m3.css 里各有一套浅色 scheme) */
export function applyAccent(a: AccentPref): void {
  if (a === "green") delete document.documentElement.dataset.accent;
  else document.documentElement.dataset.accent = a;
}

/** system 偏好下跟随系统实时切换;面板生命周期内调用一次即可 */
export function watchSystemTheme(): void {
  mq.addEventListener("change", () => {
    if (pref === "system") applyThemePreference("system");
  });
}
