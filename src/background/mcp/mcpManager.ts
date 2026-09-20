// MCP 聚合层 —— 把 N 台服务器的工具清单汇成 agent 可用的动态工具注册表。
// 职责:连接缓存与失效、跨服务器工具命名空间(wire 名唯一)、schema 投影、
// tools/call 执行与结果规整。传输细节在 mcpClient.ts,注册表与静态工具的
// 并接在 tools.ts / agent.ts。
//
// 关键取舍:
// - **连接按需建立,TTL 缓存**:agent 每个 run 开始取一次 schema(5 分钟
//   内复用),设置页「测试连接/工具清单」走同一缓存 —— UI 操作顺带预热,
//   下次 run 零等待。SW 被杀后缓存整体消失,下个 run 惰性重连(现代服务器
//   无状态、旧版服务器重握手,都无需持久化任何连接状态)
// - **失败隔离按服务器**:一台连不上只影响它自己的工具,其余照常注入,
//   错误汇总返回给调用方(agent 记日志 / 设置页展示),绝不拖垮整个 run
// - **结果规整**:MCP 的 content 块数组压成纯文本进 tool 消息;isError 的
//   结果 throw 出带原文的 Error —— 与 memory_delete 无匹配同款,让模型
//   自己读错误换路走,不中断 agent
// - MRTR(InputRequiredResult,服务器要采样/追问):V1 明确不支持,直接
//   报错让模型换路;不静默吞 —— 模型需要知道这条路走不通

import type { ToolSchema } from "../../shared/toolTypes";
import type { Tool } from "../tools/tools";
import type { McpConfig, McpServerEntry } from "../../shared/mcp";
import { MCP_TOOL_PREFIX, mcpWireName, sanitizeWirePart } from "../../shared/mcp";
import { createLogger } from "../../shared/logger";
import { errText } from "../../shared/errors";
import { hostOf } from "../../shared/url";
import { getToolExecutionContext } from "../tools/toolContext";
import { McpClient, encodeHeaderValue } from "./mcpClient";

const log = createLogger({ ctx: "bg" });

/** 工具清单缓存 TTL:同一次 run 内零重复请求;跨 run 5 分钟内复用 */
const TOOLS_TTL_MS = 5 * 60 * 1000;

/** description 上限:OpenAI 兼容端点普遍 1024,超限截断(尾部留省略标记) */
const MAX_DESCRIPTION_CHARS = 1024;

/** UI/日志共用的工具信息(不含 schema 全文,面板不需要) */
export interface McpToolInfo {
  name: string;
  description: string;
}

interface CacheEntry {
  /** 端点指纹:变了(改 URL/换头)就整体重建,防止旧凭据继续用 */
  fingerprint: string;
  client: McpClient;
  /** tools/list 的完整结果:schema 留在缓存里(注册 schema 时要用),
   *  McpToolInfo 只是它的 UI 投影 */
  tools: (McpToolInfo & { schema: ToolSchema["parameters"] })[];
  /** 服务器 key(wire 名前缀,跨服务器唯一) */
  serverKey: string;
  fetchedAt: number;
}

/** wire 名 → 注册记录(每次 schema 刷新整体重建) */
interface McpToolRecord {
  /** wire 名(注入给模型的 function 名) */
  name: string;
  /** 服务器侧的工具原名(tools/call 的 params.name 用它,不是 wire 名) */
  toolName: string;
  description: string;
  serverId: string;
  serverName: string;
  schema: ToolSchema["parameters"];
  headerParams: { path: string[]; header: string }[];
}

const cache = new Map<string, CacheEntry>();
const registry = new Map<string, McpToolRecord>();

// ---- 对 agent / tools.ts 的出口 ----

/** MCP 工具查找(同步):run 开始时 schema 已刷新,registry 必是热的;
 *  查不到 = 模型幻觉出工具名,返回 undefined 让上层报 unknown tool */
export function getMcpTool(name: string): Tool | undefined {
  const rec = registry.get(name);
  if (!rec) return undefined;
  return {
    type: "function",
    name: rec.name,
    displayName: `${rec.serverName} · ${rec.toolName}`,
    description: rec.description,
    parameters: rec.schema,
    execute: (args: unknown) => callTool(rec, args),
  } as unknown as Tool;
}

/** 拉取全部启用服务器的工具 schema。返回 schemas(并入 agent 的 tools)
 *  与 errors(每台失败服务器的 {server, error},调用方决定怎么呈现) */
