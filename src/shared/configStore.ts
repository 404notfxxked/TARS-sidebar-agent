// 全量配置存储(shared —— side panel 与 service worker 共用):
// - name / model / baseUrl 等恒存 chrome.storage.local(非敏感)
// - apiKey 受「记住」控制:勾选 → local(持久);不勾 → session(仅本次会话)
// - 读取时 apiKey 以 session 优先、回退 local —— 本次会话新输的 key 覆盖旧的记住值
// 协议只支持 OpenAI 兼容格式(DeepSeek/Kimi/OpenRouter/Ollama 等通用)

export type ThemePref = "system" | "light" | "dark";

export interface AppConfig {
  /** 配置显示名(选填):为将来多配置档案预留,当前无消费方 */
  name: string;
  apiKey: string;
  remember: boolean;
  model: string;
  baseUrl: string; // 空 = 用 OpenAI 官方地址;约定含 /v1,如 https://api.deepseek.com/v1
  maxContextTokens: number; // 0 = 未设置，不展示用量进度条
  theme: ThemePref;
}

export async function loadConfig(): Promise<AppConfig> {
  const s = await chrome.storage.session.get("apiKey");
  const l = await chrome.storage.local.get([
    "apiKey",
    "name",
    "model",
    "baseUrl",
    "maxContextTokens",
    "theme",
  ]);

  const apiKey = s.apiKey ?? l.apiKey ?? "";
  return {
    name: l.name ?? "",
    apiKey,
    remember: !s.apiKey, // session 有 key = 本次会话输入的;否则(local 或没有)默认记住
    model: l.model ?? "",
    baseUrl: l.baseUrl ?? "",
    maxContextTokens: l.maxContextTokens ?? 0,
    theme: l.theme ?? "system",
  };
}

/** 非敏感偏好的局部保存(storage key 与字段同名,直接落盘)。
 *  自动保存的各控件按字段调用,避免整包重写 apiKey 相关存储 */
export async function savePrefs(
  prefs: Partial<
    Pick<AppConfig, "name" | "model" | "baseUrl" | "maxContextTokens" | "theme">
  >,
): Promise<void> {
  await chrome.storage.local.set(prefs);
}

export async function saveConfig(input: AppConfig): Promise<void> {
  // 非敏感字段恒存 local
  await chrome.storage.local.set({
    name: input.name,
    model: input.model.trim(),
    baseUrl: input.baseUrl.trim(),
    maxContextTokens: input.maxContextTokens,
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
