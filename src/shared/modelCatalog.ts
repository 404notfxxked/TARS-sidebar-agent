// 模型能力目录:models.dev 社区目录的裁剪快照 + 三层能力判定。
// 层 0:public/model-catalog.json(models.dev,MIT;pnpm catalog:refresh
//   刷新)——按需 fetch(runtime.getURL),不进 bundle;缺失/失败静默跳过,
//   目录层永远不算错误,后面几层兜底;
// 层 1:id 启发式——只报强模式肯定(deepseek-reasoner / o 系列 / *-thinking),
//   不确定返回 undefined 不猜;
// 层 2:ModelEntry 手动开关(与 vision 同款,用户纠正一切);
// 层 3:运行时观测回写(见 configStore.markReasoningObserved,agent 收到
//   reasoning_content 时置位)。
// 预填只发生在「获取列表新增条目」时,绝不覆盖已有/手动值。
// 教训先例:目录负面标记可能来自聚合站对旧 id 的陈旧数据(deepseek-reasoner
// 在官方条目缺席、聚合站标 0),所以启发式肯定 > 目录负面。

import type { ModelEntry } from "./configStore";

export interface CatalogEntry {
  /** 上下文窗口 tokens */
  ctx?: number;
  /** 是否推理模型(1/0) */
  r?: 0 | 1;
  /** 支持图像输入 */
  v?: 0 | 1;
  /** 思考档位(上游 reasoning_options 扁平化):"toggle" = 纯开关,
   *  其余为 effort 档位 token(low/medium/high/xhigh/max/minimal…) */
  ro?: string[];
}

export interface Catalog {
  models: Record<string, CatalogEntry>;
}

let cache: Promise<Catalog> | null = null;

export function loadCatalog(): Promise<Catalog> {
  cache ??= fetch(chrome.runtime.getURL("model-catalog.json"))
    .then((res) => (res.ok ? res.json() : { models: {} }))
    .catch(() => ({ models: {} }));
  return cache;
}

/** id 启发式:命中强模式返回 true,否则 undefined(未知 ≠ 否定) */
export function inferReasoning(id: string): true | undefined {
  return /(^|\/)(o[1345](-|$)|deepseek-reasoner)/.test(id) ||
    /-thinking($|[-_/@])/i.test(id)
    ? true
    : undefined;
}

/**
 * 思考档位选项(供聊天输入行选择器):null = 该模型没有可靠的档位数据,
 * 选择器整个不显示——不知道能发什么参数就不显示入口,零风险。
 * 有 effort 档位 → [关?][档位…];纯开关模型 → [关, 开](两个都能映射成
 * 真实 wire 参数,选择器里没有「不发送」这种隐式状态)。
 */
export function thinkingOptionsOf(cat: Catalog, id: string): string[] | null {
  const ro = cat.models[id]?.ro;
  if (!ro || ro.length === 0) return null;
  const levels: string[] = [];
  let hasOff = false;
  for (const v of ro) {
    // toggle 与 none 都意味着「能关」:前者是独立开关,后者是档位里的关档
    if (v === "toggle" || v === "none") hasOff = true;
    else if (!levels.includes(v)) levels.push(v);
  }
  if (levels.length > 0) {
    return hasOff ? ["off", ...levels] : levels;
  }
  return hasOff ? ["off", "on"] : null;
}

/**
 * 折中默认档(reasoningEffort 未设置时实际发送的值):有 effort 档位时去
 * 掉「关」取中间偏高一档——[low,high,max]→high、[minimal,low,medium,high]→
 * medium、[low,medium,high]→medium;两档取较低档([high,max]→high,默认
 * 宁慢于超支);纯开关模型 → "on"(显式开,与「关」对应);无数据 →
 * undefined(选择器不显示,该状态用户永远看不到)。
 */
export function defaultThinkingEffort(
  cat: Catalog,
  id: string,
): string | undefined {
  const options = thinkingOptionsOf(cat, id);
  if (!options) return undefined;
  const levels = options.filter((t) => t !== "off");
  if (levels.length === 0) return "on";
  const idx = levels.length <= 2 ? 0 : Math.ceil((levels.length - 1) / 2);
  return levels[idx];
}

/** 合成预填值:目录(ctx / v / r)→ 启发式(仅推理肯定)→ 其余留空交手动 */
export function prefillEntry(cat: Catalog, id: string): Partial<ModelEntry> {
  const e = cat.models[id];
  const out: Partial<ModelEntry> = {};
  if (e?.ctx) out.contextTokens = e.ctx;
  if (e?.v === 1) out.vision = true;
  const reasoning =
    inferReasoning(id) ?? (e?.r === 1 ? true : e?.r === 0 ? false : undefined);
  if (reasoning !== undefined) out.reasoning = reasoning;
  return out;
}

/** 已有条目的回填(重新「获取列表」时对既有模型执行):只补「从未设置」的
 *  缺失字段,绝不覆盖手动值——contextTokens 显式 0 = 用户主动清空(尊重),
 *  reasoning/vision 显式 false = 用户主动关闭(尊重);回填只写正面信息
 *  (窗口数值 / true 标记),目录负面标记对新条目有意义、对旧条目不回填 */
export function backfillEntry(
  cat: Catalog,
  id: string,
  entry: ModelEntry,
): ModelEntry {
  const e = cat.models[id];
  const out = { ...entry };
  if (out.contextTokens === undefined && e?.ctx) out.contextTokens = e.ctx;
  if (out.vision === undefined && e?.v === 1) out.vision = true;
  if (out.reasoning === undefined) {
    const r = inferReasoning(id) ?? (e?.r === 1 ? true : undefined);
    if (r) out.reasoning = true;
  }
  return out;
}
