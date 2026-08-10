// 设置滑层 —— iOS 风格分组表单
// 毛玻璃面板 + 内嵌分组卡片 + 分段控件(协议)/开关(记住我) + 弹簧动效

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
  forgetApiKey,
  type ProviderName,
} from "../shared/configStore";

type SaveStatus = "none" | "saved" | "session";
type FlashState = "saving" | "saved" | "error" | null;

const MODEL_PLACEHOLDER: Record<ProviderName, string> = {
  openai: "eg: deepseek-v4-flash, gpt-5.6",
  anthropic: "eg: claude-opus-5",
};

const BASE_URL_PLACEHOLDER: Record<ProviderName, string> = {
  openai: "默认 api.openai.com",
  anthropic: "默认 api.anthropic.com",
};

const PROVIDERS: ProviderName[] = ["openai", "anthropic"];

export default function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [remember, setRemember] = useState(true);
  const [provider, setProvider] = useState<ProviderName>("openai");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [status, setStatus] = useState<SaveStatus>("none");
  const [flash, setFlash] = useState<FlashState>(null);
  const [closing, setClosing] = useState(false);
  const flashTimer = useRef<number | null>(null);
  const segRef = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState({ left: 0, width: 0 });

  // 分段控件滑块:测量选中按钮的实际位置/宽度,让滑块"贴"上去
  // (不用百分比——文字宽窄不同,测量才准)
  useLayoutEffect(() => {
    const el = segRef.current;
    const btn = el?.querySelector<HTMLButtonElement>(`[data-p="${provider}"]`);
    if (btn) setThumb({ left: btn.offsetLeft, width: btn.offsetWidth });
  }, [provider]);

  const requestClose = useCallback(() => {
    setClosing(true); // 先播退出动画,动画结束后再真正卸载(见 onAnimationEnd)
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    loadConfig().then((c) => {
      setApiKey(c.apiKey);
      setRemember(c.remember);
      setProvider(c.provider);
      setModel(c.model);
      setBaseUrl(c.baseUrl);
      setStatus(c.apiKey ? (c.remember ? "saved" : "session") : "none");
    });
    return () => {
      window.removeEventListener("keydown", onKey);
      if (flashTimer.current) clearTimeout(flashTimer.current);
    };
  }, [requestClose]);

  const save = async () => {
    setFlash("saving");
    try {
      await saveConfig({
        apiKey: apiKey.trim(),
        remember,
        provider,
        model,
        baseUrl,
      });
      setStatus(apiKey.trim() ? (remember ? "saved" : "session") : "none");
      setFlash("saved");
    } catch {
      setFlash("error");
    }
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), 1600);
  };

  const forget = async () => {
    await forgetApiKey();
    setApiKey("");
    setRemember(true);
    setStatus("none");
  };

  return (
    <div
      className={`settings-wrap absolute inset-0 z-10 flex justify-end ${closing ? "closing" : ""}`}
      onAnimationEnd={(e) => {
        if (closing && e.animationName === "settings-out") onClose();
      }}
    >
      {/* 点背景关闭;淡入淡出,不抢毛玻璃面板的风头 */}
      <button
        type="button"
        aria-label="关闭设置"
        onClick={requestClose}
        className="scrim absolute inset-0 bg-black/[0.05] transition-opacity duration-200"
      />

      <section
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        className="settings-sheet relative flex h-full w-full flex-col px-4 pb-2 pt-4"
      >
        {/* 标题 + 关闭 */}
        <header className="flex items-start justify-between px-1 pb-1">
          <div>
            <h2 className="m-0 text-[17px] font-semibold leading-tight tracking-[-0.02em] text-[var(--ink)]">
              设置
            </h2>
            <p className="settings-eyebrow mt-1">Settings</p>
          </div>
          <button
            type="button"
            onClick={requestClose}
            aria-label="关闭设置"
            className="settings-icon-btn h-7 w-7"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 14 14"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            >
              <path d="M2 2l10 10M12 2L2 12" />
            </svg>
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* ── 模型 ── */}
          <h3 className="settings-eyebrow mx-4 mb-1.5 mt-4">模型</h3>
          <div className="settings-card">
            <div className="settings-cell">
              <span className="settings-cell-label">协议</span>
              <div
                ref={segRef}
                role="radiogroup"
                aria-label="协议"
                className="segmented"
              >
                <span
                  className="segmented-thumb"
                  style={{ left: thumb.left, width: thumb.width }}
                />
                {PROVIDERS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    role="radio"
                    aria-checked={provider === p}
                    data-p={p}
                    className={provider === p ? "selected" : ""}
                    onClick={() => setProvider(p)}
                  >
                    {p === "openai" ? "OpenAI" : "Anthropic"}
                  </button>
                ))}
              </div>
            </div>

            <div className="settings-cell">
              <label htmlFor="settings-model" className="settings-cell-label">
                模型名
              </label>
              <input
                id="settings-model"
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={MODEL_PLACEHOLDER[provider]}
                autoComplete="off"
                spellCheck={false}
                className="settings-cell-input font-mono"
              />
            </div>

            <div className="settings-cell">
              <label htmlFor="settings-baseurl" className="settings-cell-label">
                Base URL
              </label>
              <input
                id="settings-baseurl"
                type="text"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={BASE_URL_PLACEHOLDER[provider]}
                autoComplete="off"
                spellCheck={false}
                className="settings-cell-input font-mono"
              />
            </div>
          </div>
          <p className="settings-group-footer">
            先选协议，再填模型名与 Base URL。
          </p>

          {/* ── API Key ── */}
          <h3 className="settings-eyebrow mx-4 mb-1.5 mt-4">API Key</h3>
          <div className="settings-card">
            <div className="settings-cell">
              <label htmlFor="settings-apikey" className="settings-cell-label">
                API Key
              </label>
              <div className="relative flex min-w-0 flex-1 items-center">
                <input
                  id="settings-apikey"
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-…"
                  autoComplete="off"
                  spellCheck={false}
                  className="settings-cell-input has-eye font-mono"
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

            <div className="settings-cell">
              <span className="settings-cell-label">记住我</span>
              <button
                type="button"
                role="switch"
                aria-checked={remember}
                onClick={() => setRemember((r) => !r)}
                className="switch ml-auto"
              >
                <span className="switch-knob" />
              </button>
            </div>
          </div>
          <p className="settings-group-footer">
            不勾选则仅本次会话有效，关闭浏览器后失效。
          </p>
        </div>

        {/* 底部:状态 + 主操作 */}
        <div className="pt-3">
          <p
            className={`mb-2.5 text-center text-xs text-[var(--muted)] transition-colors ${
              status !== "none" ? "text-[var(--accent)]" : ""
            }`}
          >
            {status === "none"
              ? "尚未保存 API Key"
              : status === "saved"
                ? "已记住 · 下次自动填充"
                : "仅本次会话有效"}
          </p>
          <button
            type="button"
            onClick={save}
            disabled={flash === "saving"}
            className="btn-primary"
          >
            {flash === "saving"
              ? "保存中…"
              : flash === "saved"
                ? "已保存 ✓"
                : flash === "error"
                  ? "保存失败"
                  : "保存"}
          </button>
          {status !== "none" && (
            <button
              type="button"
              onClick={forget}
              className="w-full pt-2.5 pb-1 text-[13px] text-[var(--muted)] transition-colors hover:text-[var(--danger)]"
            >
              忘记已保存的 Key
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
