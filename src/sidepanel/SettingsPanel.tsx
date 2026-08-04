// 设置滑层:Provider / Model / Base URL / API Key 的输入与保存

import { useEffect, useRef, useState } from "react";
import {
  loadConfig,
  saveConfig,
  forgetApiKey,
  type ProviderName,
} from "../shared/configStore";

type SaveStatus = "none" | "saved" | "session";

const MODEL_PLACEHOLDER: Record<ProviderName, string> = {
  openai: "eg: deepseek-v4-flash, gpt-5.6",
  anthropic: "eg: claude-opus-5",
};

const BASE_URL_PLACEHOLDER: Record<ProviderName, string> = {
  openai: "默认为 api.openai.com",
  anthropic: "默认为 api.anthropic.com",
};

export default function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const [remember, setRemember] = useState(true);
  const [provider, setProvider] = useState<ProviderName>("openai");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [status, setStatus] = useState<SaveStatus>("none");
  const [savedFlash, setSavedFlash] = useState<
    "saving" | "saved" | "error" | null
  >(null);
  const flashTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    },
    [],
  );

  useEffect(() => {
    loadConfig().then((c) => {
      setApiKey(c.apiKey);
      setRemember(c.remember);
      setProvider(c.provider);
      setModel(c.model);
      setBaseUrl(c.baseUrl);
      setStatus(c.apiKey ? (c.remember ? "saved" : "session") : "none");
    });
  }, []);

  const save = async () => {
    setSavedFlash("saving");
    try {
      await saveConfig({
        apiKey: apiKey.trim(),
        remember,
        provider,
        model,
        baseUrl,
      });
      setStatus(apiKey.trim() ? (remember ? "saved" : "session") : "none");
      setSavedFlash("saved");
    } catch {
      setSavedFlash("error");
    }
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setSavedFlash(null), 1600);
  };

  const forget = async () => {
    await forgetApiKey();
    setApiKey("");
    setRemember(true);
    setStatus("none");
  };

  const fieldClass =
    "mt-1.5 w-full rounded-[6px] border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-[13px] text-[var(--ink)] outline-none transition-colors focus:border-[var(--accent)]";

  return (
    <div className="absolute inset-0 z-10 flex justify-end">
      <button
        type="button"
        aria-label="关闭设置"
        onClick={onClose}
        className="absolute inset-0 bg-black/10"
      />
      <section className="slide-in relative flex h-full w-full flex-col bg-[var(--surface)] px-5 py-5">
        <header className="flex items-start justify-between">
          <div>
            <h2 className="title-serif m-0 text-[16px] font-semibold leading-none">
              设置
            </h2>
            <p className="eyebrow m-0 mt-1.5">Settings</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭设置"
            className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-[5px] text-[var(--muted)] transition-colors hover:bg-[var(--line)] hover:text-[var(--ink)]"
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
          <section className="mt-6 space-y-6">
            <div>
              <p className="eyebrow">模型</p>
              <div className="mt-3 space-y-3">
                <div>
                  <label className="block text-[12px] text-[var(--muted)]">
                    协议
                  </label>
                  <select
                    value={provider}
                    onChange={(e) =>
                      setProvider(e.target.value as ProviderName)
                    }
                    className={fieldClass}
                  >
                    <option value="openai">OpenAI</option>
                    <option value="anthropic">Anthropic</option>
                  </select>
                  <p className="mt-1.5 pl-[2px] text-[11px] leading-relaxed text-[var(--muted)]">
                    先选择协议，再填模型名、Base URL。
                  </p>
                </div>

                <div>
                  <label className="block text-[12px] text-[var(--muted)]">
                    模型名
                  </label>
                  <input
                    type="text"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder={MODEL_PLACEHOLDER[provider]}
                    autoComplete="off"
                    className={`${fieldClass} font-mono`}
                  />
                </div>

                <div>
                  <label className="block text-[12px] text-[var(--muted)]">
                    Base URL
                  </label>
                  <input
                    type="text"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder={BASE_URL_PLACEHOLDER[provider]}
                    autoComplete="off"
                    className={`${fieldClass} font-mono`}
                  />
                </div>
              </div>
            </div>

            <div>
              <p className="eyebrow">API Key</p>
              <label className="mt-3 block text-[12px] text-[var(--muted)]">
                API Key
              </label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-…"
                autoComplete="off"
                className={`${fieldClass} font-mono`}
              />
              <label className="mt-4 flex cursor-pointer items-center gap-2 text-[12px]">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                  className="h-3.5 w-3.5 accent-[var(--accent)]"
                />
                记住我（下次自动填充）
              </label>
              <p className="mt-1.5 pl-[22px] text-[11px] leading-relaxed text-[var(--muted)]">
                不勾选则仅本次会话有效，关闭浏览器后清除。
              </p>
            </div>
          </section>
        </div>

        <div className="mt-auto pt-5">
          <p
            className={
              status === "none"
                ? "mb-2 text-[11px] text-[var(--muted)]"
                : "mb-2 text-[11px] text-[var(--accent)]"
            }
          >
            {status === "none"
              ? "尚未保存 API Key"
              : status === "saved"
                ? "已记住 · 下次自动填充"
                : "仅本次会话有效"}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={save}
              disabled={savedFlash === "saving"}
              className="flex-1 rounded-[6px] bg-[var(--accent)] py-2 text-[13px] text-white transition-colors hover:bg-[var(--accent-strong)] disabled:opacity-40"
            >
              {savedFlash === "saving"
                ? "保存中…"
                : savedFlash === "saved"
                  ? "已保存 ✓"
                  : savedFlash === "error"
                    ? "保存失败"
                    : "保存"}
            </button>
            {status !== "none" && (
              <button
                type="button"
                onClick={forget}
                className="rounded-[6px] border border-[var(--line)] px-3 text-[13px] text-[var(--muted)] transition-colors hover:border-[var(--danger)] hover:text-[var(--danger)]"
              >
                忘记
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
