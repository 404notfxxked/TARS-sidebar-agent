// 全量配置存储(shared —— side panel 与 service worker 共用):
// - 模型服务支持多个供应商(providers 数组),每个含自己的 Base URL / API Key /
//   模型列表;当前选择 = modelProvider(供应商 id)+ model(wire 模型名)两个字段
// - key 一律存 chrome.storage.local(个人浏览器场景,多供应商下不再区分
//   「记住/仅本次会话」);读取时 providers 键缺席会从旧版单供应商字段合成,
//   合成只发生在内存,不写回 —— 与当年 model→models 的迁移同款策略:
//   providers 键一旦写入,旧键整体废弃
// - 搜索服务(search)/联网开关/主题等照旧

import { normalizeMcp, type McpConfig } from "./mcp";

export type ThemePref = "system" | "light" | "dark";

/** 面板 UI 语言(字典见 shared/locales);缺省 zh-CN,存量用户行为不变 */
export type LocalePref = "zh-CN" | "en-US";

/** 重点色(配色方案):generate-m3.mjs 里 ACCENTS 的 id,green = 默认源色 */
export type AccentPref =
  | "green"
  | "ocean"
  | "teal"
  | "indigo"
  | "lilac"
  | "coral"
  | "rose"
  | "graphite";
const ACCENT_IDS: AccentPref[] = [
  "green",
  "ocean",
  "teal",
  "indigo",
  "lilac",
  "coral",
  "rose",
  "graphite",
];

/** 模型条目(供应商内的 models 数组元素) */
export interface ModelEntry {
  /** wire 模型名,供应商内唯一键 */
  id: string;
  /** 显示别名(选填):聊天区选择器优先显示它,模型 ID 太长时用 */
  alias?: string;
  /** 多模态标记:聊天区图片入口(选择/粘贴)与请求侧图片投影都以此为准 */
  vision?: boolean;
  /** 上下文窗口 tokens:溢出裁剪与自动压缩的分母;0/缺省 = 两者都不生效 */
  contextTokens?: number;
  /** 单次回复上限:设置后才作为请求发送(字段见 maxTokensField) */
  maxTokens?: number;
  /** maxTokens 的请求字段名;缺省按模型名推断(见 inferMaxTokensField),仅 OpenAI
   *  推理模型等不认 max_tokens 的端点需要手动改 */
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  // 未来规划:推理模型标记。各家请求参数碎片化(reasoning_effort / enable_thinking /
  // thinking.type / chat_template_kwargs),没有可移植语义,暂不引入
}

/** 模型服务供应商:一份 OpenAI 兼容端点配置 + 它自己的模型列表 */
export interface ProviderEntry {
  /** 稳定引用(随机生成),modelProvider 与设置页展开态都用它 */
  id: string;
  /** 显示名(如 DeepSeek);留空时 UI 用 baseUrl 主机名兜底展示 */
  name: string;
  /** OpenAI 兼容根地址,约定含 /v1 */
  baseUrl: string;
  apiKey: string;
  models: ModelEntry[];
}

/** 按模型名推断 maxTokens 请求字段:OpenAI o 系列 / gpt-5 只认 max_completion_tokens。
 *  兼容 OpenRouter 风格带厂商前缀的 id("openai/o3-mini:free");其余返回 undefined(用 max_tokens) */
export function inferMaxTokensField(
  id: string,
): "max_completion_tokens" | undefined {
  return /(^|\/)(o[134](?:-|\b)|gpt-5)/.test(id)
    ? "max_completion_tokens"
    : undefined;
}

/** 当前选中模型条目的 contextTokens(未命中/未配置 → undefined)。
 *  面板展示记忆注入估算用,与 agent/压缩共用同一窗口口径 */
export function selectedContextTokens(cfg: AppConfig): number | undefined {
  return cfg.providers.find((p) => p.id === cfg.modelProvider)?.models.find(
    (m) => m.id === cfg.model,
  )?.contextTokens;
}

