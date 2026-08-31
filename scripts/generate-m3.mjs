// 从源色生成 M3 scheme CSS 变量(亮 / 暗两套),写入 src/sidepanel/styles/m3.css。
// 跑法:pnpm tokens:m3;产物是生成文件,提交入库,运行时零依赖。
//
// 重点色:ACCENTS 里每个源色一套浅色 scheme,挂 html[data-accent] 切换
// (默认 green 不用属性)。深色暂不跟随重点色([data-theme] 在最后,优先级最高,
// 深色恒为默认绿)—— 深色各重点色的 surface 色调待定稿后统一生成。
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

/** 试色候选:主流产品的代表性源色(同一生成器保证各自和谐) */
const ACCENTS = [
  // 默认:品牌绿(现役)
  { id: "green", label: "青绿", source: "#16a34a" },
  // Google Workspace 蓝:干净、清爽的主流蓝
  { id: "ocean", label: "湖蓝", source: "#0b57d0" },
  // Material Teal:经典的清爽青碧
  { id: "teal", label: "青碧", source: "#0d9488" },
  // Tailwind indigo-600:现代 SaaS 感(Linear/Vercel 一脉)
  { id: "indigo", label: "靛蓝", source: "#4f46e5" },
  // M3 baseline 紫:Material You 的官方默认源色
  { id: "lilac", label: "丁香", source: "#6750a4" },
  // 暖色家族:珊瑚橙(Tailwind orange-600)
  { id: "coral", label: "珊瑚", source: "#ea580c" },
  // 玫红(Tailwind rose-600)
  { id: "rose", label: "玫红", source: "#e11d48" },
  // 真·单色石墨:M3 monochrome 对比(灰源色经 CAM16 会偏蓝,需手工按 neutral 色调生成)
  { id: "graphite", label: "石墨", source: "#5f6368", mono: true },
];

const DEFAULT = ACCENTS[0];

/** scheme 里直接存在的角色 → CSS 名(M3 官方 sys token 命名:--md-sys-color-*) */
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

// ---- 生成 ----
const themes = ACCENTS.map((a) => ({
  ...a,
  theme: themeFromSourceColor(argbFromHex(a.source)),
}));

function block(selector, theme) {
  const neutral = theme.palettes.neutral;
  const lines = Object.entries(SCHEME_ROLES).map(
    ([role, cssName]) => `  --md-sys-color-${cssName}: ${hexFromArgb(theme.schemes.light[role])};`,
  );
  for (const [name, tone] of Object.entries(SURFACE_TONES.light)) {
    lines.push(`  --md-sys-color-${name}: ${hexFromArgb(neutral.tone(tone))};`);
  }
  return `${selector} {\n${lines.join("\n")}\n}`;
}

function darkBlock(theme) {
  const neutral = theme.palettes.neutral;
  const lines = Object.entries(SCHEME_ROLES).map(
    ([role, cssName]) => `  --md-sys-color-${cssName}: ${hexFromArgb(theme.schemes.dark[role])};`,
  );
  for (const [name, tone] of Object.entries(SURFACE_TONES.dark)) {
    lines.push(`  --md-sys-color-${name}: ${hexFromArgb(neutral.tone(tone))};`);
  }
  return lines.join("\n");
}

/** M3 monochrome:所有色彩角色全部取 neutral 色调,只剩明度差(极简灰阶)。
 *  色调表按 M3 monochrome 对比规范(亮:40/100/90/10,暗:80/20/30/90) */
const MONO_TONES = {
  light: {
    primary: 40, onPrimary: 100, primaryContainer: 90, onPrimaryContainer: 10,
    secondary: 40, secondaryContainer: 90, onSecondaryContainer: 10,
    tertiary: 40, tertiaryContainer: 90, onTertiaryContainer: 10,
    error: 40, onError: 100, errorContainer: 90, onErrorContainer: 10,
    onSurface: 10, onSurfaceVariant: 40, outline: 50, outlineVariant: 80,
    inverseSurface: 20, inverseOnSurface: 100, inversePrimary: 80,
  },
};

function monoBlock(selector, theme) {
  const neutral = theme.palettes.neutral;
  const lines = Object.entries(SCHEME_ROLES).map(
    ([role, cssName]) =>
      `  --md-sys-color-${cssName}: ${hexFromArgb(neutral.tone(MONO_TONES.light[role]))};`,
  );
  for (const [name, tone] of Object.entries(SURFACE_TONES.light)) {
    lines.push(`  --md-sys-color-${name}: ${hexFromArgb(neutral.tone(tone))};`);
  }
  return `${selector} {\n${lines.join("\n")}\n}`;
}

const lightBlocks = [
  // 默认(青绿)= :root,不带属性即生效
  block(":root", themes[0].theme),
  // 其余试色挂 data-accent,置于 :root 之后覆盖浅色
  ...themes.slice(1).map((a) =>
    a.mono
      ? monoBlock(`[data-accent="${a.id}"]`, a.theme)
      : block(`[data-accent="${a.id}"]`, a.theme),
  ),
].join("\n\n");

const css = `/* ---- M3 scheme(生成文件,勿手改)----
   由 scripts/generate-m3.mjs 从 ACCENTS 各源色经 material-color-utilities 生成
   (surfaceContainer* 按 M3 规范取 neutral 色板 tone,见脚本内注释)。
   默认青绿 = :root;试色挂 html[data-accent="id"](仅浅色,深色待定稿后统一做)。
   重新生成:pnpm tokens:m3 */

${lightBlocks}

[data-theme="dark"] {
${darkBlock(themes[0].theme)}
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
console.log(
  `written: ${out}\n` +
    themes.map((t) => `  ${t.id}(${t.label}) ${t.source}`).join("\n"),
);
