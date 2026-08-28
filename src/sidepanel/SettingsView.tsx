// 设置整页 —— 分组堆叠表单(标签在上、控件全宽),改动即自动保存:
// 开关/分段即时落盘,文本输入失焦落盘;顶部「已保存」轻反馈,失败显示红色提示

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  loadConfig,
  saveConfig,
  savePrefs,
  forgetApiKey,
  type ThemePref,
} from "../shared/configStore";
import { fetchModels } from "../background/provider";
import { clearAllLogs, readAllLogEntries, toJsonl } from "../shared/logger";
import { applyThemePreference } from "./theme";

/** 官方端点兜底(Base URL 留空时),与 openai.ts 适配器的默认一致 */
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

const THEME_OPTIONS: { value: ThemePref; label: string }[] = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

type FetchState = "idle" | "loading" | "error";

/** 分段控件:滑块测量选中按钮的实际位置/宽度,弹簧滑动跟随 */
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
  const ref = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState({ left: 0, width: 0 });

  useLayoutEffect(() => {
    const btn = ref.current?.querySelector<HTMLButtonElement>(
      `[data-v="${value}"]`,
    );
    if (btn) setThumb({ left: btn.offsetLeft, width: btn.offsetWidth });
  }, [value]);

  return (
    <div ref={ref} role="radiogroup" aria-label={ariaLabel} className="segmented">
      <span
        className="segmented-thumb"
        style={{ left: thumb.left, width: thumb.width }}
        aria-hidden="true"
      />
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

export default function SettingsView({ onBack }: { onBack: () => void }) {
  const [cfgName, setCfgName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [remember, setRemember] = useState(true);
  const [model, setModel] = useState("");
  const [maxCtx, setMaxCtx] = useState(0);
  const [baseUrl, setBaseUrl] = useState("");
  const [theme, setTheme] = useState<ThemePref>("system");
  // ── 模型列表拉取(仅手动) ──
  const [models, setModels] = useState<string[]>([]);
  const [fetchState, setFetchState] = useState<FetchState>("idle");
  const [fetchError, setFetchError] = useState("");
  const fetchAbortRef = useRef<AbortController | null>(null);
  // ── 模型建议面板(combobox):与输入框同宽对齐,支持键盘上下/回车/Esc ──
  const [comboOpen, setComboOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const modelInputRef = useRef<HTMLInputElement>(null);
  const comboBlurTimer = useRef<number | null>(null);
  // ── 保存反馈 ──
  const [savedFlash, setSavedFlash] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const flashTimer = useRef<number | null>(null);
  // ── 忘记 Key 的两段确认 ──
  const [confirmForget, setConfirmForget] = useState(false);
  // ── 诊断日志 ──
  const [logCount, setLogCount] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

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
      setMaxCtx(c.maxContextTokens);
      setBaseUrl(c.baseUrl);
      setTheme(c.theme);
    });
    readAllLogEntries()
      .then((es) => setLogCount(es.length))
      .catch(() => setLogCount(-1));
    return () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    };
  }, []);

  // 卸载时中止进行中的拉取、收掉 blur 定时器
  useEffect(
    () => () => {
      fetchAbortRef.current?.abort();
      if (comboBlurTimer.current !== null) clearTimeout(comboBlurTimer.current);
    },
    [],
  );

  // 忘记确认 3s 未跟进则自动复位,避免按钮一直停在「危险态」
  useEffect(() => {
    if (!confirmForget) return;
    const t = window.setTimeout(() => setConfirmForget(false), 3000);
    return () => clearTimeout(t);
  }, [confirmForget]);

  /** apiKey / remember 变更:走 saveConfig 的 session/local 分流 */
  const saveKeyState = (key: string, rememberNext: boolean) =>
    run(
      saveConfig({
        name: cfgName,
        apiKey: key.trim(),
        remember: rememberNext,
        model,
        baseUrl,
        maxContextTokens: maxCtx,
        theme,
      }),
    );

  /** 手动拉取模型列表:用当前输入的 Base URL + Key(未保存的也算)。
   *  成功后进 datalist 建议;模型名为空时顺手填入第一个,避免「拉完还得手选」 */
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
      setModels(list);
      setFetchState("idle");
      if (!model.trim() && list.length > 0) {
        setModel(list[0]);
        run(savePrefs({ model: list[0] }));
      }
    } catch (e) {
      if (ctl.signal.aborted) return;
      setFetchState("error");
      setFetchError(e instanceof Error ? e.message.slice(0, 120) : String(e));
    }
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

  /** 建议项 = 拉取到的完整列表,不做输入过滤(输入框留给人手填,面板只负责展示候选) */
  const modelSuggestions = models;

  const openCombo = () => {
    if (models.length === 0) return;
    if (comboBlurTimer.current !== null) {
      clearTimeout(comboBlurTimer.current);
      comboBlurTimer.current = null;
    }
    setActiveIdx(-1);
    setComboOpen(true);
  };

  const selectModel = (m: string) => {
    setModel(m);
    setComboOpen(false);
    run(savePrefs({ model: m }));
  };

  const clearModel = () => {
    setModel("");
    run(savePrefs({ model: "" }));
    modelInputRef.current?.focus(); // 清空后留在输入框,建议面板随之展开全部
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
      <header className="flex items-center gap-2 px-3 pb-1 pt-3">
        <button
          type="button"
          onClick={onBack}
          aria-label="返回对话"
          className="settings-icon-btn h-7 w-7"
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
        <h2 className="m-0 text-[15px] font-semibold tracking-[-0.01em] text-ink">
          设置
        </h2>
        <span
          aria-live="polite"
          className={`ml-auto pr-1 text-[11px] text-accent transition-opacity duration-300 ${
            savedFlash ? "opacity-100" : "opacity-0"
          }`}
        >
          已保存
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
        {saveError && (
          <p className="mb-1 mt-2 text-[12px] text-danger">
            保存失败，请修改后重试。
          </p>
        )}

        {/* ── 模型服务 ── */}
        <h3 className="settings-eyebrow mb-1.5 mt-3">模型服务</h3>
        <div className="settings-card">
          <label className="field-label" htmlFor="settings-name">
            名称<span className="font-normal text-muted">（选填）</span>
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

          <div className="mt-3 flex items-center justify-between">
            <label
              htmlFor="settings-remember"
              className="text-[12.5px] font-medium text-ink"
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

          <label className="field-label" htmlFor="settings-model">
            模型名
          </label>
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <input
                ref={modelInputRef}
                id="settings-model"
                type="text"
                value={model}
                onChange={(e) => {
                  setModel(e.target.value);
                  openCombo(); // 输入即(重新)展开建议 —— 选中后面板已收起,再改时不触发 onFocus
                }}
                onFocus={openCombo}
                onBlur={() => {
                  // 延迟收起:让建议项的 mousedown(已 preventDefault)先完成选择
                  comboBlurTimer.current = window.setTimeout(
                    () => setComboOpen(false),
                    120,
                  );
                  run(savePrefs({ model: model.trim() }));
                }}
                onKeyDown={(e) => {
                  const n = modelSuggestions.length;
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault();
                    if (!comboOpen) {
                      if (n > 0) {
                        openCombo();
                        setActiveIdx(e.key === "ArrowDown" ? 0 : n - 1);
                      }
                      return;
                    }
                    setActiveIdx((i) =>
                      e.key === "ArrowDown"
                        ? Math.min(i + 1, n - 1)
                        : Math.max(i - 1, 0),
                    );
                  } else if (e.key === "Enter") {
                    if (comboOpen && activeIdx >= 0 && modelSuggestions[activeIdx]) {
                      e.preventDefault();
                      selectModel(modelSuggestions[activeIdx]);
                    }
                  } else if (e.key === "Escape") {
                    setComboOpen(false);
                  }
                }}
                placeholder="从建议选择或手动填写"
                autoComplete="off"
                role="combobox"
                aria-expanded={comboOpen && modelSuggestions.length > 0}
                aria-controls="settings-model-combo"
                spellCheck={false}
                className="field-input has-eye font-mono"
              />
              {model && (
                <button
                  type="button"
                  onClick={clearModel}
                  aria-label="清空模型名"
                  className="settings-eye-btn"
                >
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 12 12"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    aria-hidden="true"
                  >
                    <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
                  </svg>
                </button>
              )}
              {comboOpen && modelSuggestions.length > 0 && (
                <div
                  id="settings-model-combo"
                  role="listbox"
                  aria-label="可选模型"
                  className="combo-pop"
                >
                  {modelSuggestions.map((m, i) => (
                    <button
                      key={m}
                      type="button"
                      role="option"
                      aria-selected={m === model}
                      data-active={i === activeIdx || undefined}
                      className="combo-option"
                      onMouseDown={(e) => {
                        e.preventDefault(); // 输入框不失焦,选择在 blur 收起前完成
                        selectModel(m);
                      }}
                      onMouseEnter={() => setActiveIdx(i)}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={fetchList}
              disabled={fetchState === "loading"}
              className="shrink-0 rounded-[10px] border border-line px-3 py-[7px] text-[12px] text-ink transition-colors hover:bg-surface-2 disabled:opacity-50"
            >
              {fetchState === "loading" ? "拉取中…" : "获取列表"}
            </button>
          </div>
          {fetchState === "error" ? (
            <p className="field-hint text-danger">
              获取失败：{fetchError}。可手动填写模型名。
            </p>
          ) : models.length > 0 ? (
            <p className="field-hint">
              已拉取 {models.length} 个模型，聚焦输入框从建议中选择，也可直接输入。
            </p>
          ) : (
            <p className="field-hint">
              手动填写即可；点「获取列表」按当前 Base URL 与 Key 拉取可选模型。
            </p>
          )}
        </div>

        {/* ── 外观 ── */}
        <h3 className="settings-eyebrow mb-1.5 mt-4">外观</h3>
        <div className="settings-card">
          <div className="py-2.5">
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
        </div>

        {/* ── 高级 ── */}
        <h3 className="settings-eyebrow mb-1.5 mt-4">高级</h3>
        <div className="settings-card">
          <label className="field-label" htmlFor="settings-maxctx">
            最大上下文（tokens）
          </label>
          <input
            id="settings-maxctx"
            type="number"
            value={maxCtx || ""}
            onChange={(e) => setMaxCtx(Number(e.target.value) || 0)}
            onBlur={() => run(savePrefs({ maxContextTokens: maxCtx }))}
            placeholder="选填，如 128000"
            autoComplete="off"
            className="field-input font-mono"
          />
          <p className="field-hint">填后开启对话顶部的上下文用量显示。</p>
        </div>

        {/* ── 诊断 ── */}
        <h3 className="settings-eyebrow mb-1.5 mt-4">诊断</h3>
        <div className="settings-card">
          <div className="flex items-center justify-between py-2.5">
            <span className="text-[12.5px] font-medium text-ink">运行日志</span>
            <span className="font-mono text-[12px] text-muted">
              {logCount === null
                ? "读取中…"
                : logCount < 0
                  ? "读取失败"
                  : `${logCount} 条`}
            </span>
          </div>
          <div className="flex items-center gap-4 pb-1.5">
            <button
              type="button"
              onClick={copyLogs}
              className="text-[13px] text-accent transition-opacity hover:opacity-70"
            >
              {copied ? "已复制 ✓" : "复制 JSONL"}
            </button>
            <button
              type="button"
              onClick={downloadLogs}
              className="text-[13px] text-accent transition-opacity hover:opacity-70"
            >
              下载日志
            </button>
            <button
              type="button"
              onClick={clearLogs}
              className="text-[13px] text-muted transition-colors hover:text-danger"
            >
              清空
            </button>
          </div>
        </div>
        <p className="settings-group-footer mt-2">
          记录各上下文最近 400 条执行与报错。排查问题时：点「下载日志」，把文件放进项目
          .logs/ 目录，然后让助手读它分析。
        </p>

        {apiKey && (
          <button
            type="button"
            onClick={forget}
            className={`mt-4 block w-full pb-1 text-[13px] transition-colors ${
              confirmForget ? "text-danger" : "text-muted hover:text-danger"
            }`}
          >
            {confirmForget ? "再点一次确认忘记" : "忘记已保存的 Key"}
          </button>
        )}
      </div>
    </div>
  );
}
