// 从源色生成 M3 scheme CSS 变量(亮 / 暗两套),写入 src/sidepanel/styles/m3.css。
// 跑法:pnpm tokens:m3;产物是生成文件,提交入库,运行时零依赖。
//
// 重点色:ACCENTS 里每个源色各生成 浅色 + 暗色 两套 scheme。浅色挂
// html[data-accent](默认 green 不用属性);暗色挂 [data-theme][data-accent]
// 组合(特异性 0,2,0,同时存在两属性时必然胜出)。石墨是手工 monochrome
// (灰源色经 CAM16 会偏蓝,按 M3 monochrome 规范用 neutral 色调生成)。
//
// 画布中性化:surface 七角色(surface/dim/container 五级)不取各重点色自己的
// neutral 色板,统一用纯中性灰阶(chroma 0)—— 背景画布只有浅灰/深灰两套,
// 不随重点色漂移、不带任何色相倾向(带暖相的画布与绿/蓝系重点色互相打架,
// 评审 2026-09-18),重点色只落在交互角色上。
// 暗色 ramp 相比 M3 官方 tone 整体抬高(surface 6→10),不再刺黑。
//
// 注:@material/material-color-utilities 锁 0.3.0(0.4.x 的 ESM 打包缺扩展名,Node 无法加载)。
// 0.3.0 的 scheme 缺 surfaceContainer* 五级,这里按 M3 官方规范用 neutral 色板补齐:
//   light: Lowest 100 / Low 96 / 94 / High 92 / Highest 90,surface 98,dim 87,bright 98
//   dark:  Lowest   7 / Low 14 / 16 / High 21 / Highest 26,surface 10,dim 10(较官方抬亮,柔和不刺黑)
import {
  themeFromSourceColor,
  hexFromArgb,
  argbFromHex,
  TonalPalette,
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

const _DEFAULT = ACCENTS[0];

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

/** surface 五级 + dim:neutral 色板 tone(亮暗各一组)。
 *  亮色沿用 M3 官方 tone;暗色整体抬亮(官方 4~22 → 7~26),深色画布呈柔炭灰
 *  而非近黑,层次差保留(级差最小 2,海拔关系与官方一致) */
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
    surface: 10,
    "surface-dim": 10,
    "surface-container-lowest": 7,
    "surface-container-low": 14,
    "surface-container": 16,
    "surface-container-high": 21,
    "surface-container-highest": 26,
  },
};

/** 画布专用 neutral 色板:纯中性灰阶(chroma 0),所有重点色共用。
 *  暖相画布与绿/蓝系重点色打架(评审 2026-09-18),色相倾向归零 */
const surfaceNeutral = TonalPalette.fromHueAndChroma(0, 0);

// ---- 生成 ----
const themes = ACCENTS.map((a) => ({
  ...a,
  theme: themeFromSourceColor(argbFromHex(a.source)),
}));

/** M3 monochrome:所有色彩角色全部取 neutral 色调,只剩明度差(极简灰阶)。
 *  色调表按 M3 monochrome 对比规范(亮:40/100/90/10,暗:80/20/30/90)。
 *  error 四角色不在此表:error 是语义不是审美,M3 规范里 error 调色板
 *  固定红系、不随源色走 —— 石墨主题下错误气泡/危险动作必须仍然是红,
 *  否则破坏性操作与普通信息不可区分(见 design/design-review-2026-09.md P0-1) */
const MONO_TONES = {
  light: {
    primary: 40, onPrimary: 100, primaryContainer: 90, onPrimaryContainer: 10,
    secondary: 40, secondaryContainer: 90, onSecondaryContainer: 10,
    tertiary: 40, tertiaryContainer: 90, onTertiaryContainer: 10,
    onSurface: 10, onSurfaceVariant: 40, outline: 50, outlineVariant: 80,
    inverseSurface: 20, inverseOnSurface: 100, inversePrimary: 80,
  },
  dark: {
    primary: 80, onPrimary: 20, primaryContainer: 30, onPrimaryContainer: 90,
    secondary: 80, secondaryContainer: 30, onSecondaryContainer: 90,
    tertiary: 80, tertiaryContainer: 30, onTertiaryContainer: 90,
    onSurface: 90, onSurfaceVariant: 80, outline: 60, outlineVariant: 30,
    inverseSurface: 90, inverseOnSurface: 20, inversePrimary: 40,
  },
};

