// 页面交互工具入口(barrel):观察(DOM 语义提取)+ 动作(合成事件)+ 滚动。
// 自包含纯 DOM 函数,无 message / chrome 依赖,供 content script 的 runTool 分发调用。
// 分区:语义提取与查找在 observe.ts,合成事件在 act.ts,滚动在 scroll.ts。
// ⚠️ 本文件是 tests/verify-interact.mjs 的 esbuild entry(打成 IIFE 挂
// window.__interact),也是 content/index.ts 与 content/screenshot.ts 的
// 引入点 —— 公开面保持稳定,新符号从对应模块 re-export。
// 设计要点:
//   - selector 契约:buildSelector 生成绝对 CSS 路径,动作工具 querySelector 解析,无会话态。
//   - 合成事件保真:完整 pointer/mouse 序列 + native setter + keyCode 补全,React 等框架才认。

export {
  type RoleName,
  normalizeRole,
  findInteractive,
  type FindOptions,
  type FindResult,
  buildSelector,
} from "./observe";
export {
  clickElement,
  fillElement,
  dispatchEnter,
} from "./act";
export {
  type ScrollDirection,
  type ScrollOptions,
  type PageGeometry,
  pageGeometry,
  scrollPage,
} from "./scroll";