export async function getMcpToolSchemas(mcp: McpConfig): Promise<{
  schemas: ToolSchema[];
  errors: { server: string; error: string }[];
}> {
  const enabled = mcp.servers.filter((s) => s.enabled && s.url.trim());
  const settled = await Promise.allSettled(
    enabled.map((s) => refreshServer(s)),
  );
  const schemas: ToolSchema[] = [];
  const errors: { server: string; error: string }[] = [];
  // 重建注册表:registry 只反映「本轮刷新看到的工具」——服务器被禁用/删除
  // 后其工具立刻不可调,即使缓存条目还留着
  registry.clear();
  const usedKeys = new Set<string>();
  enabled.forEach((server, i) => {
    const out = settled[i];
    const label = server.name || hostOf(server.url) || server.id;
    if (out.status === "rejected") {
      errors.push({ server: label, error: String(out.reason?.message ?? out.reason) });
      return;
    }
    const entry = out.value;
    // 服务器 key 唯一化:同名自动加序号(wire 名空间按服务器隔离的根基)
    let key = entry.serverKey;
    for (let n = 2; usedKeys.has(key); n++) key = `${entry.serverKey}_${n}`;
    usedKeys.add(key);
    entry.serverKey = key;

    for (const info of entry.tools) {
      const rec = buildRecord(server, label, key, info);
      if (registry.has(rec.name)) {
        log.warn("mcp", "工具 wire 名冲突,丢弃后者", { name: rec.name });
        continue;
      }
      registry.set(rec.name, rec);
      schemas.push({
        type: "function",
        name: rec.name,
        description: rec.description,
        parameters: rec.schema,
      });
    }
  });
  return { schemas, errors };
}

// 缓存失效两条路:端点指纹(名称/URL/请求头)变化即整体重建 + 5 分钟 TTL。
// 删除服务器的残留条目按 id 键永远不再命中,留着无害 —— 不需要显式 reset。

// ---- 服务器级:连接 + tools/list ----

async function refreshServer(server: McpServerEntry): Promise<CacheEntry> {
  // 指纹含 name:改名会改服务器 key(wire 名前缀),缓存必须跟着重建
  const fingerprint = `${server.name}|${server.url}|${JSON.stringify(server.headers)}`;
  const hit = cache.get(server.id);
  if (
    hit &&
    hit.fingerprint === fingerprint &&
    Date.now() - hit.fetchedAt < TOOLS_TTL_MS
  ) {
    return hit;
  }
  const client = new McpClient(
    { url: server.url.trim(), headers: server.headers },
    server.name || hostOf(server.url),
  );
  const result = (await client.request("tools/list", {})) as {
    tools?: {
      name: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
    }[];
  };
  const entry: CacheEntry = {
    fingerprint,
    client,
    tools: (result.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? "",
      schema: normalizeInputSchema(t.inputSchema),
    })),
    serverKey: sanitizeWirePart(server.name) || hostKey(server.url),
    fetchedAt: Date.now(),
  };
  cache.set(server.id, entry);
  log.info("mcp", `${entry.serverKey} 工具清单已刷新`, {
    era: client.eraLabel,
    tools: entry.tools.length,
    names: entry.tools.map((t) => t.name),
  });
  return entry;
}

/** 服务器没命名时的 key 兜底:主机名(端口号保留,防同主机不同端口互撞) */
function hostKey(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname + (u.port ? `_${u.port}` : "");
  } catch {
    return "srv";
  }
}

/** inputSchema → ToolSchema.parameters:保证 type=object/properties 在场
 *  (部分服务器的 schema 缺这两个字段,OpenAI 兼容端点会拒收) */
function normalizeInputSchema(
  raw: Record<string, unknown> | undefined,
): ToolSchema["parameters"] {
  const s = (raw ?? {}) as Record<string, unknown>;
  return {
    type: "object",
    properties:
      s.properties && typeof s.properties === "object"
        ? (s.properties as Record<string, unknown>)
        : {},
    ...(Array.isArray(s.required) ? { required: s.required as string[] } : {}),
  };
}

function buildRecord(
  server: McpServerEntry,
  label: string,
  serverKey: string,
  info: CacheEntry["tools"][number],
): McpToolRecord {
  const wire = mcpWireName(serverKey, info.name);
  if (!wire.startsWith(MCP_TOOL_PREFIX) || wire === info.name) {
    // 理论不可达:wire 名恒以 mcp_ 开头;断言防未来改动破坏命名空间
    throw new Error(`MCP 工具 wire 名异常: ${wire}`);
  }
  let description = info.description;
  if (description.length > MAX_DESCRIPTION_CHARS) {
    description = `${description.slice(0, MAX_DESCRIPTION_CHARS - 3)}...`;
    log.warn("mcp", "工具 description 超限截断", { tool: info.name });
  }
  const schema = info.schema;
  return {
    name: wire,
    toolName: info.name,
    serverId: server.id,
    serverName: label,
    description,
    schema,
    headerParams: collectHeaderParams(schema.properties),
  };
}

// ---- 执行:tools/call ----

