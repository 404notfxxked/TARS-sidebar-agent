// turndown-plugin-gfm 无官方类型(@types/turndown-plugin-gfm 不存在于 npm)
// 手写最小声明:导出的是 TurndownService.Plugin 类型的 plugin 函数。
declare module "turndown-plugin-gfm" {
  import type TurndownService from "turndown";

  export const gfm: TurndownService.Plugin;
  export const highlightedCodeBlock: TurndownService.Plugin;
  export const strikethrough: TurndownService.Plugin;
  export const tables: TurndownService.Plugin;
  export const taskListItems: TurndownService.Plugin;
}
