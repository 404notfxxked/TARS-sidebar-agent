// 模型列表:GET {base}/models —— OpenAI 兼容层的事实标准端点
// (DeepSeek/Kimi/OpenRouter/SiliconFlow/Ollama 兼容层都实现);
// 不实现该端点的中转会失败,调用方需降级为手动填写。
// 面板侧直接调用(host_permissions: <all_urls>,扩展页面 fetch 无 CORS 限制)

import { apiFetch } from "./client";

export async function fetchModels(
  baseUrl: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const res = await apiFetch({
    baseUrl,
    apiKey,
    path: "/models",
    method: "GET",
    timeoutMs: 10_000,
    retry: false, // 用户在等按钮反馈,快速失败比退避重试合适
    signal,
  });
  const json: unknown = await res.json();
  const ids = (json as { data?: Array<{ id?: unknown }> })?.data ?? [];
  return [
    ...new Set(
      ids
        .map((m) => m?.id)
        .filter((id): id is string => typeof id === "string" && id !== ""),
    ),
  ].sort((a, b) => a.localeCompare(b));
}