export interface AppConfig {
  /** 模型服务供应商列表;空 = 尚未配置,对话前需先添加 */
  providers: ProviderEntry[];
  /** 当前供应商 = providers 中某项的 id */
  modelProvider: string;
  /** 当前 wire 模型名(属于 modelProvider);聊天区选择器切换即写回这两个字段 */
  model: string;
  theme: ThemePref;
  /** 重点色:决定整套 M3 scheme 的源色(表面底色不随它变,只换强调/主色系) */
  accent: AccentPref;
  /** 面板 UI 语言:只影响面板渲染,SW/模型可见文案不随它变(始终英文) */
  locale: LocalePref;
  /** 联网开关:控制 web_search / web_fetch 工具是否对模型可用;缺省 = 关
   *  (搜索已改为 BYOK 服务,开启还需配好 search.services[...].apiKey 才真正可用) */
  webSearch: boolean;
  /** 长期记忆总开关:开 = 注册 memory_* 工具 + 每轮注入 <user-memory>;
   *  缺省 = 开。关 = 不注册工具不注入,彻底无痕 */
  memory: boolean;
  /** 技能总开关:关 = / 调用不生效(菜单与技能页管理不受影响);
   *  缺省 = 开。技能是用户手动安装的本地指令文本,无网络无外传,空库零成本 */
  skills: boolean;
  /** 写操作确认门:开 = click_element / fill_input 执行前弹面板确认卡,
   *  超时未答复按拒绝处理;缺省 = 开(安全默认, 宁可多点一次) */
  confirmActions: boolean;
  /** 任务完成通知:开 = run 结束且面板不可见时发系统通知;缺省 = 开 */
  notifyDone: boolean;
  /** 搜索服务配置;开关开着但当前服务 apiKey 为空时 web_search 退回免 Key 抓取 */
  search: SearchConfig;
  /** 历史会话保留天数:0 = 全部保留;缺省 7(sessionHistory.pruneExpiredSessions) */
  historyRetention: number;
  /** 上下文压缩触发档位:对话历史占用可用窗口超过该比例时,自动把较早的
   *  整轮压成摘要(见 background/compaction);需当前模型配了 contextTokens
   *  才生效;缺省 standard */
  compact: CompactLevel;
  /** 压缩用模型:摘要调用的供应商 id + wire 模型名,引用语义与
   *  modelProvider/model 相同;两者任一为空 = 跟随当前模型 */
  compactProvider: string;
  compactModel: string;
  /** MCP 服务器接入(见 shared/mcp.ts):总开关缺省关 —— 调用 MCP 工具会把
   *  请求内容发给第三方服务器,与 BYOK「数据不出本机」承诺相抵,须显式启用 */
  mcp: McpConfig;
}

export type SearchProviderId = "tavily" | "bocha" | "brave";
export const SEARCH_PROVIDER_IDS = ["auto", "tavily", "bocha", "brave"] as const;
export type SearchProviderOrder = (typeof SEARCH_PROVIDER_IDS)[number];

/** 设置里的搜索服务选项:auto = 不用服务商,抓取搜索引擎结果页兜底 */
export type SearchProviderSetting = "auto" | SearchProviderId;

/** 单家搜索服务的连接信息;key/中转地址按家各存一格,切换服务商互不串 */
export interface SearchServiceEntry {
  baseUrl: string;
  apiKey: string;
}

/** 搜索服务配置:provider=auto 时 services 无效;单家 baseUrl 留空用官方端点。
 *  免 Key(provider=auto 或该家未配 key)一律走真实标签页通道,无开关 */
export interface SearchConfig {
  provider: SearchProviderSetting;
  services: Record<SearchProviderId, SearchServiceEntry>;
}

/** 各选项展示名(设置页下拉用;文案在 i18n 字典,这里只定键序) */


/** 上下文压缩触发档位:占可用窗口(contextTokens − maxTokens − 余量)的比例 */
export type CompactLevel = "early" | "standard" | "late";
export const COMPACT_LEVELS: CompactLevel[] = ["early", "standard", "late"];

/** 各档位展示名(设置页 segmented 用),数值与 compaction.THRESHOLDS 对应 */
export const COMPACT_LABELS: Record<CompactLevel, string> = {
  early: "提前 60%",
  standard: "标准 75%",
  late: "用满 90%",
};

export async function loadConfig(): Promise<AppConfig> {
  const s = await chrome.storage.session.get("apiKey");
  const l = await chrome.storage.local.get([
    "providers",
    "modelProvider",
    "model",
    "models",
    "maxContextTokens",
    "baseUrl",
    "apiKey",
    "theme",
    "accent",
    "locale",
    "webSearch",
    "memory",
    "skills",
    "confirmActions",
    "notifyDone",
    "search",
    "historyRetention",
    "compact",
    "compactProvider",
    "compactModel",
    "mcp",
  ]);

  const providers = normalizeProviders(l.providers, {
    baseUrl: l.baseUrl,
    apiKey: (s.apiKey as string) || l.apiKey,
    model: l.model,
    models: l.models,
    maxContextTokens: l.maxContextTokens,
  });
  const modelProvider =
    typeof l.modelProvider === "string" &&
    providers.some((p) => p.id === l.modelProvider)
      ? l.modelProvider
      : (providers[0]?.id ?? "");

  return {
    providers,
    modelProvider,
    model: typeof l.model === "string" ? l.model : "",
    theme: l.theme ?? "system",
    accent: ACCENT_IDS.includes(l.accent as AccentPref)
      ? (l.accent as AccentPref)
      : "green",
    locale: l.locale === "en-US" ? "en-US" : "zh-CN",
    // 联网搜索 BYOK 化后缺省关闭:开关显式打开 + 配好 key 才对模型可用
    webSearch: l.webSearch === true,
    // 长期记忆缺省开启(记忆为空时除工具 schema 外无成本;关 = 彻底无痕)
    memory: l.memory !== false,
    // 技能缺省开启(纯本地文本,空库零成本;关 = / 调用不生效)
    skills: l.skills !== false,
    // 写操作确认缺省开启:浏览器 agent 的写动作(点按/填写)默认逐次过目
    confirmActions: l.confirmActions !== false,
    // 任务完成通知缺省开启(仅面板不可见时才发,不打扰正在看面板的用户)
    notifyDone: l.notifyDone !== false,
    search: normalizeSearch(l.search),
    // 历史保留天数:与 sessionHistory.retentionDays 的缺省保持一致(7 天)
    historyRetention:
      typeof l.historyRetention === "number" && l.historyRetention >= 0
        ? l.historyRetention
        : 7,
    compact: COMPACT_LEVELS.includes(l.compact as CompactLevel)
      ? (l.compact as CompactLevel)
      : "standard",
    compactProvider:
      typeof l.compactProvider === "string" ? l.compactProvider : "",
    compactModel: typeof l.compactModel === "string" ? l.compactModel : "",
    mcp: normalizeMcp(l.mcp),
  };
}

