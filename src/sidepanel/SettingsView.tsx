// 设置整页 —— 分组堆叠表单(标签在上、控件全宽),改动即自动保存:
// 开关/分段即时落盘,文本输入失焦落盘;顶部「已保存」轻反馈,失败显示红色提示

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { McpConfig, McpServerEntry } from "../shared/mcp";
import {
  loadConfig,
  savePrefs,
  COMPACT_LEVELS,
  SEARCH_PROVIDER_IDS,
  type AccentPref,
  type CompactLevel,
  type ModelEntry,
  type ProviderEntry,
  type SearchConfig,
  type SearchProviderSetting,
  type SearchServiceEntry,
  type ThemePref,
} from "../shared/configStore";
import { estimateTokens, memoryUsedTokens } from "../shared/memory";
import { fetchModels } from "../background/provider";
import { clearAllLogs, readAllLogEntries, toJsonl } from "../shared/logger";
import { applyThemePreference, applyAccent } from "./theme";
import {
  MSG,
  PORT_NAME,
  type McpToolInfo,
  type MemoryItem,
} from "../shared/messages";
import { memReq } from "./memoryClient";
import { t } from "../shared/i18n";
import { mcpListTools, mcpTest } from "./mcpClient";

/** 官方端点兜底(Base URL 留空时),与 openai.ts 适配器的默认一致 */
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/** 键一律写字面量(禁止动态拼键):动态拼键会绕过 check-i18n 的静态扫描 */
const THEME_OPTIONS: { value: ThemePref; label: string }[] = [
  { value: "system", label: t("settings.themeSystem") },
  { value: "light", label: t("settings.themeLight") },
  { value: "dark", label: t("settings.themeDark") },
];

/** 历史保留期分段选项:值为天数,0 = 不自动清理 */
const RETENTION_OPTIONS: { value: "7" | "30" | "0"; label: string }[] = [
  { value: "7", label: t("settings.retention7") },
  { value: "30", label: t("settings.retention30") },
  { value: "0", label: t("settings.retentionAll") },
];

type FetchState = "idle" | "loading" | "error";

/** 重点色候选:与 scripts/generate-m3.mjs 的 ACCENTS 一一对应;键映射
 *  写字面量,不做动态拼键(动态拼键会绕过 check-i18n 静态扫描) */
const ACCENT_LABEL_KEYS: Record<AccentPref, string> = {
  green: "settings.accentGreen",
  ocean: "settings.accentOcean",
  teal: "settings.accentTeal",
  indigo: "settings.accentIndigo",
  lilac: "settings.accentLilac",
  coral: "settings.accentCoral",
  rose: "settings.accentRose",
  graphite: "settings.accentGraphite",
};
const ACCENT_OPTIONS: { value: AccentPref; label: string; color: string }[] = (
  [
    ["green", "#16a34a"],
    ["ocean", "#0b57d0"],
    ["teal", "#0d9488"],
    ["indigo", "#4f46e5"],
    ["lilac", "#6750a4"],
    ["coral", "#ea580c"],
    ["rose", "#e11d48"],
    ["graphite", "#5f6368"],
  ] as const
).map(([value, color]) => ({
  value: value as AccentPref,
  label: t(ACCENT_LABEL_KEYS[value]),
  color,
}));

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** M3 分段按钮(connected button group):选中段填 secondaryContainer,勾号由 CSS 提供 */
function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="segmented">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          data-v={o.value}
          className={value === o.value ? "selected" : ""}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** 模型行:收起态 = 别名/ID + 默认标记 + chevron,点击展开每模型配置 */
