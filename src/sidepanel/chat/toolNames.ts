import type { TFn } from "../../shared/i18n";
// 内置工具的面板侧显示名。工具的 UI 名不进 SW(SW 文案面向模型,始终英文),
// 面板按工具名查字典:内置工具随界面语言刷新;MCP 等外部工具没有内置映射,
// 回退事件自带的 displayName(「服务器 · 工具名」,外部给的,不译)。
// 键位表必须写字面量:check-i18n 只收集键形字面量,模板拼键直接 FAIL。
// t 由调用方传入(useT 产物):本函数在 render 期被调用,自读模块态会被
// React Compiler 按参数记忆化,语言切换后返回旧文案。

const TOOL_KEYS: Record<string, string> = {
  get_tabs: "chat.tool.getTabs",
  page_read: "chat.tool.pageRead",
  page_find: "chat.tool.pageFind",
  page_outline: "chat.tool.pageOutline",
  web_search: "chat.tool.webSearch",
  web_fetch: "chat.tool.webFetch",
  find_elements: "chat.tool.findElements",
  scroll_page: "chat.tool.scrollPage",
  page_screenshot: "chat.tool.pageScreenshot",
  click_element: "chat.tool.clickElement",
  fill_input: "chat.tool.fillInput",
  memory_save: "chat.tool.memorySave",
  memory_delete: "chat.tool.memoryDelete",
};

/** 工具显示名:内置工具走字典,外部工具回退 displayName,最后退原名 */
export function toolLabel(
  t: TFn,
  name: string,
  fallback?: string,
): string {
  const key = TOOL_KEYS[name];
  return key ? t(key) : (fallback ?? name);
}
