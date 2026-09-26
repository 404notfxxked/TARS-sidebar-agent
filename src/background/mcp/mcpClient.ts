// MCP 传输层 —— 单台服务器的 JSON-RPC 客户端(Streamable HTTP over fetch)。
// 只管「消息怎么过去、响应怎么回来」,不懂工具语义(那是 mcpManager 的事)。
//
// 设计依据(MCP 规范 2026-07-28):
// - 每条 JSON-RPC 消息 = 一次独立 POST 到 MCP 端点;响应是单个 JSON 或
//   请求作用域的 SSE 流。**无会话、无 GET 长连接** —— 这个形态恰好匹配
//   MV3 Service Worker(SW 随时被杀,没有常驻连接可维持,连接即用即弃)
// - 现代(2026-07-28)请求必须带 MCP-Protocol-Version / Mcp-Method /
//   Mcp-Name 头,协议元数据放在 params._meta
// - 2025-03-26 ~ 2025-11-25 的「旧版」服务器用 initialize 握手 +
//   Mcp-Session-Id 会话。现实里绝大多数现存服务器都是这一代,所以兼容
//   路径不是边角料,是主路径
// - 兼容探测(规范给的算法的务实简化):先按现代格式 POST,收到
//   400/404/405 且时代未知 → 跑 initialize 握手转 legacy 并重试原请求。
//   不区分「400 里是现代错误码还是别的」:现代服务器收到格式正确的请求
//   不会 400,能 400 的都按旧版握手处理,一次握手试错可接受
// - 取消 = abort fetch = 关闭响应流,规范原文「关闭 SSE 响应流即取消」,
//   与 agent 的 AbortSignal 链路天然对齐
// - 服务器主动发来的 JSON-RPC 请求(sampling 等):现代规范已禁止;旧版
//   服务器若发,不响应让它自己超时 —— V1 明确不支持采样/追问
//
// CORS:目标域获 host 授权后(添加服务器时按域请求,或设置 → 安全的总开关),
// 扩展 SW 的跨域 fetch 不受 CORS 限制,这是扩展平台相对网页客户端的结构性优势
// (网页客户端接远程 MCP 普遍被卡)。注意 fetch 会带 Origin:
// chrome-extension://<id>,个别严格校验 Origin 的服务器可能 403 ——
// 属于服务器侧策略,客户端无解(Origin 是禁止改写的头)。

import { createLogger } from "../../shared/logger";
import { bytesToBase64 } from "../../shared/imageCodec";
import { readSSE } from "../provider/sse";

const log = createLogger({ ctx: "bg" });

/** 本客户端声明的现代协议版本 */
const MODERN_VERSION = "2026-07-28";
/** initialize 握手时声明的版本(旧版服务器普遍支持的一代) */
const LEGACY_VERSION = "2025-06-18";
/** 客户端身份声明。`version` **取自扩展 manifest**(`chrome.runtime.getManifest()`),
 *  不在这里再写一份字面量 —— 曾经硬编码 `1.1.0`,而 `check-version` 只比
 *  package.json ↔ manifest.json,发版时这处副本会静默过期(对外声明错版本)。
 *  取不到 manifest(非扩展运行环境)时回落 `0.0.0`:clientInfo 只是身份声明,
 *  服务器不做版本校验,不值得让握手因此失败。 */
function clientInfo(): { name: string; version: string } {
  let version = "0.0.0";
  try {
    version = chrome.runtime.getManifest().version;
  } catch {
    // 见上:回落值即够用
  }
  return { name: "TARS", version };
}
/** 单请求超时:tools/list 快,tools/call 可能慢(外部系统操作),取宽值 */
const REQUEST_TIMEOUT_MS = 60_000;

/** 服务器返回的 JSON-RPC 协议级错误(区别于工具执行错误 isError) */
export class McpRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(`MCP ${message}(code ${code})`);
  }
}

/** 时代未知时的 HTTP 状态:视为「这不是现代服务器」的信号 */
const LEGACY_HINT_STATUS = new Set([400, 404, 405]);

export interface McpEndpoint {
  url: string;
  headers: Record<string, string>;
}

export class McpClient {
  /** modern = 2026-07-28 无状态;legacy = initialize 握手 + 会话头 */
  era: "unknown" | "modern" | "legacy" = "unknown";
  private sessionId?: string;
  private protocolVersion = MODERN_VERSION;
  private nextId = 1;

  /** wire 形状:unknown 与 modern 都按现代格式发(unknown 的首请求兼做
   *  时代探测,必须用现代形状才有「400 → 转旧版」的判定意义) */
  private get wireModern(): boolean {
    return this.era !== "legacy";
  }

  constructor(
    private endpoint: McpEndpoint,
    private label: string,
  ) {}

  /** 当前连接形态(UI 展示用) */
  get eraLabel(): string {
    return this.era === "modern"
      ? "现代(无状态)"
      : this.era === "legacy"
        ? "initialize 握手"
        : "未探测";
  }

  // ---- 对外的主入口:发一个 JSON-RPC 请求,返回 result ----

