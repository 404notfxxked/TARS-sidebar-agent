// 模型列表:GET {base}/models —— OpenAI 兼容层与 Anthropic 官方(2024 起的
// /v1/models)都实现的端点,响应同为 {data:[{id,…}]} 形状。
//
// base URL 有两种生态约定(2026-09 二十余家端点调研,详见会话记录):
// OpenAI 系要求含版本段(/v1、/v4…),Anthropic 系(Claude Code / 官方 SDK)的
// ANTHROPIC_BASE_URL 是不含 /v1 的根地址,SDK 自行补 /v1/xxx。用户按后者习惯
// 粘贴根地址时,{base}/models 404 而 {base}/v1/models 才是对的。这里**不做**
// 按厂商/正则改写(误伤中转站、规则表必腐化、跨 host 改写会越过按域授权),
// 而是**候选回退探测**:至多两个候选挨个真打,靠真实响应判定 ——
//  - base 末段已是版本段:只打 {base}/models(拼 /v1/v1 必错,禁回退);
//  - 否则先 {base}/models,仅 404/405(或 200 但形状不对)才推进 {base}/v1/models;
//  - 401/403 说明路由存在、是认证问题,立即报错不换路径(换路径无意义);
//  - 其余错误(网络层/超时/其他状态码)原样抛出,不推进候选。
// 命中回退候选时返回 suggestedBase({base}/v1),设置页据此提示「一键修正」
// —— 聊天请求({base}/messages vs {base}/v1/messages)同样受约定影响。
// Anthropic 官方列表默认 limit=20 且分页(has_more/after_id),这里 limit=1000
// 起拉、按 has_more 翻页,总页数封顶(硬规则 8:拼接输入必须有硬预算)。
// 认证:OpenAI 系 Bearer;Anthropic 系 x-api-key + anthropic-version 外加
// Authorization: Bearer **双头** —— 官方认 x-api-key,AUTH_TOKEN 系网关与
// Baseten 等只认 Bearer,官方 apiKeyHelper 与 new-api 均双认,同发是兼容超集。
// 不实现该端点的桥(如 DeepSeek /anthropic 文档只列 /messages)两个候选都
// 失败,错误按 code 分类(auth/missing/shape),调用方(设置页)映射为可行动
// 文案,手动添加模型兜底。调用方在 fetch 前经 ensureOriginAuthorized 按域取得
// host 授权(安装零授权模型:optional_host_permissions),候选探测均在同一
// origin 内,不越出已授权范围;授权后扩展上下文 fetch 不受 CORS 限制

import type { ProviderKind } from "../../shared/configStore";
import { apiFetch, ApiError } from "./client";

/** 错误分类:auth=认证失败;missing=端点没有该路由;shape=200 但不是模型列表 */
export type ModelsErrorCode = "auth" | "missing" | "shape";

export class ModelsFetchError extends Error {
  constructor(
    public code: ModelsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ModelsFetchError";
  }
}

export interface FetchModelsResult {
  ids: string[];
  /** 命中回退候选时给出实际生效的 base(如 {root}/v1),调用方可提示修正 */
  suggestedBase: string | null;
}

/** base 末段已是版本段(v1/v4/v1beta…):再拼 /v1 必错,禁用回退候选 */
function hasVersionTail(baseUrl: string): boolean {
  const tail = baseUrl.trim().replace(/\/+$/, "").split("/").pop() ?? "";
  return /^v\d/i.test(tail);
}

/** 401/403 归 auth(立即停),404/405 归 missing(可推进候选),其余不归类 */
function classifyStatus(status: number): ModelsErrorCode | null {
  if (status === 401 || status === 403) return "auth";
  if (status === 404 || status === 405) return "missing";
  return null;
}

const ANTHROPIC_VERSION = "2023-06-01";
const PAGE_LIMIT = 1000; // Anthropic list models 的上限;OpenAI 系忽略该参数不带
const MAX_PAGES = 4; // 首页 + 3 次翻页:响应驱动的硬上界(硬规则 8)

interface Page {
  ids: string[];
  hasMore: boolean;
  lastId: string;
}

/** 单页 GET + 形状校验:200 但 data 非数组(智谱桥 200 包业务错误、网关回
 *  HTML)按 shape 抛 ModelsFetchError,让候选循环有推进依据 */
async function fetchPage(
  baseUrl: string,
  apiKey: string,
  kind: ProviderKind | undefined,
  path: string,
  signal?: AbortSignal,
): Promise<Page> {
  const anthropic = kind === "anthropic-messages";
  const res = await apiFetch({
    baseUrl,
    apiKey,
    path,
    method: "GET",
    ...(anthropic
      ? {
          auth: "custom" as const,
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
            Authorization: `Bearer ${apiKey}`,
          },
        }
      : {}),
    timeoutMs: 10_000,
    retry: false, // 用户在等按钮反馈,快速失败比退避重试合适
    signal,
  });
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new ModelsFetchError("shape", "response is not JSON");
  }
  const data = (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) {
    throw new ModelsFetchError("shape", "response has no data array");
  }
  const ids = data
    .map((m) => (m as { id?: unknown } | null)?.id)
    .filter((id): id is string => typeof id === "string" && id !== "");
  const last = json as { has_more?: unknown; last_id?: unknown };
  return {
    ids,
    hasMore: last.has_more === true,
    lastId: typeof last.last_id === "string" ? last.last_id : "",
  };
}

export async function fetchModels(
  baseUrl: string,
  apiKey: string,
  signal?: AbortSignal,
  kind?: ProviderKind,
): Promise<FetchModelsResult> {
  const base = baseUrl.trim().replace(/\/+$/, "");
  const anthropic = kind === "anthropic-messages";
  const candidates = hasVersionTail(base)
    ? [{ path: "/models", suggestedBase: null as string | null }]
    : [
        { path: "/models", suggestedBase: null as string | null },
        { path: "/v1/models", suggestedBase: `${base}/v1` },
      ];

  let lastError: ModelsFetchError | null = null;
  for (const candidate of candidates) {
    try {
      const ids: string[] = [];
      let afterId = "";
      for (let page = 0; page < MAX_PAGES; page++) {
        const pageRes = await fetchPage(
          base,
          apiKey,
          kind,
          anthropic
            ? `${candidate.path}?limit=${PAGE_LIMIT}${afterId ? `&after_id=${afterId}` : ""}`
            : candidate.path,
          signal,
        );
        ids.push(...pageRes.ids);
        if (!pageRes.hasMore || !pageRes.lastId) break;
        afterId = pageRes.lastId;
      }
      return {
        ids: [...new Set(ids)].sort((a, b) => a.localeCompare(b)),
        suggestedBase: candidate.suggestedBase,
      };
    } catch (err) {
      if (err instanceof ModelsFetchError) {
        lastError = err; // shape:候选端点形状不对,推进下一候选
        continue;
      }
      if (err instanceof ApiError) {
        const code = classifyStatus(err.status);
        if (code === "auth") throw new ModelsFetchError(code, err.message);
        if (code === "missing") {
          lastError = new ModelsFetchError(code, err.message);
          continue;
        }
      }
      throw err; // 网络层/超时/其他状态码:原样抛,不推进候选
    }
  }
  if (!lastError) throw new Error("model list fetch failed");
  throw lastError;
}
