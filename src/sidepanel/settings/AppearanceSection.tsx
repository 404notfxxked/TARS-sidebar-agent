// 设置页「外观」分节:主题(浅/深/跟随系统)+ 重点色色板。

import { useState } from "react";
import {
  savePrefs,
  type AccentPref,
  type ThemePref,
} from "../../shared/configStore";
import { t } from "../../shared/i18n";
import { applyAccent, applyThemePreference } from "../theme";
import Segmented from "../ui/Segmented";
import { SettingsSection } from "./parts";

/** 键一律写字面量(禁止动态拼键):动态拼键会绕过 check-i18n 的静态扫描 */
const THEME_OPTIONS: { value: ThemePref; label: string }[] = [
  { value: "system", label: t("settings.themeSystem") },
  { value: "light", label: t("settings.themeLight") },
  { value: "dark", label: t("settings.themeDark") },
];

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

export default function AppearanceSection({
  initialTheme,
  initialAccent,
  run,
}: {
  initialTheme: ThemePref;
  initialAccent: AccentPref;
  run: (p: Promise<void>) => void;
}) {
  const [theme, setTheme] = useState<ThemePref>(initialTheme);
  const [accent, setAccent] = useState<AccentPref>(initialAccent);

  return (
    <SettingsSection title={t("settings.sectionAppearance")}>
      <div className="settings-field">
        <span className="field-label">{t("settings.theme")}</span>
        <Segmented
          ariaLabel={t("settings.theme")}
          value={theme}
          options={THEME_OPTIONS}
          onChange={(next) => {
            setTheme(next);
            applyThemePreference(next);
            run(savePrefs({ theme: next }));
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
    </SettingsSection>
  );
}