function ModelRow({
  entry,
  isDefault,
  open,
  confirming,
  onToggle,
  onPatch,
  onCommit,
  onSetDefault,
  onRemove,
}: {
  entry: ModelEntry;
  isDefault: boolean;
  open: boolean;
  confirming: boolean;
  onToggle: () => void;
  onPatch: (patch: Partial<ModelEntry>, save?: boolean) => void;
  onCommit: () => void;
  onSetDefault: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="model-row">
      <button
        type="button"
        className="model-row-head"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="model-row-name">{entry.alias || entry.id}</span>
        {isDefault && <span className="model-badge">默认</span>}
        <svg
          className="model-row-chevron"
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m6 3 5 5-5 5" />
        </svg>
      </button>
      <div className="model-row-body" data-open={open}>
        <div className="model-row-body-inner">
          {entry.alias && <p className="model-row-id">{entry.id}</p>}
          <label className="field-label" htmlFor={`model-alias-${entry.id}`}>
            {t("settings.alias")}<span className="font-normal text-on-surface-variant">{t("common.optional")}</span>
          </label>
          <input
            id={`model-alias-${entry.id}`}
            type="text"
            value={entry.alias ?? ""}
            onChange={(e) => onPatch({ alias: e.target.value })}
            onBlur={onCommit}
            placeholder={t("settings.aliasPlaceholder")}
            autoComplete="off"
            spellCheck={false}
            className="field-input"
          />
          <div className="mt-2.5 flex items-center justify-between">
            <span className="text-[12.5px] font-medium text-on-surface">{t("settings.vision")}</span>
            <button
              type="button"
              role="switch"
              aria-checked={!!entry.vision}
              aria-label={`${entry.alias || entry.id} ${t("settings.vision")}`}
              onClick={() => onPatch({ vision: !entry.vision }, true)}
              className="switch"
            >
              <span className="switch-knob" />
            </button>
          </div>
          <div className="mt-1 grid grid-cols-2 gap-2">
            <div>
              <label className="field-label" htmlFor={`model-ctx-${entry.id}`}>
                {t("settings.contextTokens")}
              </label>
              <input
                id={`model-ctx-${entry.id}`}
                type="number"
                value={entry.contextTokens || ""}
                onChange={(e) =>
                  onPatch({ contextTokens: Number(e.target.value) || 0 })
                }
                onBlur={onCommit}
                placeholder={t("settings.ctxPlaceholder")}
                autoComplete="off"
                className="field-input font-mono"
              />
            </div>
            <div>
              <label className="field-label" htmlFor={`model-max-${entry.id}`}>
                {t("settings.maxTokens")}
              </label>
              <input
                id={`model-max-${entry.id}`}
                type="number"
                value={entry.maxTokens || ""}
                onChange={(e) =>
                  onPatch({ maxTokens: Number(e.target.value) || 0 })
                }
                onBlur={onCommit}
                placeholder={t("settings.maxPlaceholder")}
                autoComplete="off"
                className="field-input font-mono"
              />
            </div>
          </div>
          <div className="mt-1">
            <label
              className="field-label"
              htmlFor={`model-mtf-${entry.id}`}
            >
              {t("settings.maxTokensField")}
            </label>
            <select
              id={`model-mtf-${entry.id}`}
              value={entry.maxTokensField ?? ""}
              onChange={(e) =>
                onPatch(
                  {
                    maxTokensField: (e.target.value ||
                      undefined) as ModelEntry["maxTokensField"],
                  },
                  true,
                )
              }
              className="field-input"
            >
              <option value="">{t("settings.maxTokensAuto")}</option>
              <option value="max_tokens">{t("settings.maxTokensCompat")}</option>
              <option value="max_completion_tokens">
                {t("settings.maxTokensReasoning")}
              </option>
            </select>
          </div>
          <div className="mb-1 mt-2 flex items-center gap-3">
            {!isDefault && (
              <button
                type="button"
                className="model-row-action"
                onClick={onSetDefault}
              >
                {t("settings.setDefault")}
              </button>
            )}
            <button
              type="button"
              className={`model-row-action model-row-action-danger${
                confirming ? " confirming" : ""
              }`}
              onClick={onRemove}
            >
              {confirming ? t("common.confirmDelete") : t("common.delete")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** baseUrl → 主机名(供应商未命名时的展示兜底) */
const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};

/** 请求头对象 ↔ 文本(每行「名称: 值」;无冒号的行丢弃) */
const headersToText = (h: Record<string, string>): string =>
  Object.entries(h)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
const textToHeaders = (t: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of t.split("\n")) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return out;
};

/** MCP 服务器卡片:收起态 = 名称/主机 + 工具数;展开 = 端点/请求头/测试连接/
 *  工具清单。字段编辑沿用「失焦落盘」模式 */
function McpServerCard({
  entry,
  open,
  confirming,
  onToggle,
  onPatch,
  onCommit,
  onRemove,
}: {
  entry: McpServerEntry;
  open: boolean;
  confirming: boolean;
  onToggle: () => void;
  onPatch: (patch: Partial<McpServerEntry>, save?: boolean) => void;
  onCommit: () => void;
  onRemove: () => void;
}) {
  const [testState, setTestState] = useState<"idle" | "loading" | "done">("idle");
  const [testMsg, setTestMsg] = useState("");
  const [testOk, setTestOk] = useState(false);
  const [tools, setTools] = useState<McpToolInfo[] | null>(null);
  const [toolsLoading, setToolsLoading] = useState(false);
  const [toolsError, setToolsError] = useState("");
  const [headersText, setHeadersText] = useState(headersToText(entry.headers));

  const displayName = entry.name || hostOf(entry.url) || t("settings.serverUnnamed");
  /** headers 逐行编辑、失焦整包提交,序列化后作依赖:提交才触发重拉 */
  const headersKey = JSON.stringify(entry.headers);

  // 端点或鉴权头变了,上一次的连接测试结果就不再成立,静默复位
  useEffect(() => {
    setTestState("idle");
    setTestMsg("");
  }, [entry.url, headersKey]);

  // 展开时拉工具清单(与「测试连接」同一条后台缓存,成功即预热下次 run);
  // url 或请求头变了就重拉。失败只标注在工具清单区,不挡其他字段的编辑
  useEffect(() => {
    if (!open || !entry.url.trim()) {
      setToolsLoading(false);
      setToolsError("");
      return;
    }
    let alive = true;
    setToolsLoading(true);
    setToolsError("");
    mcpListTools(entry)
      .then((t) => {
        if (alive) {
          setTools(t);
          setToolsLoading(false);
        }
      })
      .catch((e) => {
        if (alive) {
          setTools(null);
          setToolsError(e instanceof Error ? e.message : String(e));
          setToolsLoading(false);
        }
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, entry.url, headersKey]);

  const runTest = async () => {
    if (testState === "loading") return;
    setTestState("loading");
    const r = await mcpTest(entry).catch(
      (e): { ok: boolean; toolCount?: number; era?: string; error?: string } => ({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
    setTestState("done");
    setTestOk(r.ok);
    setTestMsg(
      r.ok
        ? t("settings.testOk", { n: r.toolCount ?? 0, era: r.era ?? "" })
        : r.error ?? t("settings.testFailed"),
    );
  };

  const toolsTokens =
    tools?.reduce(
      (n, t) => n + estimateTokens(`${t.name}${t.description}`),
      0,
    ) ?? 0;

  return (
    <div className="model-row">
      <button
        type="button"
        className="model-row-head"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="min-w-0 truncate">
          <span className="model-row-name">{displayName}</span>
          {!entry.enabled && <span className="model-badge">{t("common.disabled")}</span>}
        </span>
        <span className="ml-auto shrink-0 pr-1 text-[11px] text-on-surface-variant">
          {tools?.length != null ? t("settings.toolCount", { n: tools.length }) : hostOf(entry.url)}
        </span>
        <svg
          className="model-row-chevron"
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m6 3 5 5-5 5" />
        </svg>
      </button>
      <div className="model-row-body" data-open={open}>
        <div className="model-row-body-inner">
          <div className="flex items-center justify-between">
            <span className="settings-row-label">{t("common.enabled")}</span>
            <button
              type="button"
              role="switch"
              aria-checked={entry.enabled}
              aria-label={`${displayName} ${t("common.enabled")}`}
              onClick={() => onPatch({ enabled: !entry.enabled }, true)}
              className="switch"
            >
              <span className="switch-knob" />
            </button>
          </div>
          <div className="settings-field">
            <label className="field-label" htmlFor={`mcp-name-${entry.id}`}>
              {t("settings.serverName")}<span className="font-normal text-on-surface-variant">{t("common.optional")}</span>
            </label>
            <input
              id={`mcp-name-${entry.id}`}
              type="text"
              value={entry.name}
              onChange={(e) => onPatch({ name: e.target.value })}
              onBlur={onCommit}
              placeholder={t("settings.serverNamePlaceholder")}
              autoComplete="off"
              spellCheck={false}
              className="field-input"
            />
          </div>
          <div className="settings-field">
            <label className="field-label" htmlFor={`mcp-url-${entry.id}`}>
              {t("settings.serverUrl")}
            </label>
            <input
              id={`mcp-url-${entry.id}`}
              type="text"
              value={entry.url}
              onChange={(e) => onPatch({ url: e.target.value }, false)}
              onBlur={(e) => onPatch({ url: e.target.value.trim() }, true)}
              placeholder={t("settings.serverUrlPlaceholder")}
              autoComplete="off"
              spellCheck={false}
              className="field-input font-mono"
            />
            <p className="field-hint">
              {t("settings.serverUrlHint")}
            </p>
          </div>
          <div className="settings-field">
            <label className="field-label" htmlFor={`mcp-headers-${entry.id}`}>
              {t("settings.headers")}<span className="font-normal text-on-surface-variant">{t("common.optional")}</span>
            </label>
            <textarea
              id={`mcp-headers-${entry.id}`}
              value={headersText}
              onChange={(e) => setHeadersText(e.target.value)}
              onBlur={() => {
                onPatch({ headers: textToHeaders(headersText) }, true);
              }}
              placeholder={"Authorization: Bearer ghp_…\nx-api-key: …"}
              rows={2}
              autoComplete="off"
              spellCheck={false}
              className="field-input font-mono"
            />
            <p className="field-hint">
              {t("settings.headersHint")}
            </p>
          </div>

          <div className="mb-1 flex items-center gap-2">
            <button
              type="button"
              onClick={runTest}
              disabled={testState === "loading" || !entry.url.trim()}
              className="btn-text"
            >
              {testState === "loading" ? t("settings.testing") : t("settings.testConnection")}
            </button>
            {testState === "done" && (
              <span
                className={`text-[11.5px] ${testOk ? "text-on-surface-variant" : "text-error"}`}
              >
                {testMsg}
              </span>
            )}
          </div>

          {/* 工具清单:启用前审阅描述 —— MCP 工具描述是外部文本,这是注入防线的一环 */}
          {toolsLoading && (
            <p className="field-hint">{t("settings.toolsLoading")}</p>
          )}
          {!toolsLoading && (tools || toolsError) && (
            <div className="settings-block">
              <div className="flex items-center justify-between">
                <span className="settings-row-label">
                  {t("settings.tools")}{tools ? t("settings.toolsMeta", { n: tools.length, tokens: toolsTokens }) : ""}
                </span>
              </div>
              {toolsError ? (
                <p className="field-hint text-error">{t("settings.toolsLoadFailed", { error: toolsError })}</p>
              ) : (
                <div className="model-list">
                  {tools?.map((t) => (
                    <div key={t.name} className="py-1">
                      <p className="m-0 font-mono text-[12px] text-on-surface" title={t.name}>
                        {t.name}
                      </p>
                      <p
                        className="m-0 text-[11.5px] leading-snug text-on-surface-variant"
                        title={t.description}
                      >
                        {t.description.slice(0, 120)}
                        {t.description.length > 120 ? "…" : ""}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="mb-1 mt-2">
            <button
              type="button"
              className={`model-row-action model-row-action-danger${
                confirming ? " confirming" : ""
              }`}
              onClick={onRemove}
            >
              {confirming ? t("settings.confirmDeleteServer") : t("settings.deleteServer")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 供应商卡片:收起态 = 名称/主机/模型数概要 + 当前标记;点击展开该供应商
 *  及其模型配置的细节(端点、Key、拉取列表、逐模型配置)。编辑即时落盘:
 *  文本输入失焦保存,「获取列表/添加/删除模型」等动作型操作即时保存 */
function ProviderCard({
  entry,
  isCurrent,
  currentModelId,
  open,
  confirming,
  onToggle,
  onPatch,
  onCommit,
  onRemove,
  onSelectModel,
}: {
  entry: ProviderEntry;
  isCurrent: boolean;
  currentModelId: string;
  open: boolean;
  confirming: boolean;
  onToggle: () => void;
  onPatch: (patch: Partial<ProviderEntry>, save?: boolean) => void;
  onCommit: () => void;
  onRemove: () => void;
  onSelectModel: (modelId: string) => void;
}) {
  const [newId, setNewId] = useState("");
  const [openModelId, setOpenModelId] = useState<string | null>(null);
  const [confirmModelId, setConfirmModelId] = useState<string | null>(null);
  const [fetchState, setFetchState] = useState<FetchState>("idle");
  const [fetchError, setFetchError] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    if (!confirmModelId) return;
    const t = window.setTimeout(() => setConfirmModelId(null), 3000);
    return () => window.clearTimeout(t);
  }, [confirmModelId]);

  const displayName = entry.name || hostOf(entry.baseUrl) || t("settings.providerUnnamed");

  /** 供应商内某个模型条目的局部更新;save=true 即时落盘 */
  const patchModel = (mid: string, patch: Partial<ModelEntry>, save = false) =>
    onPatch(
      {
        models: entry.models.map((m) => (m.id === mid ? { ...m, ...patch } : m)),
      },
      save,
    );
  const commitModels = () => onCommit();
  const addModel = () => {
    const id = newId.trim();
    if (!id || entry.models.some((m) => m.id === id)) return;
    setNewId("");
    onPatch(
      {
        models: [...entry.models, { id }].sort((a, b) =>
          a.id.localeCompare(b.id),
        ),
      },
      true,
    );
  };
  const removeModel = (mid: string) => {
    if (confirmModelId !== mid) {
      setConfirmModelId(mid);
      return;
    }
    setConfirmModelId(null);
    onPatch({ models: entry.models.filter((m) => m.id !== mid) }, true);
  };

  /** 用该供应商自己的地址与 Key 拉取模型列表,与已有条目按 id 合并 */
  const fetchList = async () => {
    if (fetchState === "loading") return;
    if (!entry.apiKey.trim()) {
      setFetchState("error");
      setFetchError(t("settings.fetchNeedKey"));
      return;
    }
    abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;
    setFetchState("loading");
    setFetchError("");
    try {
      const list = await fetchModels(
        entry.baseUrl.trim() || DEFAULT_BASE_URL,
        entry.apiKey.trim(),
        ctl.signal,
      );
      const map = new Map(entry.models.map((m) => [m.id, m]));
      for (const id of list) if (!map.has(id)) map.set(id, { id });
      const next = [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
      onPatch({ models: next }, true);
      setFetchState("idle");
    } catch (e) {
      if (ctl.signal.aborted) return;
      setFetchState("error");
      setFetchError(e instanceof Error ? e.message.slice(0, 120) : String(e));
    }
  };

  return (
    <div className="model-row">
      <button
        type="button"
        className="model-row-head"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="min-w-0 truncate">
          <span className="model-row-name">{displayName}</span>
          {isCurrent && <span className="model-badge">当前</span>}
        </span>
        <span className="ml-auto shrink-0 pr-1 text-[11px] text-on-surface-variant">
          {entry.models.length > 0 ? t("settings.modelCount", { n: entry.models.length }) : t("settings.modelEmpty")}
        </span>
        <svg
          className="model-row-chevron"
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m6 3 5 5-5 5" />
        </svg>
      </button>
      <div className="model-row-body" data-open={open}>
        <div className="model-row-body-inner">
          <div className="settings-field">
            <label className="field-label" htmlFor={`p-name-${entry.id}`}>
              {t("settings.providerName")}<span className="font-normal text-on-surface-variant">{t("common.optional")}</span>
            </label>
            <input
              id={`p-name-${entry.id}`}
              type="text"
              value={entry.name}
              onChange={(e) => onPatch({ name: e.target.value })}
              onBlur={onCommit}
              placeholder={t("settings.namePlaceholder")}
              autoComplete="off"
              spellCheck={false}
              className="field-input"
            />
          </div>
          <div className="settings-field">
            <label className="field-label" htmlFor={`p-baseurl-${entry.id}`}>
              {t("settings.providerUrl")}
            </label>
            <input
              id={`p-baseurl-${entry.id}`}
              type="text"
              value={entry.baseUrl}
              onChange={(e) => onPatch({ baseUrl: e.target.value })}
              onBlur={onCommit}
              placeholder={t("settings.providerUrlPlaceholder")}
              autoComplete="off"
              spellCheck={false}
              className="field-input font-mono"
            />
            <p className="field-hint">
              {t("settings.providerUrlHint")}
            </p>
          </div>
          <div className="settings-field">
            <label className="field-label" htmlFor={`p-apikey-${entry.id}`}>
              {t("settings.apiKey")}
            </label>
            <input
              id={`p-apikey-${entry.id}`}
              type="password"
              value={entry.apiKey}
              onChange={(e) => onPatch({ apiKey: e.target.value })}
              onBlur={onCommit}
              placeholder="sk-…"
              autoComplete="off"
              spellCheck={false}
              className="field-input font-mono"
            />
          </div>

          <div className="settings-block">
            <div className="flex items-center justify-between">
              <span className="settings-row-label">{t("settings.models")}</span>
              <button
                type="button"
                onClick={fetchList}
                disabled={fetchState === "loading"}
                className="btn-text"
              >
                {fetchState === "loading" ? t("settings.fetching") : t("settings.fetchModels")}
              </button>
            </div>
            {fetchState === "error" && (
              <p className="field-hint text-error">{t("settings.fetchFailed", { error: fetchError })}</p>
            )}
            {entry.models.length > 0 ? (
              <div className="model-list">
                {entry.models.map((m) => (
                  <ModelRow
                    key={m.id}
                    entry={m}
                    isDefault={isCurrent && currentModelId === m.id}
                    open={openModelId === m.id}
                    confirming={confirmModelId === m.id}
                    onToggle={() =>
                      setOpenModelId(openModelId === m.id ? null : m.id)
                    }
                    onPatch={(patch, save) => patchModel(m.id, patch, save)}
                    onCommit={commitModels}
                    onSetDefault={() => onSelectModel(m.id)}
                    onRemove={() => removeModel(m.id)}
                  />
                ))}
              </div>
            ) : (
              <p className="field-hint">
                {t("settings.modelEmptyHint")}
              </p>
            )}

            <div className="mt-2 flex items-center gap-2">
              <input
                type="text"
                value={newId}
                onChange={(e) => setNewId(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addModel();
                  }
                }}
                placeholder={t("settings.modelIdPlaceholder")}
                autoComplete="off"
                spellCheck={false}
                className="field-input font-mono"
              />
              <button type="button" onClick={addModel} className="settings-btn">
                添加
              </button>
            </div>
            {entry.models.length > 0 && (
              <p className="field-hint">
                {t("settings.modelRowHint")}
              </p>
            )}
          </div>

          <div className="mb-1 mt-2">
            <button
              type="button"
              className={`model-row-action model-row-action-danger${
                confirming ? " confirming" : ""
              }`}
              onClick={onRemove}
            >
              {confirming ? t("settings.confirmDeleteProvider") : t("settings.deleteProvider")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 同上:分段/下拉的键映射全部字面量化 */
const COMPACT_LABEL_KEYS: Record<CompactLevel, string> = {
  early: "settings.compactEarly",
  standard: "settings.compactStandard",
  late: "settings.compactLate",
};
const SEARCH_PROVIDER_LABEL_KEYS: Record<SearchProviderSetting, string> = {
  auto: "settings.searchProviderAuto",
  tavily: "settings.searchProviderTavily",
  bocha: "settings.searchProviderBocha",
  brave: "settings.searchProviderBrave",
};

export default function SettingsView({
  onBack,
  onOpenMemory,
}: {
  onBack: () => void;
  /** 记忆摘要入口行 → 记忆管理整页(列表不长在这里:平铺时一节超一屏) */
  onOpenMemory: () => void;
}) {
  // ── 模型服务供应商 ──
  const [providers, setProviders] = useState<ProviderEntry[]>([]);
  const [modelProvider, setModelProvider] = useState("");
  const [model, setModel] = useState("");
  const [expandedPid, setExpandedPid] = useState<string | null>(null);
  const [confirmDelPid, setConfirmDelPid] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemePref>("system");
  const [accent, setAccent] = useState<AccentPref>("green");
  const [webSearch, setWebSearch] = useState(false);
  const [search, setSearch] = useState<SearchConfig>({
    provider: "auto",
    services: {
      tavily: { baseUrl: "", apiKey: "" },
      bocha: { baseUrl: "", apiKey: "" },
      brave: { baseUrl: "", apiKey: "" },
    },
  });
  // ── 长期记忆:总开关(条目管理在独立的记忆整页,这里只留摘要入口行) ──
  const [memoryOn, setMemoryOn] = useState(true);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  // ── 上下文压缩:档位 + 压缩用模型引用("providerId||modelId",空 = 跟随当前) ──
  const [compact, setCompact] = useState<CompactLevel>("standard");
  const [compactRef, setCompactRef] = useState("");
  // ── MCP:总开关 + 服务器列表(展开态/两段确认删除与供应商卡同款) ──
  const [mcp, setMcp] = useState<McpConfig>({ enabled: false, servers: [] });
  const [expandedSid, setExpandedSid] = useState<string | null>(null);
  const [confirmDelSid, setConfirmDelSid] = useState<string | null>(null);
  // ── 保存反馈 ──
  const [savedFlash, setSavedFlash] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const flashTimer = useRef<number | null>(null);
  // ── 诊断日志 ──
  const [logCount, setLogCount] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  // ── 历史数据:保留期 / 占用 / 清空确认 ──
  const [retention, setRetention] = useState<"7" | "30" | "0">("7");
  const [usage, setUsage] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const pingSaved = useCallback(() => {
    setSavedFlash(true);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setSavedFlash(false), 1600);
  }, []);

  /** 统一落盘入口:成功闪「已保存」,失败亮红提示 */
  const run = useCallback(
    async (p: Promise<void>) => {
      try {
        await p;
        setSaveError(false);
        pingSaved();
      } catch {
        setSaveError(true);
      }
    },
    [pingSaved],
  );

  // ── 搜索服务:key/中转地址按家各存一格,切换搜索方式各读各的,互不串 ──
  const activeService =
    search.provider === "auto" ? null : search.services[search.provider];
  /** 改当前选中服务的配置;save=false 只改本地态(输入中),true 连带落盘(失焦) */
  const patchService = (patch: Partial<SearchServiceEntry>, save: boolean) => {
    const id = search.provider;
    if (id === "auto") return;
    const next: SearchConfig = {
      ...search,
      services: { ...search.services, [id]: { ...search.services[id], ...patch } },
    };
    setSearch(next);
    if (save) run(savePrefs({ search: next }));
  };

  // ── 长期记忆条目的增删改/置顶/清空都在记忆整页(MemoryView),这里只读列表做摘要 ──

  useEffect(() => {
    loadConfig().then((c) => {
      setProviders(c.providers);
      setModelProvider(c.modelProvider);
      setModel(c.model);
      setTheme(c.theme);
      setAccent(c.accent);
      setWebSearch(c.webSearch);
      setSearch(c.search);
      setMemoryOn(c.memory);
      setCompact(c.compact);
      setCompactRef(
        c.compactProvider && c.compactModel
          ? `${c.compactProvider}||${c.compactModel}`
          : "",
      );
      setMcp(c.mcp);
      setRetention(
        c.historyRetention === 0 || c.historyRetention === 30
          ? String(c.historyRetention) as "0" | "30"
          : "7",
      );
    });
    readAllLogEntries()
      .then((es) => setLogCount(es.length))
      .catch(() => setLogCount(-1));
    memReq({ type: MSG.MEM_LIST })
      .then(setMemories)
      .catch(() => {}); // 列表加载失败不打断设置页,下次打开重试
    refreshUsage();
    return () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    };
  }, []);


  // 忘记 / 删除确认 3s 未跟进则自动复位,避免按钮一直停在「危险态」
  useEffect(() => {
    if (!confirmDelPid) return;
    const t = window.setTimeout(() => setConfirmDelPid(null), 3000);
    return () => clearTimeout(t);
  }, [confirmDelPid]);
  useEffect(() => {
    if (!confirmClear) return;
    const t = window.setTimeout(() => setConfirmClear(false), 3000);
    return () => clearTimeout(t);
  }, [confirmClear]);
  useEffect(() => {
    if (!confirmDelSid) return;
    const t = window.setTimeout(() => setConfirmDelSid(null), 3000);
    return () => clearTimeout(t);
  }, [confirmDelSid]);

  /** 历史库占用(IDB 属整个扩展 origin,此值含日志等其他 local 数据,看个量级) */
  const refreshUsage = () => {
    navigator.storage
      .estimate()
      .then((est) =>
        setUsage(est.usage != null ? formatBytes(est.usage) : t("common.unknown")),
      )
      .catch(() => setUsage(null));
  };

  const changeRetention = (v: "7" | "30" | "0") => {
    setRetention(v);
    run(savePrefs({ historyRetention: Number(v) }));
  };

  /** 压缩用模型:复合值拆回双字段落盘;空 = 跟随当前模型(两个字段清空) */
  const changeCompactModel = (v: string) => {
    setCompactRef(v);
    const idx = v.indexOf("||");
    const pid = idx === -1 ? "" : v.slice(0, idx);
    const mid = idx === -1 ? "" : v.slice(idx + 2);
    run(savePrefs({ compactProvider: pid, compactModel: mid }));
  };

  const clearAllHistory = () => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setConfirmClear(false);
    // SW 是历史库的唯一读写方,清空走消息(即发即断,无回执)
    const port = chrome.runtime.connect({ name: PORT_NAME });
    port.postMessage({ type: MSG.CLEAR_ALL_HISTORY });
    port.disconnect();
    window.setTimeout(refreshUsage, 300);
  };

  /** 供应商局部更新;save=true 即时落盘。当前供应商的默认模型被删时回落到
   *  该供应商的第一个模型,避免对话侧拿着悬空引用 */
  const patchProvider = (
    id: string,
    patch: Partial<ProviderEntry>,
    save = false,
  ) => {
    const next = providers.map((p) => (p.id === id ? { ...p, ...patch } : p));
    setProviders(next);
    if (!save) return;
    const ops: Promise<void>[] = [savePrefs({ providers: next })];
    const affected = next.find((p) => p.id === id);
    if (
      id === modelProvider &&
      affected &&
      !affected.models.some((m) => m.id === model)
    ) {
      const fallback = affected.models[0]?.id ?? "";
      setModel(fallback);
      ops.push(savePrefs({ model: fallback }));
    }
    run(Promise.all(ops).then(() => {}));
  };
  const commitProviders = () => run(savePrefs({ providers }));

  const addProvider = () => {
    const entry: ProviderEntry = {
      id: crypto.randomUUID(),
      name: "",
      baseUrl: "",
      apiKey: "",
      models: [],
    };
    const next = [...providers, entry];
    setProviders(next);
    setExpandedPid(entry.id);
    run(savePrefs({ providers: next }));
  };

  /** 两段确认删除;删的是当前供应商时,回落到剩余第一个供应商及其首个模型 */
  const removeProvider = (id: string) => {
    if (confirmDelPid !== id) {
      setConfirmDelPid(id);
      return;
    }
    setConfirmDelPid(null);
    const next = providers.filter((p) => p.id !== id);
    const ops: Promise<void>[] = [savePrefs({ providers: next })];
    if (modelProvider === id) {
      const fb = next[0];
      setModelProvider(fb?.id ?? "");
      setModel(fb?.models[0]?.id ?? "");
      ops.push(
        savePrefs({
          modelProvider: fb?.id ?? "",
          model: fb?.models[0]?.id ?? "",
        }),
      );
    }
    setProviders(next);
    run(Promise.all(ops).then(() => {}));
  };

  /** 设当前对话模型(供应商 + wire 模型名) */
  const selectModel = (pid: string, mid: string) => {
    setModelProvider(pid);
    setModel(mid);
    run(savePrefs({ modelProvider: pid, model: mid }));
  };

  // ── MCP 服务器增删改(整包落盘,同 providers 的保存模式) ──
  const patchServer = (
    id: string,
    patch: Partial<McpServerEntry>,
    save = false,
  ) => {
    const servers = mcp.servers.map((s) =>
      s.id === id ? { ...s, ...patch } : s,
    );
    const next = { ...mcp, servers };
    setMcp(next);
    if (save) run(savePrefs({ mcp: next }));
  };
  const commitServers = () => run(savePrefs({ mcp }));
  const addServer = () => {
    const entry: McpServerEntry = {
      id: crypto.randomUUID(),
      name: "",
      url: "",
      headers: {},
      enabled: true,
    };
    const next = { ...mcp, servers: [...mcp.servers, entry] };
    setMcp(next);
    setExpandedSid(entry.id);
    run(savePrefs({ mcp: next }));
  };
  const removeServer = (id: string) => {
    if (confirmDelSid !== id) {
      setConfirmDelSid(id);
      return;
    }
    setConfirmDelSid(null);
    const next = { ...mcp, servers: mcp.servers.filter((s) => s.id !== id) };
    setMcp(next);
    if (expandedSid === id) setExpandedSid(null);
    run(savePrefs({ mcp: next }));
  };

  const copyLogs = async () => {
    try {
      const entries = await readAllLogEntries();
      await navigator.clipboard.writeText(toJsonl(entries));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* 剪贴板被拒等:静默 */
    }
  };

  const downloadLogs = async () => {
    const entries = await readAllLogEntries();
    const blob = new Blob([toJsonl(entries)], {
      type: "application/x-ndjson",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sidebar-logs-${new Date()
      .toISOString()
      .slice(0, 19)
      .replace(/[:T]/g, "-")}.jsonl`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // 诊断日志清空:与记忆/历史的两段确认同款(危险动作不单击直发)
  const [confirmClearLogs, setConfirmClearLogs] = useState(false);
  useEffect(() => {
    if (!confirmClearLogs) return;
    const t = window.setTimeout(() => setConfirmClearLogs(false), 3000);
    return () => clearTimeout(t);
  }, [confirmClearLogs]);
  const clearLogs = async () => {
    if (!confirmClearLogs) {
      setConfirmClearLogs(true);
      return;
    }
    setConfirmClearLogs(false);
    await clearAllLogs();
    setLogCount(0);
  };

  return (
    <div className="view-in flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-2 px-4 pb-1 pt-3">
        <button
          type="button"
          onClick={onBack}
          aria-label={t("common.backToChat")}
          className="icon-btn"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M10 3 5 8l5 5" />
          </svg>
        </button>
        <h2 className="m-0 text-[16px] font-medium text-on-surface">{t("settings.title")}</h2>
        <span
          aria-live="polite"
          className={`ml-auto pr-1 text-[11px] text-primary transition-opacity duration-300 ${
            savedFlash ? "opacity-100" : "opacity-0"
          }`}
        >
          {t("settings.saved")}
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
        {saveError && (
          <p className="mb-1 mt-2 text-[12px] text-error">
            {t("settings.saveFailed")}
          </p>
        )}

        {/* ── 模型服务 ── */}
        <h3 className="settings-eyebrow mb-1.5 mt-3">{t("settings.sectionModel")}</h3>
        <div className="settings-card">
          {providers.length > 0 ? (
            <div className="model-list">
              {providers.map((p) => (
                <ProviderCard
                  key={p.id}
                  entry={p}
                  isCurrent={p.id === modelProvider}
                  currentModelId={p.id === modelProvider ? model : ""}
                  open={expandedPid === p.id}
                  confirming={confirmDelPid === p.id}
                  onToggle={() => setExpandedPid(expandedPid === p.id ? null : p.id)}
                  onPatch={(patch, save) => patchProvider(p.id, patch, save)}
                  onCommit={commitProviders}
                  onRemove={() => removeProvider(p.id)}
                  onSelectModel={(mid) => selectModel(p.id, mid)}
                />
              ))}
            </div>
          ) : (
            <p className="field-hint">
              还没有服务商。点「添加服务商」填入地址和 Key 就能用，可以加多个随时切换。
            </p>
          )}
          <div className="mt-2">
            <button type="button" onClick={addProvider} className="settings-btn">
              添加服务商
            </button>
          </div>
          <p className="field-hint">
            点卡片展开详细配置。带「当前」标记的，就是对话正在用的服务商。
          </p>
        </div>


        {/* ── 外观 ── */}
        <h3 className="settings-eyebrow mb-1.5 mt-4">{t("settings.sectionAppearance")}</h3>
        <div className="settings-card">
          <div className="settings-field">
            <span className="field-label">{t("settings.theme")}</span>
            <Segmented
              ariaLabel={t("settings.theme")}
              value={theme}
              options={THEME_OPTIONS}
              onChange={(t) => {
                setTheme(t);
                applyThemePreference(t);
                run(savePrefs({ theme: t }));
              }}
            />
          </div>

          {/* 重点色:色板 = 各源色,选中套整个 scheme(m3.css 的 data-accent) */}
          <div className="settings-field">
            <span className="field-label">{t("settings.accent")}</span>
            <div
              role="radiogroup"
              aria-label={t("settings.accent")}
              className="flex items-center gap-2.5"
            >
              {ACCENT_OPTIONS.map((a) => (
                <button
                  key={a.value}
                  type="button"
                  role="radio"
                  aria-checked={accent === a.value}
                  aria-label={t("settings.accentAria", { name: a.label })}
                  title={a.label}
                  onClick={() => {
                    setAccent(a.value);
                    applyAccent(a.value);
                    run(savePrefs({ accent: a.value }));
                  }}
                  className="swatch"
                  style={{ backgroundColor: a.color }}
                />
              ))}
              <span className="ml-1 text-[11px] text-on-surface-variant">
                {ACCENT_OPTIONS.find((a) => a.value === accent)?.label}
              </span>
            </div>
          </div>
        </div>

        {/* ── 联网 ── */}
        <h3 className="settings-eyebrow mb-1.5 mt-4">{t("settings.sectionWeb")}</h3>
        <div className="settings-card">
          <div className="settings-block">
            <div className="settings-row">
              <label
                htmlFor="settings-web-search"
                className="settings-row-label"
              >
                {t("settings.webSearch")}
              </label>
              <button
                id="settings-web-search"
                type="button"
                role="switch"
                aria-checked={webSearch}
                onClick={() => {
                  const next = !webSearch;
                  setWebSearch(next);
                  run(savePrefs({ webSearch: next }));
                }}
                className="switch"
              >
                <span className="switch-knob" />
              </button>
            </div>
            <p className="field-hint">
              {t("settings.webSearchHint")}
            </p>
          </div>

          {webSearch && (
            <>
              <div className="settings-field">
                <label className="field-label" htmlFor="search-provider">
                  {t("settings.searchProvider")}
                </label>
                <select
                  id="search-provider"
                  value={search.provider}
                  onChange={(e) => {
                    const next = {
                      ...search,
                      provider: e.target.value as SearchProviderSetting,
                    };
                    setSearch(next);
                    run(savePrefs({ search: next }));
                  }}
                  className="field-input"
                >
                  {(SEARCH_PROVIDER_IDS as readonly SearchProviderSetting[]).map(
                    (id) => (
                      <option key={id} value={id}>
                        {t(SEARCH_PROVIDER_LABEL_KEYS[id])}
                      </option>
                    ),
                  )}
                </select>
              </div>

              {activeService ? (
                <>
                  <div className="settings-field">
                    <label className="field-label" htmlFor="search-baseurl">
                      {t("settings.searchBaseUrl")}
                    </label>
                    <input
                      id="search-baseurl"
                      type="text"
                      value={activeService.baseUrl}
                      onChange={(e) =>
                        patchService({ baseUrl: e.target.value }, false)
                      }
                      onBlur={(e) =>
                        patchService({ baseUrl: e.target.value.trim() }, true)
                      }
                      placeholder={t("settings.searchBaseUrlPlaceholder")}
                      autoComplete="off"
                      spellCheck={false}
                      className="field-input font-mono"
                    />
                  </div>

                  <div className="settings-field">
                    <label className="field-label" htmlFor="search-apikey">
                      {t("settings.apiKey")}
                    </label>
                    <input
                      id="search-apikey"
                      type="password"
                      value={activeService.apiKey}
                      onChange={(e) =>
                        patchService({ apiKey: e.target.value }, false)
                      }
                      onBlur={(e) =>
                        patchService({ apiKey: e.target.value.trim() }, true)
                      }
                      placeholder={t("settings.searchApiKeyPlaceholder")}
                      autoComplete="off"
                      spellCheck={false}
                      className="field-input font-mono"
                    />
                    <p className="field-hint">
                      {activeService.apiKey.trim()
                        ? t("settings.searchKeyConfigured")
                        : t("settings.searchKeyMissing")}
                    </p>
                  </div>
                </>
              ) : (
                <p className="field-hint">
                  {t("settings.searchFreeMode")}
                </p>
              )}
            </>
          )}
        </div>

        {/* ── MCP:总开关 + 服务器卡片(工具清单与测试在卡片展开态) ── */}
        <h3 className="settings-eyebrow mb-1.5 mt-4">{t("settings.sectionMcp")}</h3>
        <div className="settings-card">
          <div className="settings-block">
            <div className="settings-row">
              <label htmlFor="settings-mcp" className="settings-row-label">
                {t("settings.mcpEnable")}
              </label>
              <button
                id="settings-mcp"
                type="button"
                role="switch"
                aria-checked={mcp.enabled}
                onClick={() => {
                  const next = { ...mcp, enabled: !mcp.enabled };
                  setMcp(next);
                  run(savePrefs({ mcp: next }));
                }}
                className="switch"
              >
                <span className="switch-knob" />
              </button>
            </div>
            <p className="field-hint">
              {t("settings.mcpHint")}
            </p>
          </div>

          {mcp.enabled && (
            <>
              {mcp.servers.length > 0 ? (
                <div className="model-list">
                  {mcp.servers.map((s) => (
                    <McpServerCard
                      key={s.id}
                      entry={s}
                      open={expandedSid === s.id}
                      confirming={confirmDelSid === s.id}
                      onToggle={() =>
                        setExpandedSid(expandedSid === s.id ? null : s.id)
                      }
                      onPatch={(patch, save) => patchServer(s.id, patch, save)}
                      onCommit={commitServers}
                      onRemove={() => removeServer(s.id)}
                    />
                  ))}
                </div>
              ) : (
                <p className="field-hint">
                  {t("settings.serverEmpty")}
                </p>
              )}
              <div className="mt-2">
                <button type="button" onClick={addServer} className="settings-btn">
                  {t("settings.addServer")}
                </button>
              </div>
              {mcp.servers.length > 0 && (
                <p className="field-hint">
                  {t("settings.serverHint")}
                </p>
              )}
            </>
          )}
        </div>

        {/* ── 记忆:开关 + 摘要入口行;条目管理在记忆整页(MemoryView)── */}
        <h3 className="settings-eyebrow mb-1.5 mt-4">{t("settings.sectionMemory")}</h3>
        <div className="settings-card">
          <div className="settings-block">
            <div className="settings-row">
              <label htmlFor="settings-memory" className="settings-row-label">
                {t("settings.sectionMemory")}
              </label>
              <button
                id="settings-memory"
                type="button"
                role="switch"
                aria-checked={memoryOn}
                onClick={() => {
                  const next = !memoryOn;
                  setMemoryOn(next);
                  run(savePrefs({ memory: next }));
                }}
                className="switch"
              >
                <span className="switch-knob" />
              </button>
            </div>
            <p className="field-hint">
              开了之后，你在对话里说「记住…」或聊到稳定的偏好时，AI
              会记下来（聊天流里会提示），之后每次对话都带上。
              关闭只是不再保存和使用，已存的记忆还在，重开即恢复。
            </p>
          </div>

          {memoryOn && (
            <button
              type="button"
              onClick={onOpenMemory}
              aria-label={t("memory.settingsManage")}
              className="-mx-1 flex w-full items-center justify-between rounded-md px-1 py-1.5 text-left transition-colors duration-150 hover:bg-on-surface/8"
            >
              <span className="min-w-0 truncate pr-2 text-[13px] text-on-surface">
                {memories.length > 0
                  ? t("memory.settingsSaved", { n: memories.length, used: memoryUsedTokens(memories) })
                  : t("memory.settingsEmpty")}
              </span>
              <span className="flex shrink-0 items-center gap-0.5 text-[12.5px] font-medium text-primary">
                {t("memory.settingsManage")}
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="m6 3.5 4.5 4.5L6 12.5" />
                </svg>
              </span>
            </button>
          )}
        </div>

        {/* ── 上下文压缩 ── */}
        <h3 className="settings-eyebrow mb-1.5 mt-4">{t("settings.sectionCompaction")}</h3>
        <div className="settings-card">
          <div className="settings-field">
            <span className="field-label">{t("settings.compactTiming")}</span>
            <Segmented
              value={compact}
              options={COMPACT_LEVELS.map((l) => ({
                value: l,
                label: t(COMPACT_LABEL_KEYS[l]),
              }))}
              onChange={(v) => {
                setCompact(v);
                run(savePrefs({ compact: v }));
              }}
              ariaLabel={t("settings.compactTiming")}
            />
            <p className="field-hint">
              {t("settings.compactHint")}
            </p>
          </div>
          <div className="settings-field">
            <label className="field-label" htmlFor="compact-model">
              {t("settings.compactModel")}
            </label>
            <select
              id="compact-model"
              value={compactRef}
              onChange={(e) => changeCompactModel(e.target.value)}
              className="field-input"
            >
              <option value="">{t("settings.compactFollow")}</option>
              {providers
                .filter((p) => p.apiKey && p.models.length > 0)
                .map((p) => (
                  <optgroup key={p.id} label={p.name || hostOf(p.baseUrl)}>
                    {p.models.map((m) => (
                      <option key={m.id} value={`${p.id}||${m.id}`}>
                        {m.alias || m.id}
                      </option>
                    ))}
                  </optgroup>
                ))}
            </select>
            <p className="field-hint">
              {t("settings.compactModelHint")}
            </p>
          </div>
        </div>

        {/* ── 数据 ── */}
        <h3 className="settings-eyebrow mb-1.5 mt-4">{t("settings.sectionData")}</h3>
        <div className="settings-card">
          <div className="settings-field">
            <span className="field-label">{t("settings.retention")}</span>
            <Segmented
              value={retention}
              options={RETENTION_OPTIONS}
              onChange={changeRetention}
              ariaLabel={t("settings.retentionAria")}
            />
          </div>
          <div className="settings-row">
            <span className="settings-row-label">{t("settings.localUsage")}</span>
            <span className="font-mono text-[12px] text-on-surface-variant">
              {usage ?? "—"}
            </span>
          </div>
          <div className="settings-block">
            <button
              type="button"
              onClick={clearAllHistory}
              className="btn-text danger"
            >
              {confirmClear ? t("common.confirmClear") : t("settings.clearHistory")}
            </button>
          </div>
        </div>
        <p className="settings-group-footer mt-2">
          {t("settings.dataFooter")}
        </p>

        {/* ── 诊断 ── */}
        <h3 className="settings-eyebrow mb-1.5 mt-4">{t("settings.sectionDiag")}</h3>
        <div className="settings-card">
          <div className="settings-row">
            <span className="settings-row-label">{t("settings.logs")}</span>
            <span className="font-mono text-[12px] text-on-surface-variant">
              {logCount === null
                ? t("common.loading")
                : logCount < 0
                  ? t("common.loadFailed")
                  : t("settings.logsUnit", { n: logCount })}
            </span>
          </div>
          <div className="settings-block flex items-center gap-2">
            <button type="button" onClick={copyLogs} className="btn-text">
              {copied ? t("common.copied") : t("settings.copyJsonl")}
            </button>
            <button type="button" onClick={downloadLogs} className="btn-text">
              {t("settings.downloadLogs")}
            </button>
            <button
              type="button"
              onClick={clearLogs}
              className="btn-text danger"
            >
              {confirmClearLogs ? t("common.confirmClear") : t("settings.clearLogs")}
            </button>
          </div>
        </div>
        <p className="settings-group-footer mt-2">
          {t("settings.diagFooter")}
        </p>

      </div>
    </div>
  );
}
