// 统一 HTTP 层:超时、错误归一化、取消 signal 合并、有限重试
// 重试参考 Anthropic SDK / Claude Code:只重试临时错误 + 指数退避带抖动 + 尊重 Retry-After
// 不做 SSE 解析 / 请求体构造 —— 那些因 provider 而异,留在各 adapter

const DEFAULT_TIMEOUT_MS = 30_000;
// 可重试的临时错误:429 限流、502/503/529 服务过载。4xx(除 429)和明确错误不重试
const RETRYABLE_STATUS = new Set([429, 502, 503, 529]);
const MAX_RETRY = 3;
const BASE_DELAY_MS = 500;

/** 明确的 HTTP 错误(状态码 + 响应体片段);models.ts 按状态码做错误分类 */
export class ApiError extends Error {
  constructor(
    public status: number,
    public body: string,
  ) {
    super(`HTTP ${status}${body ? ` — ${body.slice(0, 200)}` : ""}`);
    this.name = "ApiError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 指数退避 + 随机抖动;若服务端给了 Retry-After 则优先使用 */
function delayFor(attempt: number, retryAfterMs: number | null): number {
  if (retryAfterMs !== null) return retryAfterMs;
  return BASE_DELAY_MS * 2 ** attempt + Math.round(Math.random() * 200);
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number.parseInt(header, 10);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

export interface ApiFetchOptions {
  baseUrl: string;
  apiKey: string;
  path: string;
  /** 默认 POST(chat completions);模型列表等只读端点用 GET */
  method?: "GET" | "POST";
  body?: unknown;
  timeoutMs?: number;
  /** 网络层错误/临时状态码是否退避重试(默认开);拉模型列表这类交互请求传 false 快速失败 */
  retry?: boolean;
  /** 认证方式:bearer = Authorization: Bearer(缺省,chat-completions 系);
   *  custom = 本函数自身不发 Authorization,认证头整体由调用方经 headers 自带
   *  (anthropic-messages:x-api-key + anthropic-version,外加 Authorization
   *  Bearer 双头,见 anthropicMessages.ts / models.ts) */
  auth?: "bearer" | "custom";
  /** 额外请求头,与默认头合并(同名字段以此为准);auth:"custom" 时必经此传认证头 */
  headers?: Record<string, string>;
  signal?: AbortSignal; // 外部取消(用户点取消 / agent 终止)
}

export async function apiFetch(opts: ApiFetchOptions): Promise<Response> {
  const {
    baseUrl,
    apiKey,
    path,
    method = "POST",
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retry = true,
    auth = "bearer",
    headers: extraHeaders,
    signal,
  } = opts;

  const maxRetry = retry ? MAX_RETRY : 0;
  // 尾斜杠归一:设置页存进的 baseUrl 可能带 /,直接拼接会产出 //chat/completions
  const base = baseUrl.replace(/\/+$/, "");
  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    const timeout = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      timeout.abort();
    }, timeoutMs);
    // 合并外部 signal 和超时:任一 abort 都让 fetch 中断
    const merged = signal
      ? AbortSignal.any([signal, timeout.signal])
      : timeout.signal;

    try {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...(body !== undefined && { "Content-Type": "application/json" }),
          // Bearer 认证(RFC 6750):Authorization 头带 token,「持票即放行」。
          // Anthropic Messages API 不用 Bearer,用 x-api-key + anthropic-version:
          // auth:"custom" 时不发 Authorization,由调用方经 headers 自带认证头
          ...(auth === "bearer" && { Authorization: `Bearer ${apiKey}` }),
          ...extraHeaders,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: merged,
      });

      if (res.ok) return res;

      // 尽量拿错误体用于报错;读 body 本身也可能失败(连接中断等),
      // 兜底为空串,不让次要的读取失败掩盖真正要抛出的 HTTP 错误
      const errBody = await res.text().catch(() => "");
      // 临时错误且未到重试上限 → 退避后重试
      if (RETRYABLE_STATUS.has(res.status) && attempt < maxRetry) {
        await sleep(
          delayFor(attempt, parseRetryAfter(res.headers.get("retry-after"))),
        );
        continue;
      }
      throw new ApiError(res.status, errBody);
    } catch (err) {
      if (timedOut) throw new Error(`request timeout after ${timeoutMs}ms`);
      if (signal?.aborted) throw err; // 用户取消,不重试
      if (err instanceof ApiError) throw err; // 明确错误(如 401/400),不重试
      if (attempt >= maxRetry) throw err; // 网络层错误重试耗尽
      await sleep(delayFor(attempt, null)); // fetch 网络层失败(连接/超时类)→ 退避重试
    } finally {
      clearTimeout(timer);
    }
  }

  /* 逻辑上不可达,仅供 TS 收尾 */
  throw new Error("retry exhausted");
}
