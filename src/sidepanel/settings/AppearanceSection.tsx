// 设置页「外观」分节:语言 + 主题(浅/深/跟随系统)+ 重点色色板。

import { useState } from "react";
import {
  savePrefs,
  type AccentPref,
  type LocalePref,
  type ThemePref,
} from "../../shared/configStore";
import { setLocale } from "../../shared/i18n";
import { applyAccent, applyThemePreference } from "../theme";
import { useLocale, useT } from "../ui/hooks";
import Segmented from "../ui/Segmented";
import { SettingsSection } from "./parts";

/** 重点色候选:值与色板固定,与 scripts/generate-m3.mjs 的 ACCENTS 一一对应。
 *  带文案的选项一律渲染时经 t() 现取 —— 模块级求值只跑一次,换语言即陈旧 */
const ACCENT_COLORS: [AccentPref, string][] = [
  ["rose", "#e11d48"],
  ["coral", "#ea580c"],
  ["green", "#16a34a"],
  ["teal", "#0d9488"],
  ["ocean", "#0b57d0"],
  ["indigo", "#4f46e5"],
  ["lilac", "#6750a4"],
  ["graphite", "#5f6368"],
];

/** 键映射一律写字面量(禁止动态拼键:动态拼键会绕过 check-i18n 静态扫描) */
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

export default function AppearanceSection({
  initialTheme,
  initialAccent,
  run,
}: {
  initialTheme: ThemePref;
  initialAccent: AccentPref;
  run: (p: Promise<void>) => void;
}) {
  const t = useT();
  const [theme, setTheme] = useState<ThemePref>(initialTheme);
  const [accent, setAccent] = useState<AccentPref>(initialAccent);
  const locale = useLocale();

  // 主题选项标签渲染时现取,文案随界面语言走
  const themeOptions: { value: ThemePref; label: string }[] = [
    { value: "system", label: t("settings.themeSystem") },
    { value: "light", label: t("settings.themeLight") },
    { value: "dark", label: t("settings.themeDark") },
  ];

  return (
    <SettingsSection title={t("settings.sectionAppearance")}>
      {/* 语言:下拉与搜索方式/压缩用模型同款(select.field-input);切换即
          广播整树重渲染(useLocale 订阅),落盘经 savePrefs。选项标签是各
          语言「本名」,不随界面语言翻译 */}
      <div className="settings-field">
        <label className="field-label" htmlFor="ui-locale">
          {t("settings.language")}
        </label>
        <select
          id="ui-locale"
          value={locale}
          onChange={(e) => {
            const next = e.target.value as LocalePref;
            setLocale(next);
            run(savePrefs({ locale: next }));
          }}
          className="field-input"
        >
          <option value="zh-CN">{t("settings.languageZh")}</option>
          <option value="en-US">{t("settings.languageEn")}</option>
        </select>
      </div>

      <div className="settings-field">
        <span className="field-label">{t("settings.theme")}</span>
        <Segmented
          ariaLabel={t("settings.theme")}
          value={theme}
          options={themeOptions}
          onChange={(next) => {
            setTheme(next);
            applyThemePreference(next);
            run(savePrefs({ theme: next }));
          }}
        />
      </div>

      {/* 重点色:色板 = 各源色,选中套整个 scheme(m3.css 的 data-accent)。
          当前选中名并进字段标签(「重点色 · 青绿」):曾浮在色点行尾,
          基线错位显孤立 */}
      <div className="settings-field">
        <span className="field-label">
          {t("settings.accent")} · {t(ACCENT_LABEL_KEYS[accent])}
        </span>
        <div
          role="radiogroup"
          aria-label={t("settings.accent")}
          className="flex flex-wrap items-center gap-2.5"
          onKeyDown={(e) => {
            // 方向键移选(native radio 惯例,同 Segmented 的契约):移动即选中,
            // 焦点跟到新选中色块;roving tabindex 由下方 tabIndex 渲染
            const d =
              e.key === "ArrowLeft" || e.key === "ArrowUp"
                ? -1
                : e.key === "ArrowRight" || e.key === "ArrowDown"
                  ? 1
                  : 0;
            if (d === 0) return;
            e.preventDefault();
            const idx = ACCENT_COLORS.findIndex(([v]) => v === accent);
            const next = ACCENT_COLORS[(idx + d + ACCENT_COLORS.length) % ACCENT_COLORS.length];
            setAccent(next[0]);
            applyAccent(next[0]);
            run(savePrefs({ accent: next[0] }));
            e.currentTarget
              .querySelector<HTMLElement>(`[data-v="${next[0]}"]`)
              ?.focus();
          }}
        >
          {ACCENT_COLORS.map(([value, color]) => (
            // biome-ignore lint/a11y/useSemanticElements: 色板选择的 radio 语义经 role 声明,原生 radio 无法承载视觉
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={accent === value}
              tabIndex={accent === value ? 0 : -1}
              aria-label={t("settings.accentAria", {
                name: t(ACCENT_LABEL_KEYS[value]),
              })}
              title={t(ACCENT_LABEL_KEYS[value])}
              data-v={value}
              onClick={() => {
                setAccent(value);
                applyAccent(value);
                run(savePrefs({ accent: value }));
              }}
              className="swatch"
              style={{ backgroundColor: color }}
            />
          ))}
        </div>
      </div>
    </SettingsSection>
  );
}
