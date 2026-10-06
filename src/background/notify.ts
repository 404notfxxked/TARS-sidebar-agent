// run 结束通知的决策层:是否打扰用户的单一判定(纯函数,可单测)。
// IO 侧(chrome.notifications / windows 查询)留在 index.ts,本模块只管
// 「该不该发」—— 面板可见性/焦点判据依赖宿主窗口环境,e2e 无法稳定构造
// (xvfb 无窗口管理器,显式聚焦也报 focused=false),故以单测钉住语义,
// e2e 用自洽断言覆盖(tests/verify-notify.mjs:先读实测判据再定期望)。

import { oneLine } from "../shared/text";

/** 任务名:用户首行消息截断,通知正文用。
 *  截断走 oneLine:首行取出后压平 + 代理对安全截断(emoji 不劈半字) */
export function taskLabel(text: string): string {
  return oneLine(text.trim().split("\n")[0] ?? "", 48);
}

/**
 * 是否发 run 结束通知。判据(与产品口径一致):
 * - 用户取消的 run 不打扰
 * - 总开关关闭不打扰
 * - 面板自报可见 且 浏览器窗口持焦 → 用户正看着,不打扰;
 *   面板不可见 或 窗口失焦(看别的窗口去了)→ 收到通知才有意义
 */
export function shouldNotifyRunEnd(opts: {
  aborted: boolean;
  notifyDone: boolean;
  /** 归属面板自报的可见性(port 已断开时按隐藏处理) */
  hidden: boolean;
  /** 浏览器窗口是否持焦(调用方经 chrome.windows.getLastFocused 解析) */
  focused: boolean;
}): boolean {
  if (opts.aborted) return false;
  if (!opts.notifyDone) return false;
  if (!opts.hidden && opts.focused) return false;
  return true;
}
