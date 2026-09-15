// M3 分段按钮(connected button group):选中段填 secondaryContainer,勾号由 CSS 提供。
// 面板唯一分段控件,样式类见 styles/settings.css 的 .segmented。

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
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="segmented">
      {options.map((o) => (
        // biome-ignore lint/a11y/useSemanticElements: 分段控件的 radio 语义经 role 声明,原生 radio 无法承载视觉
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
