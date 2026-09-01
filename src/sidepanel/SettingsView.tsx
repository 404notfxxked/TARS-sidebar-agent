// 设置整页 —— 分组堆叠表单(标签在上、控件全宽),改动即自动保存:
// 开关/分段即时落盘,文本输入失焦落盘;顶部「已保存」轻反馈,失败显示红色提示

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  loadConfig,
  saveConfig,
  savePrefs,
  forgetApiKey,
  SEARCH_PROVIDER_LABELS,
  type AccentPref,
  type ModelEntry,
  type SearchConfig,
  type SearchProviderSetting,
  type ThemePref,
} from "../shared/configStore";
import { fetchModels } from "../background/provider";
import { clearAllLogs, readAllLogEntries, toJsonl } from "../shared/logger";
import { applyThemePreference, applyAccent } from "./theme";
import { MSG, PORT_NAME } from "../shared/messages";

/** 官方端点兜底(Base URL 留空时),与 openai.ts 适配器的默认一致 */
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

const THEME_OPTIONS: { value: ThemePref; label: string }[] = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

/** 历史保留期分段选项:值为天数,0 = 不自动清理 */
const RETENTION_OPTIONS: { value: "7" | "30" | "0"; label: string }[] = [
  { value: "7", label: "7 天" },
  { value: "30", label: "30 天" },
  { value: "0", label: "全部" },
];

/** 重点色候选:与 scripts/generate-m3.mjs 的 ACCENTS 一一对应,
 *  color 用各源色本身(色板小圆点展示的是"你选的那个颜色") */
