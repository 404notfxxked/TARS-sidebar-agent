// 全量配置存储(shared —— side panel 与 service worker 共用):
// - 模型服务支持多个供应商(providers 数组),每个含自己的 Base URL / API Key /
//   模型列表;当前选择 = modelProvider(供应商 id)+ model(wire 模型名)两个字段
// - key 一律存 chrome.storage.local(个人浏览器场景,多供应商下不再区分
//   「记住/仅本次会话」;loadConfig 仍读一次 storage.session 的 apiKey 作历史
//   兼容,现无任何写入方,可择机移除);读取时 providers 键缺席会从旧版单供应商字段合成,
//   合成只发生在内存,不写回 —— 与当年 model→models 的迁移同款策略:
//   providers 键一旦写入,旧键整体废弃
// - 搜索服务(search)/联网开关/主题等照旧

import { normalizeMcp, type McpConfig } from "./mcp";

export type ThemePref = "system" | "light" | "dark";

/** 面板 UI 语言(字典见 shared/i18n/locales);缺省 zh-CN,存量用户行为不变 */
export type LocalePref = "zh-CN" | "en-US";

/** 首开语言探测:存储值缺席时按浏览器语言落默认。
 *  zh 开头(含 zh-TW/zh-HK 等变体)→ zh-CN;探测不到保持 zh-CN(缺省兼容);
 *  其余语言回落 en-US。纯函数:测试直接喂 language 串,不依赖 navigator */
export function detectLocale(language?: string): LocalePref {
  if (language && !language.toLowerCase().startsWith("zh")) return "en-US";
  return "zh-CN";
}

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
  /** 推理(思考)模型标记:纯能力元数据,是聊天思考选择器的可见性依据。
   *  三层判定:预填(models.dev 目录 / id 启发式,见 shared/modelCatalog)
   *  + 运行时观测回写 + 手动纠正;没有手动开关,不认识的模型靠观测兜底 */
  reasoning?: boolean;
  /** 思考程度(undefined = 折中默认:发送时由 defaultThinkingEffort 取目录
   *  中间档,纯开关模型则跟随模型默认不发参数):"off" = 请求关思考,其余
   *  为目录档位 token,wire 映射见 chatCompletions.ts thinkingParam。仅 reasoning
   *  为 true 时由 agent 门控发送 */
  reasoningEffort?: string;
}

/** 供应商 API 协议(wire 格式,按协议而非厂商命名):chat-completions = OpenAI
 *  兼容(缺省,历史配置零迁移);anthropic-messages = Anthropic Messages;
 *  responses 仅预留枚举,适配器未实现(经 createChatProvider 显式报错) */
export type ProviderKind =
  | "chat-completions"
  | "anthropic-messages"
  | "responses";
export const PROVIDER_KINDS = [
  "chat-completions",
  "anthropic-messages",
  "responses",
] as const;

