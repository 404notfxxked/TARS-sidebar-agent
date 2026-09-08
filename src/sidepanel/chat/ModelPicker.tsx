// 输入区的模型选择器:当前模型名 pill,点开按供应商分组的 listbox。
// 自含开合状态与「点外/Esc 关闭」;切换即写回 modelProvider + model 两字段
// (由 onPick 回调实现),后台每轮 run 重读配置,下一轮生效。

import { useEffect, useRef, useState } from "react";
import type { ProviderEntry } from "../../shared/configStore";
import { t } from "../../shared/i18n";

export default function ModelPicker({
  providers,
  modelProvider,
  modelId,
  onPick,
}: {
  providers: ProviderEntry[];
  /** 当前引用(选择器高亮依据) */
  modelProvider: string;
  modelId: string;
  onPick: (providerId: string, modelId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const popRef = useRef<HTMLDivElement | null>(null);

  // 打开期间:点外 / Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!popRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // 引用失效时退回第一个供应商(配置刚写入/被清空的过渡态)
  const curProvider =
    providers.find((p) => p.id === modelProvider) ?? providers[0];
  const curModels = curProvider?.models ?? [];

  return (
    <div ref={popRef} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("chat.selectModel")}
        className="flex items-center gap-1 rounded-full px-2 py-1 text-[12px] font-medium text-on-surface-variant transition-colors duration-150 hover:bg-on-surface/8 hover:text-on-surface"
      >
        <span className="min-w-0 truncate">
          {curModels.find((m) => m.id === modelId)?.alias ||
            modelId ||
            t("chat.selectModel")}
        </span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="shrink-0"
        >
          <path d="m3 6 5 5-5 5" />
        </svg>
      </button>
      {open && (
        <div
          role="listbox"
          aria-label={t("chat.modelOptions")}
          className="combo-pop combo-pop--up"
        >
          {providers
            .filter((p) => p.models.length > 0)
            .map((p) => (
              <div key={p.id} role="group" aria-label={p.name}>
                <div
                  aria-hidden="true"
                  className="px-3 pb-0.5 pt-2 text-[10.5px] font-medium uppercase tracking-wide text-on-surface-variant/70 first:pt-1.5"
                >
                  {p.name || new URL(p.baseUrl).hostname}
                </div>
                {p.models.map((m) => {
                  const selected =
                    p.id === curProvider?.id && m.id === modelId;
                  return (
                    <button
                      key={`${p.id}/${m.id}`}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className="combo-option"
                      title={m.alias ? m.id : undefined}
                      onClick={() => {
                        setOpen(false);
                        onPick(p.id, m.id);
                      }}
                    >
                      {(m.alias || m.id) + (selected ? " ✓" : "")}
                    </button>
                  );
                })}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
