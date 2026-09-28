// MCP 接入的纯函数层(shared):配置形状、宽松归一、导入解析、工具 wire 命名。
// 面板(设置页)与后台(mcpManager)共用;与 shared/memory.ts 同款分工 ——
// 刻意不含任何存储/网络依赖,面板不可 import background/*。

/**
 * 一台 MCP 服务器(V1 仅远程 Streamable HTTP 端点):
 * - 本地 stdio 服务器需要起子进程,MV3 Service Worker 做不到,不做
 * - 本地 HTTP 服务器(如 Figma 桌面端的 Dev Mode MCP,127.0.0.1:3845)属于
 *   远程 HTTP 形态,天然支持
 * - headers 存静态请求头(Bearer 令牌等),与 BYOK 的 Key 同纪律:只存 local
 */
export interface McpServerEntry {
  /** 稳定引用(随机生成),服务器 key 分配与设置页编辑都用它 */
  id: string;
  /** 显示名(如 GitHub);留空时 UI 用 URL 主机名兜底展示 */
  name: string;
  /** MCP 端点 URL(如 https://api.githubcopilot.com/mcp) */
  url: string;
  /** 静态请求头,随每次请求发送;UI 按「名称: 值」逐行编辑 */
  headers: Record<string, string>;
  /** 服务器级开关:关 = 本服务器不连接、其工具不进 schema(默认关,新加即启用) */
  enabled: boolean;
  /** 禁用的工具名(服务器侧原名,**不是** wire 名 —— wire 名随服务器改名
   *  漂移,toolName 才是跨改名稳定的键)。缺省/空 = 全启用 */
  disabledTools?: string[];
  /** 单请求超时毫秒(含 tools/list 与 tools/call);缺省用客户端内置默认。
   *  归一收窄到 [MCP_TIMEOUT_MIN_MS, MCP_TIMEOUT_MAX_MS] */
  timeoutMs?: number;
}

/** MCP 总配置:总开关关闭 = 不连接任何服务器、不注册任何 mcp_ 工具 */
export interface McpConfig {
  enabled: boolean;
  servers: McpServerEntry[];
}

/** 超时可选范围与缺省值:下界防手滑 0(请求即超时),上界防把 run 挂死 */
export const MCP_TIMEOUT_MIN_MS = 5_000;
export const MCP_TIMEOUT_MAX_MS = 600_000;
export const MCP_TIMEOUT_DEFAULT_MS = 60_000;

/** 超时收窄到合法区间(取整);非法输入回落缺省 */
export function clampMcpTimeoutMs(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : MCP_TIMEOUT_DEFAULT_MS;
  return Math.min(MCP_TIMEOUT_MAX_MS, Math.max(MCP_TIMEOUT_MIN_MS, n));
}

/** 宽松归一:字段类型不对的丢弃/回默认值。新字段缺省 = 关(与联网开关同款,
 *  显式打开才对模型可用 —— MCP 会把请求内容发给第三方服务器,默认关符合
 *  BYOK「数据不出本机」的承诺,启用是用户的显式决定) */
export function normalizeMcp(v: unknown): McpConfig {
  const raw = (v ?? {}) as Partial<McpConfig> & { servers?: unknown };
  const servers: McpServerEntry[] = Array.isArray(raw.servers)
    ? raw.servers
        .filter(
          (s): s is McpServerEntry =>
            !!s && typeof s === "object" && typeof s.id === "string",
        )
        .map((s) => ({
          id: s.id,
          name: typeof s.name === "string" ? s.name : "",
          url: typeof s.url === "string" ? s.url : "",
          headers: normalizeHeaders(s.headers),
          enabled: s.enabled === true,
          disabledTools: normalizeDisabledTools(s.disabledTools),
          timeoutMs:
            typeof s.timeoutMs === "number" && Number.isFinite(s.timeoutMs)
              ? clampMcpTimeoutMs(s.timeoutMs)
              : undefined,
        }))
    : [];
  return { enabled: raw.enabled === true, servers };
}