/** 模型服务供应商:一份端点配置 + 它自己的模型列表 */
export interface ProviderEntry {
  /** 稳定引用(随机生成),modelProvider 与设置页展开态都用它 */
  id: string;
  /** 显示名(如 DeepSeek);留空时 UI 用 baseUrl 主机名兜底展示 */
  name: string;
  /** 兼容端点根地址,约定含 /v1 */
  baseUrl: string;
  apiKey: string;
  /** API 协议:undefined 按缺省 chat-completions 消费(读时归一,不写回);
   *  anthropic-messages 走 x-api-key 认证 + /messages 端点 */
  kind?: ProviderKind;
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
  /** 面板 UI 语言:决定面板文案与 SW 系统通知(background/index.ts 按它取
   *  dict.notify);SW/模型可见的其它文案不经字典(中英混杂,属已知债务) */
  locale: LocalePref;
  /** 联网开关:控制 web_search / web_fetch 工具是否对模型可用;缺省 = 关。
   *  开启即用,无需任何配置——搜索默认走免 Key 的真实搜索引擎标签页通道
   *  (webSearch.readSearchRoute 的 auto 兜底);配了 search.services[].apiKey
   *  才改走该服务商的 API。**对 kind = anthropic-messages 的供应商**,联网开
   *  时搜索改由服务商在服务端执行(请求注入 web_search server tool,见
   *  provider/anthropicMessages.ts),不再走标签页通道 —— 该协议下服务端搜索
   *  需要端点支持,不支持会由端点报错(不再有独立开关,联网总开关即闸) */
  webSearch: boolean;
  /** 长期记忆总开关:开 = 注册 memory_* 工具 + 每轮注入 <user-memory>;
   *  缺省 = 开。关 = 不注册工具不注入,彻底无痕 */
  memory: boolean;
  /** 技能总开关:关 = / 调用不生效(菜单与技能页管理不受影响);
   *  缺省 = 开。技能是用户手动安装的本地指令文本,无网络无外传,空库零成本 */
  skills: boolean;
  /** 写操作确认门档位(ConfirmLevel 真源在同文件下方):strict = 一切写动作
   *  逐次过确认卡(缺省,安全默认);auto = 页面写动作免门,记忆写/MCP/
   *  可疑出站仍过门;off = 全部免审(用户自担,UI 明示)。过门范围见
   *  agent/confirmations.ts 的 TOOL_CATEGORY 与 needsConfirmation(level);
   *  读时迁移:legacy confirmActions 布尔按 false→off / 其余→strict 映射,
   *  非法档位值回落 legacy 再回落 strict;写入走 saveConfirmLevel(双写
   *  legacy 键,保旧版回滚时读到一致语义) */
  confirmLevel: ConfirmLevel;
  /** 任务完成通知:开 = run 结束且面板不可见时发系统通知;缺省 = 开 */
  notifyDone: boolean;
  /** 搜索服务配置;选了服务商但 apiKey 为空时 web_search 退回免 Key 标签页通道 */
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

/** 上下文压缩触发档位:占可用窗口(contextTokens − maxTokens − 余量)的比例 */
export type CompactLevel = "early" | "standard" | "late";
export const COMPACT_LEVELS: CompactLevel[] = ["early", "standard", "late"];

/** 写操作确认门档位(confirmLevel 的真源,消费在 agent/confirmations.ts):
 *  strict = 一切写动作逐次过确认卡(缺省,安全默认);auto = 页面写动作
 *  (click/fill,含提交型)免门,记忆写/MCP/可疑出站仍过门;off = 全部免审
 *  (用户自担)。语义与迁移见 permission-levels-plan */
export type ConfirmLevel = "strict" | "auto" | "off";
export const CONFIRM_LEVELS: ConfirmLevel[] = ["strict", "auto", "off"];

export async function loadConfig(): Promise<AppConfig> {
  // 历史兼容:旧版曾支持「仅本次会话」的 key,现无写入方(见文件头注)
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
    "confirmLevel",
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
    // 显式存储过的 locale 永远尊重;缺席(首开)按浏览器语言探测一次
    locale:
      l.locale === "en-US" || l.locale === "zh-CN"
        ? l.locale
        : detectLocale(
            typeof navigator !== "undefined" ? navigator.language : undefined,
          ),
    // 联网搜索 BYOK 化后缺省关闭:开关显式打开 + 配好 key 才对模型可用
    webSearch: l.webSearch === true,
    // 长期记忆缺省开启(记忆为空时除工具 schema 外无成本;关 = 彻底无痕)
    memory: l.memory !== false,
    // 技能缺省开启(纯本地文本,空库零成本;关 = / 调用不生效)
    skills: l.skills !== false,
    // 写操作确认档位:合法值直读;非法/缺席回落 legacy 布尔(false→off,
    // 其余→strict)——旧版只写过 strict/off 两态,auto 只能来自新 UI;
    // 写入走 saveConfirmLevel(双写 legacy 键,回滚到旧版语义一致)
    confirmLevel: CONFIRM_LEVELS.includes(l.confirmLevel as ConfirmLevel)
      ? (l.confirmLevel as ConfirmLevel)
      : l.confirmActions === false
        ? "off"
        : "strict",
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
    return (raw as ProviderEntry[])
      .filter(
        (p) =>
          p &&
          typeof p.id === "string" &&
          typeof p.apiKey === "string" &&
          typeof p.baseUrl === "string" &&
          Array.isArray(p.models) &&
          // models 条目同 legacy 路径一样逐条校验:损坏条目放行会让下游
          // find(m => m.id === …) 对 null 取属性直接炸
          p.models.every((m) => m && typeof m.id === "string"),
      )
      .map((p) => ({
        ...p,
        // 协议白名单:非法值不猜、不静默改写成缺省,直接丢弃该键(undefined
        // 即按缺省 chat-completions 消费;"responses" 保留让工厂显式报错)
        kind: PROVIDER_KINDS.includes(p.kind as ProviderKind)
          ? p.kind
          : undefined,
      }));
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
      | "confirmLevel"
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

/** 档位写入唯一入口(savePrefs 不收 confirmActions——它已不在 AppConfig 上)。
 *  双写 legacy confirmActions 布尔:用户升级后回滚/侧载旧版 build 时,旧版
 *  loadConfig 读的是 confirmActions —— 不双写会让选过 auto 的用户在旧版里
 *  被读成「全免审」,比其所选档更松(回滚方向安全,一行代价)。legacy 双写
 *  保留至下个次版本,届时随读侧迁移一并清除 */
export async function saveConfirmLevel(level: ConfirmLevel): Promise<void> {
  await chrome.storage.local.set({
    confirmLevel: level,
    confirmActions: level !== "off",
  });
}

/** 运行时观测回写(能力判定第 3 层):该模型真吐过推理内容而条目尚未标记
 *  → 置位 true。只置位不撤销(不覆盖目录/手动的显式 false);供应商或模型
 *  引用失效静默跳过。与设置页并发保存的竞态窗口极小且幂等,接受最后写入胜 */
export async function markReasoningObserved(
  providerId: string,
  modelId: string,
): Promise<void> {
  const cfg = await loadConfig();
  const p = cfg.providers.find((x) => x.id === providerId);
  const m = p?.models.find((x) => x.id === modelId);
  if (!p || !m || m.reasoning !== undefined) return;
  m.reasoning = true;
  await savePrefs({ providers: cfg.providers });
}
