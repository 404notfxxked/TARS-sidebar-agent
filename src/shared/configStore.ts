// 全量配置存储(shared —— side panel 与 service worker 共用):
// - 模型服务支持多个供应商(providers 数组),每个含自己的 Base URL / API Key /
//   模型列表;当前选择 = modelProvider(供应商 id)+ model(wire 模型名)两个字段
// - key 一律存 chrome.storage.local(个人浏览器场景,多供应商下不再区分
//   「记住/仅本次会话」);读取时 providers 键缺席会从旧版单供应商字段合成,
//   合成只发生在内存,不写回 —— 与当年 model→models 的迁移同款策略:
//   providers 键一旦写入,旧键整体废弃
// - 搜索服务(search)/联网开关/主题等照旧

export type ThemePref = "system" | "light" | "dark";

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
  /** 上下文窗口 tokens:仅用作对话顶部用量条的分子/分母;0/缺省 = 不展示 */
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
  /** 联网开关:控制 web_search / web_fetch 工具是否对模型可用;缺省 = 关
   *  (搜索已改为 BYOK 服务,开启还需配好 search.apiKey 才真正可用) */
  webSearch: boolean;
  /** 搜索服务配置;开关开着但 apiKey 为空时 web_search 仍不可用 */
  search: SearchConfig;
  /** 历史会话保留天数:0 = 全部保留;缺省 7(sessionHistory.pruneExpiredSessions) */
  historyRetention: number;
}

export type SearchProviderId = "tavily" | "bocha" | "brave";

/** 设置里的搜索服务选项:auto = 不用服务商,抓取搜索引擎结果页兜底 */
export type SearchProviderSetting = "auto" | SearchProviderId;

/** 搜索服务配置:provider=auto 时 baseUrl/apiKey 无效;其余留空 baseUrl 用官方端点 */
export interface SearchConfig {
  provider: SearchProviderSetting;
  baseUrl: string;
  apiKey: string;
}

/** 各选项展示名(设置页下拉用) */
export const SEARCH_PROVIDER_LABELS: Record<SearchProviderSetting, string> = {
  auto: "自动（免 Key，抓取搜索页）",
  tavily: "Tavily",
  bocha: "博查 Bocha",
  brave: "Brave Search",
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
    "webSearch",
    "search",
    "historyRetention",
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
    // 联网搜索 BYOK 化后缺省关闭:开关显式打开 + 配好 key 才对模型可用
    webSearch: l.webSearch === true,
    search: normalizeSearch(l.search),
    // 历史保留天数:与 sessionHistory.retentionDays 的缺省保持一致(7 天)
    historyRetention:
      typeof l.historyRetention === "number" && l.historyRetention >= 0
        ? l.historyRetention
        : 7,
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

/** 搜索配置宽松归一:非法 provider 回落 auto(免 Key 兜底),字段类型不对的丢弃 */
function normalizeSearch(v: unknown): SearchConfig {
  const s = (v ?? {}) as Partial<SearchConfig>;
  const provider = s.provider;
  return {
    provider:
      provider === "tavily" || provider === "bocha" || provider === "brave"
        ? provider
        : "auto",
    baseUrl: typeof s.baseUrl === "string" ? s.baseUrl : "",
    apiKey: typeof s.apiKey === "string" ? s.apiKey : "",
  };
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
      | "webSearch"
      | "search"
      | "historyRetention"
    >
  >,
): Promise<void> {
  await chrome.storage.local.set(prefs);
}
