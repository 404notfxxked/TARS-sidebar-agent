// 从源色生成 M3 scheme CSS 变量(亮 / 暗两套),写入 src/sidepanel/styles/m3.css。
// 跑法:pnpm tokens:m3;产物是生成文件,提交入库,运行时零依赖。
//
// 注:@material/material-color-utilities 锁 0.3.0(0.4.x 的 ESM 打包缺扩展名,Node 无法加载)。
// 0.3.0 的 scheme 缺 surfaceContainer* 五级,这里按 M3 官方规范用 neutral 色板补齐:
//   light: Lowest 100 / Low 96 / 94 / High 92 / Highest 90,surface 98,dim 87,bright 98
//   dark:  Lowest   4 / Low 10 / 12 / High 17 / Highest 22,surface  6,dim  6,bright 24
import {
  themeFromSourceColor,
  hexFromArgb,
  argbFromHex,
} from "@material/material-color-utilities";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** 品牌源色:与原 --accent(#16a34a)同源 */
const SOURCE = argbFromHex("#16a34a");

const theme = themeFromSourceColor(SOURCE);

/** scheme 里直接存在的角色 */
const SCHEME_ROLES = {
  primary: "primary",
  onPrimary: "on-primary",
  primaryContainer: "primary-container",
  onPrimaryContainer: "on-primary-container",
  secondary: "secondary",
  secondaryContainer: "secondary-container",
  onSecondaryContainer: "on-secondary-container",
  tertiary: "tertiary",
  tertiaryContainer: "tertiary-container",
  onTertiaryContainer: "on-tertiary-container",
  error: "error",
  onError: "on-error",
  errorContainer: "error-container",
  onErrorContainer: "on-error-container",
  onSurface: "on-surface",
  onSurfaceVariant: "on-surface-variant",
  outline: "outline",
  outlineVariant: "outline-variant",
  inverseSurface: "inverse-surface",
  inverseOnSurface: "inverse-on-surface",
  inversePrimary: "inverse-primary",
};

/** surface 五级 + dim/bright:neutral 色板 tone(亮暗各一组) */
const SURFACE_TONES = {
  light: {
    surface: 98,
    "surface-dim": 87,
    "surface-container-lowest": 100,
    "surface-container-low": 96,
    "surface-container": 94,
    "surface-container-high": 92,
    "surface-container-highest": 90,
  },
  dark: {
    surface: 6,
    "surface-dim": 6,
    "surface-container-lowest": 4,
    "surface-container-low": 10,
    "surface-container": 12,
    "surface-container-high": 17,
    "surface-container-highest": 22,
  },
};

function schemeVars(scheme, tones) {
  const neutral = theme.palettes.neutral;
  const lines = Object.entries(SCHEME_ROLES).map(
    ([role, cssName]) => `  --md-${cssName}: ${hexFromArgb(scheme[role])};`,
  );
  for (const [name, tone] of Object.entries(tones)) {
    lines.push(`  --md-${name}: ${hexFromArgb(neutral.tone(tone))};`);
  }
  return lines.join("\n");
}

const css = `/* ---- M3 scheme(生成文件,勿手改)----
   由 scripts/generate-m3.mjs 从源色 #16a34a 经 material-color-utilities 生成
   (surfaceContainer* 按 M3 规范取 neutral 色板 tone,见脚本内注释)。
   重新生成:pnpm tokens:m3 */

:root {
${schemeVars(theme.schemes.light, SURFACE_TONES.light)}
}

[data-theme="dark"] {
${schemeVars(theme.schemes.dark, SURFACE_TONES.dark)}
}
`;

const out = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "sidepanel",
  "styles",
  "m3.css",
);
writeFileSync(out, css);
console.log(`written: ${out}`);
