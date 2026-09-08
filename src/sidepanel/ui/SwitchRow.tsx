// 设置页开关行:.settings-block 内一行 label + .switch,可选说明文字。
// 联网搜索 / MCP / 长期记忆三个总开关的同款骨架;开关即时落盘的语义由
// onChange 调用方决定(契约:开关类即时落盘)。

export default function SwitchRow({
  id,
  label,
  checked,
  onChange,
  hint,
}: {
  /** 传了就把 id 放在 label(for)与开关上,测试选择器依赖这些稳定 id */
  id?: string;
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  hint?: string;
}) {
  return (
    <div className="settings-block">
      <div className="settings-row">
        <label htmlFor={id} className="settings-row-label">
          {label}
        </label>
        <button
          id={id}
          type="button"
          role="switch"
          aria-checked={checked}
          onClick={() => onChange(!checked)}
          className="switch"
        >
          <span className="switch-knob" />
        </button>
      </div>
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}