const ACCENT_OPTIONS: { value: AccentPref; label: string; color: string }[] = [
  { value: "green", label: "青绿", color: "#16a34a" },
  { value: "ocean", label: "湖蓝", color: "#0b57d0" },
  { value: "teal", label: "青碧", color: "#0d9488" },
  { value: "indigo", label: "靛蓝", color: "#4f46e5" },
  { value: "lilac", label: "丁香", color: "#6750a4" },
  { value: "coral", label: "珊瑚", color: "#ea580c" },
  { value: "rose", label: "玫红", color: "#e11d48" },
  { value: "graphite", label: "石墨", color: "#5f6368" },
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

type FetchState = "idle" | "loading" | "error";

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
            别名<span className="font-normal text-on-surface-variant">（选填）</span>
          </label>
          <input
            id={`model-alias-${entry.id}`}
            type="text"
            value={entry.alias ?? ""}
            onChange={(e) => onPatch({ alias: e.target.value })}
            onBlur={onCommit}
            placeholder="聊天区选择器显示用"
            autoComplete="off"
            spellCheck={false}
            className="field-input"
          />
          <div className="mt-2.5 flex items-center justify-between">
            <span className="text-[12.5px] font-medium text-on-surface">多模态</span>
            <button
              type="button"
              role="switch"
              aria-checked={!!entry.vision}
              aria-label={`${entry.alias || entry.id} 多模态`}
              onClick={() => onPatch({ vision: !entry.vision }, true)}
              className="switch"
            >
              <span className="switch-knob" />
            </button>
          </div>
          <div className="mt-1 grid grid-cols-2 gap-2">
            <div>
              <label className="field-label" htmlFor={`model-ctx-${entry.id}`}>
                上下文窗口
              </label>
              <input
                id={`model-ctx-${entry.id}`}
                type="number"
                value={entry.contextTokens || ""}
                onChange={(e) =>
                  onPatch({ contextTokens: Number(e.target.value) || 0 })
                }
                onBlur={onCommit}
                placeholder="如 128000"
                autoComplete="off"
                className="field-input font-mono"
              />
            </div>
            <div>
              <label className="field-label" htmlFor={`model-max-${entry.id}`}>
                最大输出
              </label>
              <input
                id={`model-max-${entry.id}`}
                type="number"
                value={entry.maxTokens || ""}
                onChange={(e) =>
                  onPatch({ maxTokens: Number(e.target.value) || 0 })
                }
                onBlur={onCommit}
                placeholder="如 8192"
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
              输出上限字段
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
              <option value="">自动（按模型名推断）</option>
              <option value="max_tokens">max_tokens（兼容端点）</option>
              <option value="max_completion_tokens">
                max_completion_tokens（OpenAI 推理模型）
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
                设为默认
              </button>
            )}
            <button
              type="button"
              className={`model-row-action${
                confirming ? " model-row-action-danger" : ""
              }`}
              onClick={onRemove}
            >
              {confirming ? "确认删除" : "删除"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function SettingsView({ onBack }: { onBack: () => void }) {
  const [cfgName, setCfgName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [remember, setRemember] = useState(true);
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [theme, setTheme] = useState<ThemePref>("system");
  const [accent, setAccent] = useState<AccentPref>("green");
  const [webSearch, setWebSearch] = useState(false);
  const [search, setSearch] = useState<SearchConfig>({
    provider: "auto",
    baseUrl: "",
    apiKey: "",
  });
  // ── 模型列表(持久化):拉取 merge、手动添加、每模型独立配置 ──
  const [modelList, setModelList] = useState<ModelEntry[]>([]);
  const [newId, setNewId] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // ── 模型列表拉取(仅手动) ──
  const [fetchState, setFetchState] = useState<FetchState>("idle");
  const [fetchError, setFetchError] = useState("");
  const fetchAbortRef = useRef<AbortController | null>(null);
  // ── 保存反馈 ──
  const [savedFlash, setSavedFlash] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const flashTimer = useRef<number | null>(null);
  // ── 忘记 Key 的两段确认 ──
  const [confirmForget, setConfirmForget] = useState(false);
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

  useEffect(() => {
    loadConfig().then((c) => {
      setCfgName(c.name);
      setApiKey(c.apiKey);
      setRemember(c.remember);
      setModel(c.model);
      setModelList(c.models);
      setBaseUrl(c.baseUrl);
      setTheme(c.theme);
      setAccent(c.accent);
      setWebSearch(c.webSearch);
      setSearch(c.search);
      setRetention(
        c.historyRetention === 0 || c.historyRetention === 30
          ? String(c.historyRetention) as "0" | "30"
          : "7",
      );
    });
    readAllLogEntries()
      .then((es) => setLogCount(es.length))
      .catch(() => setLogCount(-1));
    refreshUsage();
    return () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    };
  }, []);

  // 卸载时中止进行中的拉取
  useEffect(
    () => () => {
      fetchAbortRef.current?.abort();
    },
    [],
  );

  // 忘记 / 删除确认 3s 未跟进则自动复位,避免按钮一直停在「危险态」
  useEffect(() => {
    if (!confirmForget) return;
    const t = window.setTimeout(() => setConfirmForget(false), 3000);
    return () => clearTimeout(t);
  }, [confirmForget]);
  useEffect(() => {
    if (!confirmDeleteId) return;
    const t = window.setTimeout(() => setConfirmDeleteId(null), 3000);
    return () => clearTimeout(t);
  }, [confirmDeleteId]);
  useEffect(() => {
    if (!confirmClear) return;
    const t = window.setTimeout(() => setConfirmClear(false), 3000);
    return () => clearTimeout(t);
  }, [confirmClear]);

  /** 历史库占用(IDB 属整个扩展 origin,此值含日志等其他 local 数据,看个量级) */
  const refreshUsage = () => {
    navigator.storage
      .estimate()
      .then((est) =>
        setUsage(est.usage != null ? formatBytes(est.usage) : "未知"),
      )
      .catch(() => setUsage(null));
  };

  const changeRetention = (v: "7" | "30" | "0") => {
    setRetention(v);
    run(savePrefs({ historyRetention: Number(v) }));
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

  /** apiKey / remember 变更:走 saveConfig 的 session/local 分流 */
  const saveKeyState = (key: string, rememberNext: boolean) =>
    run(
      saveConfig({
        name: cfgName,
        apiKey: key.trim(),
        remember: rememberNext,
        model,
        models: modelList,
        baseUrl,
        theme,
        accent,
        webSearch,
        search,
        historyRetention: Number(retention),
      }),
    );

  /** 手动拉取模型列表:用当前输入的 Base URL + Key(未保存的也算)。
   *  结果与现有列表按 id merge —— 已有条目保留每模型配置,新 ID 追加;
   *  默认模型为空时顺手设为第一项,避免「拉完还得手选」 */
  const fetchList = async () => {
    if (fetchState === "loading") return;
    const key = apiKey.trim();
    if (!key) {
      setFetchState("error");
      setFetchError("请先填写 API Key");
      return;
    }
    fetchAbortRef.current?.abort();
    const ctl = new AbortController();
    fetchAbortRef.current = ctl;
    setFetchState("loading");
    setFetchError("");
    try {
      const list = await fetchModels(baseUrl.trim() || DEFAULT_BASE_URL, key, ctl.signal);
      const map = new Map(modelList.map((m) => [m.id, m]));
      for (const id of list) if (!map.has(id)) map.set(id, { id });
      const next = [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
      setModelList(next);
      const ops: Promise<void>[] = [savePrefs({ models: next })];
      if (!model && next.length > 0) {
        setModel(next[0].id);
        ops.push(savePrefs({ model: next[0].id }));
      }
      run(Promise.all(ops).then(() => {}));
      setFetchState("idle");
    } catch (e) {
      if (ctl.signal.aborted) return;
      setFetchState("error");
      setFetchError(e instanceof Error ? e.message.slice(0, 120) : String(e));
    }
  };

  /** 局部更新一个模型条目;save=true 即时落盘(开关类),
   *  文本/数字类 onChange 只改本地,失焦时 commitModels 统一落盘 */
  const patchModel = (id: string, patch: Partial<ModelEntry>, save = false) => {
    const next = modelList.map((m) => (m.id === id ? { ...m, ...patch } : m));
    setModelList(next);
    if (save) run(savePrefs({ models: next }));
  };

  /** 文本/数字字段的失焦落盘(闭包里的 modelList 即当前最新值) */
  const commitModels = () => run(savePrefs({ models: modelList }));

  const addModel = () => {
    const id = newId.trim();
    if (!id) return;
    setNewId("");
    if (modelList.some((m) => m.id === id)) return; // 重复 ID 忽略
    const next = [...modelList, { id }].sort((a, b) => a.id.localeCompare(b.id));
    setModelList(next);
    const ops: Promise<void>[] = [savePrefs({ models: next })];
    if (!model) {
      setModel(id);
      ops.push(savePrefs({ model: id }));
    }
    run(Promise.all(ops).then(() => {}));
  };

  const setDefaultModel = (id: string) => {
    setModel(id);
    run(savePrefs({ model: id }));
  };

  /** 两段确认删除;删的是默认模型时,默认回退到剩余第一项(空则清空) */
  const removeModel = (id: string) => {
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id);
      return;
    }
    setConfirmDeleteId(null);
    const next = modelList.filter((m) => m.id !== id);
    setModelList(next);
    const ops: Promise<void>[] = [savePrefs({ models: next })];
    if (model === id) {
      const fallback = next[0]?.id ?? "";
      setModel(fallback);
      ops.push(savePrefs({ model: fallback }));
    }
    run(Promise.all(ops).then(() => {}));
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

  const clearLogs = async () => {
    await clearAllLogs();
    setLogCount(0);
  };

  const forget = async () => {
    if (!confirmForget) {
      setConfirmForget(true);
      return;
    }
    setConfirmForget(false);
    await forgetApiKey();
    setApiKey("");
    setShowKey(false);
  };

  return (
    <div className="view-in flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-2 px-4 pb-1 pt-3">
        <button
          type="button"
          onClick={onBack}
          aria-label="返回对话"
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
        <h2 className="m-0 text-[16px] font-medium text-on-surface">设置</h2>
        <span
          aria-live="polite"
          className={`ml-auto pr-1 text-[11px] text-primary transition-opacity duration-300 ${
            savedFlash ? "opacity-100" : "opacity-0"
          }`}
        >
          已保存
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
        {saveError && (
          <p className="mb-1 mt-2 text-[12px] text-error">
            保存失败，请修改后重试。
          </p>
        )}

        {/* ── 模型服务 ── */}
        <h3 className="settings-eyebrow mb-1.5 mt-3">模型服务</h3>
        <div className="settings-card">
          <div className="settings-field">
            <label className="field-label" htmlFor="settings-name">
              名称<span className="font-normal text-on-surface-variant">（选填）</span>
            </label>
            <input
              id="settings-name"
              type="text"
              value={cfgName}
              onChange={(e) => setCfgName(e.target.value)}
              onBlur={() => run(savePrefs({ name: cfgName.trim() }))}
              placeholder="如 DeepSeek，仅备注用"
              autoComplete="off"
              spellCheck={false}
              className="field-input"
            />
          </div>

          <div className="settings-field">
            <label className="field-label" htmlFor="settings-baseurl">
              Base URL
            </label>
            <input
              id="settings-baseurl"
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              onBlur={() => run(savePrefs({ baseUrl: baseUrl.trim() }))}
              placeholder="https://api.deepseek.com/v1"
              autoComplete="off"
              spellCheck={false}
              className="field-input font-mono"
            />
            <p className="field-hint">
              OpenAI 兼容端点，需含 /v1；留空使用官方 api.openai.com/v1。
            </p>
          </div>

          <div className="settings-field">
            <label className="field-label" htmlFor="settings-apikey">
              API Key
            </label>
          <div className="relative">
            <input
              id="settings-apikey"
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onBlur={() => saveKeyState(apiKey, remember)}
              placeholder="sk-…"
              autoComplete="off"
              spellCheck={false}
              className="field-input has-eye font-mono"
            />
            <button
              type="button"
              onClick={() => setShowKey((s) => !s)}
              aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}
              className="settings-eye-btn"
            >
              {showKey ? (
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z" />
                  <circle cx="12" cy="12" r="3" />
                  <path d="m4 4 16 16" />
                </svg>
              ) : (
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              )}
            </button>
          </div>
          </div>

          <div className="settings-block">
            <div className="settings-row">
              <label
                htmlFor="settings-remember"
                className="settings-row-label"
              >
                记住我
              </label>
              <button
                id="settings-remember"
                type="button"
                role="switch"
                aria-checked={remember}
                onClick={() => {
                  const next = !remember;
                  setRemember(next);
                  saveKeyState(apiKey, next);
                }}
                className="switch"
              >
                <span className="switch-knob" />
              </button>
            </div>
            <p className="field-hint">
              不开启则仅本次会话有效，关闭浏览器后失效。
            </p>
          </div>

          <div className="settings-block">
            <div className="flex items-center justify-between">
              <span className="settings-row-label">模型</span>
              <button
                type="button"
                onClick={fetchList}
                disabled={fetchState === "loading"}
                className="btn-text"
              >
                {fetchState === "loading" ? "拉取中…" : "获取列表"}
              </button>
            </div>
          {fetchState === "error" && (
            <p className="field-hint text-error">获取失败：{fetchError}</p>
          )}
          {modelList.length > 0 ? (
            <div className="model-list">
              {modelList.map((m) => (
                <ModelRow
                  key={m.id}
                  entry={m}
                  isDefault={m.id === model}
                  open={expandedId === m.id}
                  confirming={confirmDeleteId === m.id}
                  onToggle={() =>
                    setExpandedId(expandedId === m.id ? null : m.id)
                  }
                  onPatch={(patch, save) => patchModel(m.id, patch, save)}
                  onCommit={commitModels}
                  onSetDefault={() => setDefaultModel(m.id)}
                  onRemove={() => removeModel(m.id)}
                />
              ))}
            </div>
          ) : (
            <p className="field-hint">
              还没有模型：点「获取列表」按当前 Base URL 与 Key
              拉取，或在下方手动添加。
            </p>
          )}

          {/* 手动添加:有些端点不提供 /models,或只想加一个 */}
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
              placeholder="手动添加模型 ID，如 deepseek-chat"
              autoComplete="off"
              spellCheck={false}
              className="field-input font-mono"
            />
            <button type="button" onClick={addModel} className="settings-btn">
              添加
            </button>
          </div>
          {modelList.length > 0 && (
            <p className="field-hint">
              点模型行展开配置；带「默认」标记的是对话使用的模型。
            </p>
          )}
          </div>
        </div>

        {/* ── 外观 ── */}
        <h3 className="settings-eyebrow mb-1.5 mt-4">外观</h3>
        <div className="settings-card">
          <div className="settings-field">
            <span className="field-label">主题</span>
            <Segmented
              ariaLabel="主题"
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
            <span className="field-label">重点色</span>
            <div
              role="radiogroup"
              aria-label="重点色"
              className="flex items-center gap-2.5"
            >
              {ACCENT_OPTIONS.map((a) => (
                <button
                  key={a.value}
                  type="button"
                  role="radio"
                  aria-checked={accent === a.value}
                  aria-label={`重点色：${a.label}`}
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
        <h3 className="settings-eyebrow mb-1.5 mt-4">联网</h3>
        <div className="settings-card">
          <div className="settings-block">
            <div className="settings-row">
              <label
                htmlFor="settings-web-search"
                className="settings-row-label"
              >
                联网搜索
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
              默认关闭。开启后即可联网搜索：默认走免 Key 的抓取通道（质量随网络环境浮动），
              也可以配置搜索服务（Tavily / 博查 / Brave，自带 API Key）获得更稳的结果。
            </p>
          </div>

          {webSearch && (
            <>
              <div className="settings-field">
                <label className="field-label" htmlFor="search-provider">
                  搜索方式
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
                  {(
                    Object.keys(SEARCH_PROVIDER_LABELS) as SearchProviderSetting[]
                  ).map((id) => (
                    <option key={id} value={id}>
                      {SEARCH_PROVIDER_LABELS[id]}
                    </option>
                  ))}
                </select>
              </div>

              {search.provider === "auto" ? (
                <p className="field-hint">
                  免 Key 模式：直接抓取 Bing / DuckDuckGo 的搜索结果页，搜索词会发给这些搜索引擎。
                  结果质量取决于网络出口——被风控时会自动换引擎或冷却；想要稳定质量请改选具体服务商。
                </p>
              ) : (
                <>
                  <div className="settings-field">
                    <label className="field-label" htmlFor="search-baseurl">
                      服务地址
                    </label>
                    <input
                      id="search-baseurl"
                      type="text"
                      value={search.baseUrl}
                      onChange={(e) => setSearch({ ...search, baseUrl: e.target.value })}
                      onBlur={() =>
                        run(savePrefs({ search: { ...search, baseUrl: search.baseUrl.trim() } }))
                      }
                      placeholder="留空用官方端点；自建中转时填写根地址"
                      autoComplete="off"
                      spellCheck={false}
                      className="field-input font-mono"
                    />
                  </div>

                  <div className="settings-field">
                    <label className="field-label" htmlFor="search-apikey">
                      API Key
                    </label>
                    <input
                      id="search-apikey"
                      type="password"
                      value={search.apiKey}
                      onChange={(e) => setSearch({ ...search, apiKey: e.target.value })}
                      onBlur={() =>
                        run(savePrefs({ search: { ...search, apiKey: search.apiKey.trim() } }))
                      }
                      placeholder="搜索服务的 API Key；留空则退回免 Key 抓取通道"
                      autoComplete="off"
                      spellCheck={false}
                      className="field-input font-mono"
                    />
                    <p className="field-hint">
                      {search.apiKey.trim()
                        ? "已配置，走该服务的 API。"
                        : "未填 Key：暂走免 Key 抓取通道。"}
                    </p>
                  </div>
                </>
              )}
            </>
          )}
        </div>

        {/* ── 数据 ── */}
        <h3 className="settings-eyebrow mb-1.5 mt-4">历史数据</h3>
        <div className="settings-card">
          <div className="settings-field">
            <span className="field-label">保留时长</span>
            <Segmented
              value={retention}
              options={RETENTION_OPTIONS}
              onChange={changeRetention}
              ariaLabel="历史会话保留时长"
            />
          </div>
          <div className="settings-row">
            <span className="settings-row-label">本地占用</span>
            <span className="font-mono text-[12px] text-on-surface-variant">
              {usage ?? "—"}
            </span>
          </div>
          <div className="settings-block">
            <button
              type="button"
              onClick={clearAllHistory}
              className={`btn-text ${confirmClear ? "danger" : "muted"}`}
            >
              {confirmClear ? "再点一次确认清空" : "清空全部历史"}
            </button>
          </div>
        </div>
        <p className="settings-group-footer mt-2">
          超过保留时长的会话按最后活跃时间自动清理;删除的会话不可恢复,所有数据只存在本机。
        </p>

        {/* ── 诊断 ── */}
        <h3 className="settings-eyebrow mb-1.5 mt-4">诊断</h3>
        <div className="settings-card">
          <div className="settings-row">
            <span className="settings-row-label">运行日志</span>
            <span className="font-mono text-[12px] text-on-surface-variant">
              {logCount === null
                ? "读取中…"
                : logCount < 0
                  ? "读取失败"
                  : `${logCount} 条`}
            </span>
          </div>
          <div className="settings-block flex items-center gap-2">
            <button type="button" onClick={copyLogs} className="btn-text">
              {copied ? "已复制 ✓" : "复制 JSONL"}
            </button>
            <button type="button" onClick={downloadLogs} className="btn-text">
              下载日志
            </button>
            <button
              type="button"
              onClick={clearLogs}
              className="btn-text danger"
            >
              清空
            </button>
          </div>
        </div>
        <p className="settings-group-footer mt-2">
          记录各上下文最近 400 条执行与报错。排查问题时：点「下载日志」，把文件放进项目
          .logs/ 目录，然后让 TARS 读它分析。
        </p>

        {apiKey && (
          <button
            type="button"
            onClick={forget}
            className={`btn-text muted mt-2 block w-full ${
              confirmForget ? "danger" : ""
            }`}
          >
            {confirmForget ? "再点一次确认忘记" : "忘记已保存的 Key"}
          </button>
        )}
      </div>
    </div>
  );
}