async function callTool(rec: McpToolRecord, args: unknown): Promise<string> {
  const client = cache.get(rec.serverId)?.client;
  if (!client) throw new Error("MCP server connection went stale; retry (or use Test connection in Settings)");
  const a = (args ?? {}) as Record<string, unknown>;
  const extraHeaders: Record<string, string> = {};
  for (const { path, header } of rec.headerParams) {
    const v = valueAtPath(a, path);
    if (v === undefined || v === null) continue; // 缺参省略头,规范同款
    // 头名来自服务器 schema 的 x-mcp-header 注解(外部输入):非法 token
    // 字符会让 fetch 抛 TypeError,被误译成「网络不可达」误导排查 —— 跳过
    // 并留日志,不让单个坏注解炸掉整次调用
    const headerName = `Mcp-Param-${header}`;
    if (!isHttpToken(headerName)) {
      log.warn("mcp", "x-mcp-header 注解含非法头名字符,已跳过", {
        tool: rec.toolName,
        header: header.slice(0, 40),
      });
      continue;
    }
    extraHeaders[headerName] = encodeHeaderValue(primitiveToString(v));
  }
  const result = (await client.request(
    "tools/call",
    { name: rec.toolName, arguments: a },
    {
      wireName: rec.name,
      extraHeaders,
      signal: getToolExecutionContext()?.signal,
    },
  )) as {
    content?: { type: string; text?: string; data?: string; mimeType?: string; resource?: { text?: string } }[];
    structuredContent?: unknown;
    isError?: boolean;
    inputRequests?: unknown[];
  };
  if (Array.isArray(result.inputRequests) && result.inputRequests.length > 0) {
    throw new Error(
      "该 MCP 服务器请求额外交互(用户输入或模型采样),当前版本不支持;请换用其他工具或直接告知用户",
    );
  }
  const text = contentToText(result);
  // isError 的错误原文同样要有预算上限:服务器可返回任意体量的文本,
  // 它会作为工具错误整段进模型上下文(与硬预算纪律一致,头部保留 + 注记体量)
  if (result.isError) {
    throw new Error(
      capToolText(text) || "MCP 工具执行失败(服务器未给出原因)",
    );
  }
  return capToolText(text) || "(工具执行成功,无文本结果)";
}

/** MCP 工具结果文本上限:超出截断并注记体量 */
const RESULT_TEXT_MAX_CHARS = 20_000;

function capToolText(text: string): string {
  return text.length > RESULT_TEXT_MAX_CHARS
    ? `${text.slice(0, RESULT_TEXT_MAX_CHARS)}\n[MCP tool result truncated: ${text.length} chars in total]`
    : text;
}

/** RFC 7230 token 字符集(头名合法性) */
function isHttpToken(name: string): boolean {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name);
}

/** content 块数组 → 纯文本:文本直取,图片/资源给占位说明(V1 不投喂二进制) */
function contentToText(result: {
  content?: { type: string; text?: string; data?: string; mimeType?: string; resource?: { text?: string } }[];
  structuredContent?: unknown;
}): string {
  const parts: string[] = [];
  for (const block of result.content ?? []) {
    if (block.type === "text" && block.text) parts.push(block.text);
    else if (block.type === "image") {
      parts.push(`[图片结果(${block.mimeType ?? "未知格式"})未展示:当前版本不消费 MCP 工具返回的图片]`);
    } else if (block.type === "resource") {
      const t = block.resource?.text;
      if (t) parts.push(t);
      else parts.push("[资源结果未展示:非文本资源]");
    } else {
      parts.push(`[未支持的内容块: ${block.type}]`);
    }
  }
  // 有些实现只回 structuredContent;压成 JSON 给模型兜底
  if (parts.length === 0 && result.structuredContent !== undefined) {
    try {
      return JSON.stringify(result.structuredContent);
    } catch {
      return String(result.structuredContent);
    }
  }
  return parts.join("\n");
}

// ---- x-mcp-header:参数镜像为请求头(2026-07-28 规范要求客户端必须支持) ----

/** 收集 schema 里带 x-mcp-header 注解的参数;只走 properties 链(规范的
 *  静态可达限制:不经数组/组合关键字/$ref) */
function collectHeaderParams(
  properties: Record<string, unknown>,
): { path: string[]; header: string }[] {
  const out: { path: string[]; header: string }[] = [];
  const walk = (props: Record<string, unknown>, path: string[]) => {
    for (const [key, node] of Object.entries(props)) {
      if (!node || typeof node !== "object") continue;
      const p = [...path, key];
      const header = (node as Record<string, unknown>)["x-mcp-header"];
      if (typeof header === "string" && header) out.push({ path: p, header });
      const nested = (node as Record<string, unknown>).properties;
      if (nested && typeof nested === "object") {
        walk(nested as Record<string, unknown>, p);
      }
    }
  };
  walk(properties, []);
  return out;
}

function valueAtPath(obj: Record<string, unknown>, path: string[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

function primitiveToString(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

// ---- 设置页出口:测试连接 / 工具清单(同一条缓存,UI 操作即预热) ----

export async function testServer(
  server: McpServerEntry,
): Promise<{ ok: boolean; toolCount?: number; era?: string; error?: string }> {
  try {
    const entry = await refreshServer(server);
    return { ok: true, toolCount: entry.tools.length, era: entry.client.eraLabel };
  } catch (err) {
    return { ok: false, error: errText(err) };
  }
}

export async function listServerTools(
  server: McpServerEntry,
): Promise<McpToolInfo[]> {
  const entry = await refreshServer(server);
  return entry.tools;
}
