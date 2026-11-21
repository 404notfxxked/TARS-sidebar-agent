// diagram_validate:mermaid 源码 parse-only 校验(offscreen 一次性解析任务,
// 供 background 的图表自检回路调用)。刻意只 parse 不渲染:校验只要语法
// 判定,渲染(主题/尺寸/安全策略)是面板 MermaidFigure 的事。initialize
// 模块级只跑一次(offscreen 常驻,无主题切换);mermaid 12 的 suppressErrors
// 下坏源码返回 false 而非抛错(含未知图型,如 flowchat),两种失败形态都
// 归一成 {ok:false, error},error 截 300 —— 它会进修复 note 喂给模型。

import { errText } from "../shared/errors";

type MermaidApi = (typeof import("mermaid"))["default"];

let mermaidReady: Promise<MermaidApi> | null = null;

function ensureMermaid(): Promise<MermaidApi> {
  mermaidReady ??= (async () => {
    const mermaid = (await import("mermaid")).default;
    mermaid.initialize({ startOnLoad: false });
    return mermaid;
  })();
  return mermaidReady;
}

export type DiagramValidateResult =
  | { ok: true }
  | { ok: false; error: string };

/** 校验一段 mermaid 源码;入参不合法直接拒绝,不触发懒加载 */
export async function validateDiagramSource(
  source: unknown,
): Promise<DiagramValidateResult> {
  if (typeof source !== "string" || !source.trim()) {
    return { ok: false, error: "diagram_validate: missing or empty source" };
  }
  try {
    const mermaid = await ensureMermaid();
    const parsed = await mermaid.parse(source, { suppressErrors: true });
    if (parsed !== false) return { ok: true };
    return {
      ok: false,
      error:
        "mermaid.parse returned false (syntax error or unknown diagram type)",
    };
  } catch (e) {
    return { ok: false, error: errText(e).slice(0, 300) };
  }
}
