// 全量配置存储(shared —— side panel 与 service worker 共用):
// - name / model / baseUrl / models 等恒存 chrome.storage.local(非敏感)
// - apiKey 受「记住」控制:勾选 → local(持久);不勾 → session(仅本次会话)
// - 读取时 apiKey 以 session 优先、回退 local —— 本次会话新输的 key 覆盖旧的记住值
// 协议只支持 OpenAI 兼容格式(DeepSeek/Kimi/OpenRouter/Ollama 等通用)

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

/** 模型列表条目(存 local 的 models key) */
export interface ModelEntry {
  /** wire 模型名,列表内唯一键 */
  id: string;
  /** 显示别名(选填):聊天区选择器优先显示它,模型 ID 太长时用 */
  alias?: string;
  /** 多模态标记:纯元数据,图片通路接入后生效,当前不改变任何行为 */
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
  /** 配置显示名(选填):为将来多配置档案预留,当前无消费方 */
  name: string;
  apiKey: string;
  remember: boolean;
  /** 当前默认模型 = models 中某项的 id;聊天区选择器切换即改写此值 */
  model: string;
  /** 持久化的模型列表:拉取 merge、手动添加、每模型独立配置 */
  models: ModelEntry[];
  baseUrl: string; // 空 = 用 OpenAI 官方地址;约定含 /v1,如 https://api.deepseek.com/v1
  theme: ThemePref;
  /** 重点色:决定整套 M3 scheme 的源色(表面底色不随它变,只换强调/主色系) */
  accent: AccentPref;
  /** 联网开关:控制 web_search / web_fetch 工具是否对模型可用;缺省 = 开 */
  webSearch: boolean;
  /** 历史会话保留天数:0 = 全部保留;缺省 7(sessionHistory.pruneExpiredSessions) */
  historyRetention: number;
}

export async function loadConfig(): Promise<AppConfig> {
  const s = await chrome.storage.session.get("apiKey");
  const l = await chrome.storage.local.get([
    "apiKey",
    "name",
    "model",
    "models",
    "baseUrl",
    "maxContextTokens",
    "theme",
    "accent",
    "webSearch",
    "historyRetention",
  ]);

  const apiKey = s.apiKey ?? l.apiKey ?? "";
  // 旧版只有单个 model(+ maxContextTokens):首次读取时合成单条目列表;
  // models key 一旦写入,旧 key 只读不再写,自然废弃
  const models: ModelEntry[] = Array.isArray(l.models)
    ? (l.models as ModelEntry[]).filter((m) => m && typeof m.id === "string")
    : l.model
      ? [{ id: l.model, contextTokens: l.maxContextTokens || undefined }]
      : [];
  return {
    name: l.name ?? "",
    apiKey,
    remember: !s.apiKey, // session 有 key = 本次会话输入的;否则(local 或没有)默认记住
    model: l.model ?? "",
    models,
    baseUrl: l.baseUrl ?? "",
    theme: l.theme ?? "system",
    accent: ACCENT_IDS.includes(l.accent as AccentPref)
      ? (l.accent as AccentPref)
      : "green",
    // 旧版本没有这个 key:undefined 视为开启(能力默认可用,开关只做显式关闭)
    webSearch: l.webSearch !== false,
    // 历史保留天数:与 sessionHistory.retentionDays 的缺省保持一致(7 天)
    historyRetention:
      typeof l.historyRetention === "number" && l.historyRetention >= 0
        ? l.historyRetention
        : 7,
  };
}

/** 非敏感偏好的局部保存(storage key 与字段同名,直接落盘)。
 *  自动保存的各控件按字段调用,避免整包重写 apiKey 相关存储 */
export async function savePrefs(
  prefs: Partial<
    Pick<
      AppConfig,
      | "name"
      | "model"
      | "models"
      | "baseUrl"
      | "theme"
      | "accent"
      | "webSearch"
      | "historyRetention"
    >
  >,
): Promise<void> {
  await chrome.storage.local.set(prefs);
}

export async function saveConfig(input: AppConfig): Promise<void> {
  // 非敏感字段恒存 local
  await chrome.storage.local.set({
    name: input.name,
    model: input.model.trim(),
    models: input.models,
    baseUrl: input.baseUrl.trim(),
  });

  // apiKey 受「记住」控制
  if (input.remember) {
    await chrome.storage.local.set({ apiKey: input.apiKey });
  } else {
    await chrome.storage.local.remove("apiKey"); // 忘掉旧值,避免残留
  }
  await chrome.storage.session.set({ apiKey: input.apiKey }); // 本次会话总是可用
}

// 「忘记」只清 API key,不清 provider/model/baseUrl:那些是非敏感偏好,
// 每次忘记都清掉会让用户反复重选;需要「恢复默认」时应另加函数,而非改这里
export async function forgetApiKey(): Promise<void> {
  await chrome.storage.local.remove("apiKey");
  await chrome.storage.session.remove("apiKey");
}
