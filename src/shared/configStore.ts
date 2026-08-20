// 全量配置存储(shared —— side panel 与 service worker 共用):
// - provider / model / baseUrl 恒存 chrome.storage.local(非敏感)
// - apiKey 受「记住」控制:勾选 → local(持久);不勾 → session(仅本次会话)
// - 读取时 apiKey 以 session 优先、回退 local —— 本次会话新输的 key 覆盖旧的记住值

export type ProviderName = "openai" | "anthropic";

export interface AppConfig {
  apiKey: string;
  remember: boolean;
  provider: ProviderName;
  model: string;
  baseUrl: string; // 空 = 用适配器默认地址
  maxContextTokens: number; // 0 = 未设置，不展示用量进度条
}

export async function loadConfig(): Promise<AppConfig> {
  const s = await chrome.storage.session.get("apiKey");
  const l = await chrome.storage.local.get([
    "apiKey",
    "provider",
    "model",
    "baseUrl",
    "maxContextTokens",
  ]);

  const apiKey = s.apiKey ?? l.apiKey ?? "";
  return {
    apiKey,
    remember: !s.apiKey, // session 有 key = 本次会话输入的;否则(local 或没有)默认记住
    provider: l.provider ?? "openai",
    model: l.model ?? "",
    baseUrl: l.baseUrl ?? "",
    maxContextTokens: l.maxContextTokens ?? 0,
  };
}

export async function saveConfig(input: AppConfig): Promise<void> {
  // 非敏感字段恒存 local
  await chrome.storage.local.set({
    provider: input.provider,
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