/** 请求头宽松归一:非字符串键值的行丢弃,值 trim */
function normalizeHeaders(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!v || typeof v !== "object") return out;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof k === "string" && k.trim() && typeof val === "string") {
      out[k.trim()] = val.trim();
    }
  }
  return out;
}

/** 禁用工具清单归一:只留非空字符串,空集收敛为 undefined(全启用) */
function normalizeDisabledTools(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string" && !!x);
  return out.length > 0 ? out : undefined;
}

// ---- 粘贴导入:社区流传的 JSON 配置 → 服务器条目 ----

/** 导入解析结果:entries 不带 id(调用方用 crypto.randomUUID 补,便于
 *  本函数保持纯函数、测试不依赖 crypto);skipped 是因缺合法 URL 被跳过
 *  的条目数(多为 stdio 形态,当前传输层不支持) */
export interface ParsedMcpImport {
  entries: Omit<McpServerEntry, "id">[];
  skipped: number;
}

/** 认可四种形态:单台对象、台对象数组、TARS 全量/部分配置(servers 键)、
 *  Claude Desktop 风格(mcpServers 键,stdio 条目无 url 会被跳过)。
 *  只收 http(s) URL —— 与 grantableOriginOf 的可授权域口径一致 */
export function parseMcpImport(v: unknown): ParsedMcpImport {
  const raw = (v ?? {}) as Record<string, unknown>;
  let list: unknown[] = [];
  let skipped = 0;
  if (Array.isArray(v)) {
    list = v;
  } else if (Array.isArray(raw.servers)) {
    list = raw.servers;
  } else if (raw.mcpServers && typeof raw.mcpServers === "object") {
    list = Object.entries(raw.mcpServers as Record<string, unknown>).map(
      ([name, cfg]) => ({ name, ...(cfg as Record<string, unknown>) }),
    );
  } else if (typeof v === "object" && v !== null) {
    // 单台对象(含只有 command 的 stdio 条目):统一按一次导入尝试处理,
    // 缺合法 URL 走循环里的 skipped 计数
    list = [v];
  }
  const entries: Omit<McpServerEntry, "id">[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") {
      skipped += 1;
      continue;
    }
    const s = item as Record<string, unknown>;
    const url = typeof s.url === "string" ? s.url.trim() : "";
    if (!isHttpUrl(url)) {
      skipped += 1;
      continue;
    }
    entries.push({
      name: typeof s.name === "string" ? s.name : "",
      url,
      headers: normalizeHeaders(s.headers),
      enabled: true,
    });
  }
  return { entries, skipped };
}

function isHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// ---- 工具 wire 命名 ----
// MCP 工具名进 function calling 要过 OpenAI 兼容端点的名字校验
// ^[a-zA-Z0-9_-]{1,64}$,且要防不同服务器同名工具互撞、防遮蔽内置工具。

/** 内置工具永不以此开头(mcp_ 前缀天然隔离,注册侧还有断言兜底) */
export const MCP_TOOL_PREFIX = "mcp_";

/** 非法字符折叠为下划线;连续下划线不压缩(无伤大雅,保持可读) */
export function sanitizeWirePart(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** 确定性短哈希(base36):超长名截断后接在尾部防不同工具截断后同名 */
function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** 工具的 wire 名:mcp_{服务器key}_{工具名}。服务器 key 由 mcpManager 保证
 *  跨服务器唯一(同名自动加序号);超 64 字符截断并接短哈希 */
export function mcpWireName(serverKey: string, toolName: string): string {
  const s = sanitizeWirePart(serverKey) || "srv";
  const t = sanitizeWirePart(toolName) || "tool";
  const full = `mcp_${s}_${t}`;
  if (full.length <= 64) return full;
  const h = shortHash(`${s}__${t}`);
  return `${full.slice(0, 64 - 1 - h.length)}_${h}`;
}