/** mono 主题的 error 四角色:从固定红系 error 调色板取 tone
 *  (色调映射与 MONO_TONES 同规范:亮 40/100/90/10,暗 80/20/30/90) */
const MONO_ERROR_TONES = {
  light: {
    error: 40, onError: 100, errorContainer: 90, onErrorContainer: 10,
  },
  dark: {
    error: 80, onError: 20, errorContainer: 30, onErrorContainer: 90,
  },
};

function linesFor(theme, mode, mono) {
  const neutral = theme.palettes.neutral;
  const errorPalette = theme.palettes.error;
  const roles = mono ? MONO_TONES[mode] : null;
  const errorTones = mono ? MONO_ERROR_TONES[mode] : null;
  const lines = Object.entries(SCHEME_ROLES).map(([role, cssName]) => {
    // mono:error 角色固定取红系调色板,其余取 neutral(见 MONO_ERROR_TONES 注)
    if (roles && errorTones && role in errorTones) {
      return `  --md-sys-color-${cssName}: ${hexFromArgb(errorPalette.tone(errorTones[role]))};`;
    }
    const value = roles
      ? hexFromArgb(neutral.tone(roles[role]))
      : hexFromArgb(theme.schemes[mode][role]);
    return `  --md-sys-color-${cssName}: ${value};`;
  });
  for (const [name, tone] of Object.entries(SURFACE_TONES[mode])) {
    // surface 用全局固定暖色画布,不取各主题自己的 neutral(画布不随重点色漂移)
    lines.push(`  --md-sys-color-${name}: ${hexFromArgb(surfaceNeutral.tone(tone))};`);
  }
  return lines.join("\n");
}

const wrap = (selector, lines) => `${selector} {\n${lines}\n}`;

const lightBlocks = [
  // 默认(青绿)= :root,不带属性即生效
  wrap(":root", linesFor(themes[0].theme, "light", false)),
  // 其余重点色挂 data-accent,置于 :root 之后覆盖浅色
  ...themes.slice(1).map((a) =>
    wrap(`[data-accent="${a.id}"]`, linesFor(a.theme, "light", a.mono)),
  ),
].join("\n\n");

const darkBlocks = [
  // 默认(青绿)暗色 = [data-theme],不带 accent 属性即生效
  wrap('[data-theme="dark"]', linesFor(themes[0].theme, "dark", false)),
  // 深色 + 重点色:双属性组合(特异性 0,2,0),压过单属性的两套
  ...themes.slice(1).map((a) =>
    wrap(
      `[data-theme="dark"][data-accent="${a.id}"]`,
      linesFor(a.theme, "dark", a.mono),
    ),
  ),
].join("\n\n");

const css = `/* ---- M3 scheme(生成文件,勿手改)----
   由 scripts/generate-m3.mjs 从 ACCENTS 各源色经 material-color-utilities 生成。
   surface 七角色用共用的纯中性灰阶色板(chroma 0):
   浅色 = 浅灰,暗色 = 柔炭灰(整体抬亮),背景画布不随重点色漂移;
   其余角色(交互色/文字/描边)按各重点色生成。
   默认青绿 = :root / [data-theme="dark"];其余重点色 = [data-accent] 与
   [data-theme="dark"][data-accent](深浅各一套,深浅切换 + 重点色切换全生效)。
   重新生成:pnpm tokens:m3 */

${lightBlocks}

${darkBlocks}
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