  async request(
    method: string,
    params: Record<string, unknown>,
    opts: {
      signal?: AbortSignal;
      /** tools/call 的工具名(组装 Mcp-Name 头) */
      wireName?: string;
      /** 额外请求头(x-mcp-header 镜像的 Mcp-Param-*) */
      extraHeaders?: Record<string, string>;
      /** 通知(无 id,只 202 不读响应体) */
      notification?: boolean;
      /** 禁止兼容探测(握手自身发出的请求) */
      noProbe?: boolean;
    } = {},
  ): Promise<unknown> {
    if (this.era === "unknown" && !opts.noProbe) {
      // 首个请求兼做时代探测:现代格式试一发,失败就转旧版握手重试
      try {
        const r = await this.post(method, params, opts);
        this.era = "modern";
        return r;
      } catch (err) {
        if (err instanceof McpHttpStatusError && LEGACY_HINT_STATUS.has(err.status)) {
          log.info("mcp", `${this.label} 非现代服务器,转 initialize 握手`, {
            status: err.status,
          });
          await this.handshake(opts.signal);
          return this.post(method, params, opts);
        }
        throw err;
      }
    }
    return this.post(method, params, opts);
  }

  /** 旧版服务器的 initialize 握手:协商版本、记会话头,然后报到位 */
  async handshake(signal?: AbortSignal): Promise<void> {
    const { result, headers } = await this.postRaw(
      "initialize",
      {
        protocolVersion: LEGACY_VERSION,
        capabilities: {},
        clientInfo: clientInfo(),
      },
      { signal, noProbe: true },
    );
    const r = result as { protocolVersion?: string } | undefined;
    // 版本协商:服务器答复的版本我们认识就用它的,不认识退回我们声明的
    const KNOWN = ["2025-03-26", "2025-06-18", "2025-11-25", MODERN_VERSION];
    this.protocolVersion =
      r?.protocolVersion && KNOWN.includes(r.protocolVersion)
        ? r.protocolVersion
        : LEGACY_VERSION;
    this.sessionId = headers.get("mcp-session-id") ?? undefined;
    this.era = "legacy";
    log.info("mcp", `${this.label} initialize 握手完成`, {
      protocolVersion: this.protocolVersion,
      session: this.sessionId ? "yes" : "no",
    });
    // initialized 通知:旧版规范要求发;失败无关紧要(有些实现 202,有些 200)
    try {
      await this.post("notifications/initialized", {}, { noProbe: true, notification: true, signal });
    } catch {
      /* 通知丢失不影响后续请求 */
    }
  }

  // ---- 底层 POST ----

  private async post(
    method: string,
    params: Record<string, unknown>,
    opts: {
      signal?: AbortSignal;
      wireName?: string;
      extraHeaders?: Record<string, string>;
      notification?: boolean;
      noProbe?: boolean;
    },
  ): Promise<unknown> {
    const { result } = await this.postRaw(method, params, opts);
    return result;
  }

  private async postRaw(
    method: string,
    params: Record<string, unknown>,
    opts: {
      signal?: AbortSignal;
      wireName?: string;
      extraHeaders?: Record<string, string>;
      notification?: boolean;
      noProbe?: boolean;
      /** 本条调用链已重握手过(防「握手成功但持续 404」的服务器无限循环) */
      rehandshaked?: boolean;
    },
  ): Promise<{ result: unknown; headers: Headers }> {
    const id = opts.notification ? undefined : this.nextId++;
    const bodyParams = this.wireModern && !opts.noProbe
      ? {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": this.protocolVersion,
            "io.modelcontextprotocol/clientInfo": clientInfo(),
            // V1 能力集为空:不支持 sampling/elicitation/roots
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        }
      : params;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      ...this.endpoint.headers,
      ...opts.extraHeaders,
    };
    if (this.wireModern && !opts.noProbe) {
      headers["MCP-Protocol-Version"] = this.protocolVersion;
      headers["Mcp-Method"] = method;
      if (opts.wireName) headers["Mcp-Name"] = encodeHeaderValue(opts.wireName);
    }
    if (this.era === "legacy" && this.sessionId) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }

    const res = await this.timedFetch(
      this.endpoint.url,
      {
        method: "POST",
        headers,
        body: JSON.stringify(
          id === undefined
            ? { jsonrpc: "2.0", method, params: bodyParams }
            : { jsonrpc: "2.0", id, method, params: bodyParams },
        ),
        signal: opts.signal,
      },
    );

    if (!res.ok) {
      // 会话失效(旧版服务器常以 404 表达):重握手一次再重试原请求。
      // 只重一次 —— 握手成功后仍 404 的服务器(会话即发即弃/路径配错)重试
      // 只会握手↔404 无限循环
      if (
        this.era === "legacy" &&
        this.sessionId &&
        res.status === 404 &&
        !opts.noProbe &&
        !opts.rehandshaked
      ) {
        log.warn("mcp", `${this.label} 会话失效,重新握手`);
        this.sessionId = undefined;
        await this.handshake(opts.signal);
        return this.postRaw(method, params, { ...opts, rehandshaked: true });
      }
      const text = await res.text().catch(() => "");
      // 认证错误:永远直报(时代无关,探测也不该掩盖它)
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `MCP 服务器认证失败(HTTP ${res.status})${snippet(text)};请在设置里检查该服务器的请求头(如 Authorization)`,
        );
      }
      throw new McpHttpStatusError(res.status, `MCP 请求失败(HTTP ${res.status})${snippet(text)}`);
    }

    if (opts.notification) return { result: undefined, headers: res.headers };

    const ctype = res.headers.get("content-type") ?? "";
    const result = ctype.includes("text/event-stream")
      ? await readSseResponse(res, id!, opts.signal)
      : await parseJsonResponse(res, id!);
    return { result, headers: res.headers };
  }

  /** 超时 + 外部取消的二合一:任一触发即 abort */
  private async timedFetch(url: string, init: RequestInit & { signal?: AbortSignal }) {
    const ctl = new AbortController();
    const outer = init.signal;
    const onOuter = () => ctl.abort(outer?.reason);
    outer?.addEventListener("abort", onOuter, { once: true });
    const timer = setTimeout(() => ctl.abort(new Error(`MCP 请求超时(${REQUEST_TIMEOUT_MS / 1000}s)`)), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: ctl.signal });
    } catch (e) {
      // 网络层失败:缺目标域授权时 SW fetch 表现为 CORS 的 TypeError
      // ("Failed to fetch"),与服务器宕机不可辨,给方向性指引而非裸报错。
      // 超时/取消走 abort(reason) 路径,不是 TypeError,不受影响
      if (e instanceof TypeError) {
        const origin = (() => {
          try {
            return new URL(url).origin;
          } catch {
            return url;
          }
        })();
        throw new Error(
          `无法连接 MCP 服务器(${origin}):网络不可达,或尚未获得该域的访问授权(设置 → 安全 →「页面与网络访问」)`,
        );
      }
      throw e;
    } finally {
      clearTimeout(timer);
      // outer 的取消监听刻意不摘:60s 超时只护到响应头,响应头之后的
      // 流式消费阶段(SSE)用户取消 run 仍要能打断在途读 —— 靠这条监听
      // 把 outer 的 abort 传进 body 流。once 监听,abort 触发后自净
    }
  }
}