/** providers 键在 → 新 schema 原样取;缺席 → 从旧版单供应商字段合成一个条目
 *  (只读合成不写回;设置页任何一次保存都会写入 providers 键,旧键随即废弃) */
function normalizeProviders(
  raw: unknown,
  legacy: {
    baseUrl: unknown;
    apiKey: unknown;
    model: unknown;
    models: unknown;
    maxContextTokens: unknown;
  },
): ProviderEntry[] {
  if (Array.isArray(raw)) {
    return (raw as ProviderEntry[]).filter(
      (p) =>
        p &&
        typeof p.id === "string" &&
        typeof p.apiKey === "string" &&
        typeof p.baseUrl === "string" &&
        Array.isArray(p.models),
    );
  }
  const legacyModels: ModelEntry[] = Array.isArray(legacy.models)
    ? (legacy.models as ModelEntry[])
        .filter((m) => m && typeof m.id === "string")
        .map((m) => ({
          ...m,
          contextTokens: m.contextTokens ?? undefined,
        }))
    : typeof legacy.model === "string" && legacy.model
      ? [
          {
            id: legacy.model,
            contextTokens:
              typeof legacy.maxContextTokens === "number"
                ? legacy.maxContextTokens
                : undefined,
          },
        ]
      : [];
  const baseUrl = typeof legacy.baseUrl === "string" ? legacy.baseUrl : "";
  const apiKey = typeof legacy.apiKey === "string" ? legacy.apiKey : "";
  if (!baseUrl && !apiKey && legacyModels.length === 0) return [];
  let host = "默认服务";
  try {
    host = new URL(baseUrl).hostname || host;
  } catch {
    /* baseUrl 不合法就保持占位名 */
  }
  return [
    { id: "p0", name: host, baseUrl, apiKey, models: legacyModels },
  ];
}

/** 搜索配置宽松归一:非法 provider 回落 auto(免 Key 兜底),字段类型不对的丢弃。
 *  旧版单槽结构({provider,baseUrl,apiKey} 三家共用一格,切换服务商会串 key)
 *  只保留 provider 选择;旧 key/中转地址无法判断属于哪家,不猜测归属、直接弃用
 *  (避免把 A 家的 key 发给 B 家),一次性到设置页重填 */
export function normalizeSearch(v: unknown): SearchConfig {
  const s = (v ?? {}) as Partial<SearchConfig> & {
    baseUrl?: unknown;
    apiKey?: unknown;
  };
  const provider: SearchProviderSetting =
    s.provider === "tavily" || s.provider === "bocha" || s.provider === "brave"
      ? s.provider
      : "auto";
  const services = {} as Record<SearchProviderId, SearchServiceEntry>;
  for (const id of SEARCH_PROVIDER_IDS.slice(1) as SearchProviderId[]) {
    const e = s.services?.[id];
    services[id] = {
      baseUrl: typeof e?.baseUrl === "string" ? e.baseUrl : "",
      apiKey: typeof e?.apiKey === "string" ? e.apiKey : "",
    };
  }
  return { provider, services };
}

/** 偏好局部保存(storage key 与字段同名,直接落盘)。
 *  各控件按字段调用,providers 整包写入(内含各供应商的 key) */
export async function savePrefs(
  prefs: Partial<
    Pick<
      AppConfig,
      | "providers"
      | "modelProvider"
      | "model"
      | "theme"
      | "accent"
      | "locale"
      | "webSearch"
      | "memory"
      | "skills"
      | "confirmActions"
      | "notifyDone"
      | "search"
      | "historyRetention"
      | "compact"
      | "compactProvider"
      | "compactModel"
      | "mcp"
    >
  >,
): Promise<void> {
  await chrome.storage.local.set(prefs);
}
