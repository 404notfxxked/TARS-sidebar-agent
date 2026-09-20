// 模型列表:GET {base}/models —— OpenAI 兼容层与 Anthropic 官方(2024 起的
// /v1/models)都实现的端点,响应同为 {data:[{id,…}]} 形状,只有认证头不同;
// 不实现该端点的中转会失败,调用方需降级为手动填写。注意 Anthropic 兼容端点
// (bridge)不一定实现 /models —— 例如 DeepSeek 的 /anthropic 文档只列了
// /messages,拉列表失败属预期,设置页有手动添加模型的兜底。
// 调用方(设置页)在 fetch 前经 ensureOriginAuthorized 按域取得 host 授权
// (安装零授权模型:optional_host_permissions),授权后扩展上下文 fetch 不受 CORS 限制

import type { ProviderKind } from "../../shared/configStore";
import { apiFetch } from "./client";

export async function fetchModels(
  baseUrl: string,
  apiKey: string,
  signal?: AbortSignal,
  kind?: ProviderKind,
): Promise<string[]> {
  const anthropic = kind === "anthropic-messages";
  const res = await apiFetch({
    baseUrl,
    apiKey,
    path: "/models",
    method: "GET",
    ...(anthropic
      ? {
          auth: "custom" as const,
          headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        }
      : {}),
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