// ---- 响应解析 ----

class McpHttpStatusError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function snippet(text: string): string {
  const t = text.trim().replace(/\s+/g, " ").slice(0, 160);
  return t ? `: ${t}` : "";
}

/** 单 JSON 响应:校验 id 配对;JSON-RPC 错误转 McpRpcError */
async function parseJsonResponse(res: Response, id: number): Promise<unknown> {
  const msg = (await res.json().catch(() => null)) as
    | { id?: unknown; result?: unknown; error?: { code: number; message: string } }
    | null;
  if (!msg || typeof msg !== "object") {
    throw new Error("MCP server returned an unparseable response");
  }
  if (msg.error) throw new McpRpcError(msg.error.code, msg.error.message);
  if (msg.id !== id) throw new Error("MCP response id mismatch");
  return msg.result;
}

/**
 * 请求作用域 SSE 流:逐事件收集,直到本请求的最终响应。
 * - 帧解析与停滞看门狗走共享 readSSE(CRLF 归一、多行 data、120s 无字节
 *   看门狗 —— 响应头已到但流停滞的假死连接不该挂死整个 run)
 * - notifications/progress 等通知忽略
 * - 服务器发来的 JSON-RPC 请求(sampling)不响应 —— 见文件头「明确不支持」
 * - finally 里 cancel reader:提前返回(拿到响应)时即向服务器发出取消信号
 */
async function readSseResponse(
  res: Response,
  id: number,
  signal?: AbortSignal,
): Promise<unknown> {
  if (!res.body) throw new Error("MCP response has no body");
  type SseMsg = {
    id?: unknown;
    result?: unknown;
    error?: { code: number; message: string };
    method?: string;
  };
  for await (const msg of readSSE<SseMsg>(res)) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    if (msg.id === id) {
      if (msg.error) throw new McpRpcError(msg.error.code, msg.error.message);
      return msg.result;
    }
    if (msg.method) {
      log.debug("mcp", "忽略服务器消息(流上通知/请求)", { method: msg.method });
    }
  }
  throw new Error("MCP stream ended before a response arrived");
}

/**
 * 头值编码:HTTP 头只容可见 ASCII;含非 ASCII / 控制字符 / 首尾空白的值按
 * 规范的 base64 哨兵格式传输(=?base64?...?=),纯 ASCII 原样。
 * base64 走 imageCodec 的分块实现 —— 整段 String.fromCharCode 展开在超长
 * 参数(模型可能填数十万字符)上会触发参数上限 RangeError
 */
export function encodeHeaderValue(v: string): string {
  // \x20/\x09 是 RFC 5322 允许的裸字符,刻意保留
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 编码前探测,控制字符是允许集的一部分
  if (/^[\x21-\x7e\x20\x09]*$/.test(v) && v === v.trim()) return v;
  const b64 = bytesToBase64(new TextEncoder().encode(v));
  return `=?base64?${b64}?=`;
}
