// 模型列表:GET {base}/models —— OpenAI 兼容层与 Anthropic 官方(2024 起的
// /v1/models)都实现的端点,响应同为 {data:[{id,…}]} 形状。
//
// base URL 有两种生态约定(2026-09 二十余家端点调研,详见会话记录):
// OpenAI 系要求含版本段(/v1、/v4…),Anthropic 系(Claude Code / 官方 SDK)的
// ANTHROPIC_BASE_URL 是不含 /v1 的根地址,SDK 自行补 /v1/xxx。用户按后者习惯
// 粘贴根地址时,{base}/models 404 而 {base}/v1/models 才是对的。处理按
// 「已知直打、未知探测」分层:
//  ①已知桥接形态(BRIDGE_MODELS_PATHS,精确 host 白名单):该桥不实现
//    /models、列表只挂同 origin 的 OpenAI 形状端点,首选候选直打文档端点,
//    不明知 404 仍走 {base}/models 的错误路径。每条带核实日期与来源;精确
//    host 全等匹配,自建中转的自定义域名不会误命中;
//  ②通用候选链(零厂商知识):{base}/models → {base}/v1/models(仅 base
//    末段非版本段,拼 /v1/v1 必错)→ 同 origin 根的 /models、/v1/models
//    (仅 anthropic 格式:未知桥的列表可能挂 origin 根;OpenAI 生态无此约定)。
//    靠真实响应判定:仅 404/405(或 200 但形状不对)推进;base 域候选 401/403
//    说明路由存在是认证问题,立即报错不换路径;origin 根候选是**猜测**,其
//    401/403 不中止整链(同 key 不同路由的权限差异不该冒充电报认证失败),
//    记录后走完,最终错误仍以 base 域结论为主。
// 命中 {base}/v1/models 时返回 suggestedBase({base}/v1),设置页据此提示
// 「一键修正」——聊天请求同样受约定影响;白名单/origin 根候选命中则不给
// (列表在别处,聊天仍走 {base}/v1/messages,base 不能动)。
// Anthropic 官方列表默认 limit=20 且分页(has_more/after_id),这里 limit=1000
// 起拉、按 has_more 翻页,总页数封顶(硬规则 8:拼接输入必须有硬预算);
// 分页参数只发给 Anthropic 形状的候选(白名单/origin 根是 OpenAI 形状,不带)。
// 认证:OpenAI 系 Bearer;Anthropic 系 x-api-key + anthropic-version 外加
// Authorization: Bearer **双头** —— 官方认 x-api-key,AUTH_TOKEN 系网关与
// Baseten 等只认 Bearer,官方 apiKeyHelper 与 new-api 均双认,同发是兼容超集。
// 不实现该端点的桥(如百炼文档明示仅 /v1/messages)全链失败,错误按 code
// 分类(auth/missing/shape),调用方(设置页)映射为可行动文案,手动添加
// 模型兜底。调用方在 fetch 前经 ensureOriginAuthorized 按域取得 host 授权
// (安装零授权模型:optional_host_permissions),候选探测均在同一 origin 内,
// 不越出已授权范围;授权后扩展上下文 fetch 不受 CORS 限制

import type { ProviderKind } from "../../shared/configStore";
import { apiFetch, ApiError } from "./client";

/** 已知桥接形态:该 host 的 Anthropic 兼容桥不实现 /models,模型列表挂在
 *  同 origin 的 OpenAI 形状端点(值 = 相对 origin 根的路径)。精确 host 全等
 *  匹配(非子串/正则,中转自建域名不误命中);命中即首选直打,不再走错误
 *  路径。每条注明核实日期与来源,host/端点变更时改这里 */
const BRIDGE_MODELS_PATHS: Record<string, string> = {
  // 官方文档:全站唯一列表端点 GET /models,/anthropic 桥仅 messages(2026-09-24 核实)
  "api.deepseek.com": "/models",
  // Kimi 平台线:桥 404 url.not_found,列表在 OpenAI 线 /v1/models(2026-09-23 官方论坛+实测)
  "api.moonshot.cn": "/v1/models",
  "api.moonshot.ai": "/v1/models",
};

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

/** 单个候选:baseUrl+path 才拼得出一处(白名单/origin 根候选的 baseUrl 是
 *  origin 根,base 域候选是用户填的 base);speculative = origin 根的猜测性
 *  探测,其 401/403 不中止整链;openaiShape = 列表在 OpenAI 线,不发 Anthropic
 *  分页参数 */
interface Candidate {
  baseUrl: string;
  path: string;
  suggestedBase: string | null;
  speculative?: boolean;
  openaiShape?: boolean;
}

/** 单页 GET + 形状校验:200 但 data 非数组(智谱桥 200 包业务错误、网关回
 *  HTML)按 shape 抛 ModelsFetchError,让候选循环有推进依据 */
async function fetchPage(
  candidate: Candidate,
  apiKey: string,
  kind: ProviderKind | undefined,
  signal?: AbortSignal,
): Promise<Page> {
  const anthropic = kind === "anthropic-messages" && !candidate.openaiShape;
  const res = await apiFetch({
    baseUrl: candidate.baseUrl,
    apiKey,
    path: candidate.path,
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
  // origin 解析失败(用户手填裸域名等)时白名单与 origin 根探测静默缺席,
  // 退回纯 base 域候选
  let origin = "";
  try {
    origin = new URL(base).origin;
  } catch {
    /* 非法 URL:跳过一切依赖 origin 的候选 */
  }

  // 候选阶梯:白名单直打 → base 域 → origin 根猜测;同 URL 去重
  const candidates: Candidate[] = [];
  const push = (c: Candidate) => {
    if (!candidates.some((x) => x.baseUrl === c.baseUrl && x.path === c.path))
      candidates.push(c);
  };
  if (anthropic && origin) {
    const bridgePath = BRIDGE_MODELS_PATHS[new URL(base).host];
    if (bridgePath)
      push({
        baseUrl: origin,
        path: bridgePath,
        suggestedBase: null,
        openaiShape: true,
      });
  }
  push({ baseUrl: base, path: "/models", suggestedBase: null });
  if (!hasVersionTail(base))
    push({ baseUrl: base, path: "/v1/models", suggestedBase: `${base}/v1` });
  if (anthropic && origin && base !== origin) {
    push({ baseUrl: origin, path: "/models", suggestedBase: null, speculative: true, openaiShape: true });
    push({ baseUrl: origin, path: "/v1/models", suggestedBase: null, speculative: true, openaiShape: true });
  }

  let lastError: ModelsFetchError | null = null;
  for (const candidate of candidates) {
    try {
      const ids: string[] = [];
      let afterId = "";
      for (let page = 0; page < MAX_PAGES; page++) {
        const pageRes = await fetchPage(
          {
            ...candidate,
            path: anthropic && !candidate.openaiShape
              ? `${candidate.path}?limit=${PAGE_LIMIT}${afterId ? `&after_id=${afterId}` : ""}`
              : candidate.path,
          },
          apiKey,
          kind,
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
        if (code === "auth" && !candidate.speculative)
          throw new ModelsFetchError(code, err.message);
        if (code === "auth" || code === "missing") {
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
