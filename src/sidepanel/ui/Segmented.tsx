// M3 分段按钮(connected button group):选中段填 secondaryContainer,勾号由 CSS 提供。
// 面板唯一分段控件,样式类见 styles/settings.css 的 .segmented。
// 键盘语义同 native radiogroup:方向键移动即选中,roving tabindex(仅选中段
// 可 Tab 停留);色板(AppearanceSection)是同一契约的另一实现,改这里同步那边。

import type { KeyboardEvent } from "react";

/** 分段选项:label 必须是已取好的文案(调用侧用 t() 字面量键) */
export default function Segmented<T extends string>({
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
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const d =
      e.key === "ArrowLeft" || e.key === "ArrowUp"
        ? -1
        : e.key === "ArrowRight" || e.key === "ArrowDown"
          ? 1
          : 0;
    if (d === 0) return;
    e.preventDefault();
    const idx = options.findIndex((o) => o.value === value);
    const next = options[(idx + d + options.length) % options.length];
    onChange(next.value);
    e.currentTarget
      .querySelector<HTMLElement>(`[data-v="${next.value}"]`)
      ?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="segmented"
      onKeyDown={onKeyDown}
    >
      {options.map((o) => (
        // biome-ignore lint/a11y/useSemanticElements: 分段控件的 radio 语义经 role 声明,原生 radio 无法承载视觉
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          tabIndex={value === o.value ? 0 : -1}
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
