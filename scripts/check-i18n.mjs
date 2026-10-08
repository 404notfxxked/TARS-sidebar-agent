// i18n 键位静态检查(随 pnpm build 自动执行):
// 1. 扫描 src/sidepanel 与 src/shared 的字符串字面量(双/单引号),凡
//    命名空间键形态的逐一核对 zh-CN 字典 —— 缺键 FAIL
//    (否则上线就是用户可见的裸键名,如 "sessions.weekday.fr")
// 2. 发现动态拼键 t(`a.b.${x}`) 与字面量拼接 t("a.b." + x) 直接 FAIL
//    —— 动态拼键绕过本检查(compactEarly 漏键即此形态),键映射一律写字面量
// 扫描面不含 src/content(经典脚本,文案不走 shared 字典)与
// src/background(SW 侧文案不经字典属 AGENTS.md「文案」节的已知债务,
// 纳入先立设计决定)。命名空间白名单从字典顶层键派生,不手抄 ——
// 手抄名单会腐化:新增命名空间的键既不被收集、也不被报缺键,typo 直接上屏。
// 用法: 随 build 自动跑,或 node scripts/check-i18n.mjs
import { readFileSync, readdirSync, statSync, rmSync, mkdtempSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- 1) esbuild 转译字典并加载(命名空间集合与键校验同一真源) ----
const tmp = mkdtempSync(join("/tmp", "i18n-check-"));
await esbuild.build({
  entryPoints: [resolve(__dirname, "..", "src", "shared", "i18n", "locales", "zh-CN.ts")],
  outfile: join(tmp, "zh-CN.mjs"),
  bundle: true,
  format: "esm",
  write: true,
  logLevel: "silent",
});
const { zhCN } = await import(join(tmp, "zh-CN.mjs"));
rmSync(tmp, { recursive: true, force: true });

const NS = new RegExp(`^(${Object.keys(zhCN).join("|")})(\\.[A-Za-z0-9_]+)+$`);

// ---- 2) 收集键:扫描面内全部字符串字面量(覆盖 t() 直呼与 KEY_MAP
//         字面量映射两种写法) ----
const SRCS = [
  resolve(__dirname, "..", "src", "sidepanel"),
  resolve(__dirname, "..", "src", "shared"),
];
const staticKeys = new Set();
const dynamicUsages = [];
const walk = (root) => {
  const rec = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        rec(p);
        continue;
      }
      if (!/\.(tsx|ts)$/.test(name)) continue;
      const src = readFileSync(p, "utf-8");
      for (const m of src.matchAll(/"([^"\n]+)"|'([^'\n]+)'/g)) {
        const s = m[1] ?? m[2];
        if (NS.test(s)) staticKeys.add(s);
      }
      for (const m of src.matchAll(/\bt\(`([^`]+)`\)/g)) {
        dynamicUsages.push({ file: name, expr: `t(\`${m[1]}\`)` });
      }
      for (const m of src.matchAll(/\bt\(\s*(["'])[^"'\n]*\1\s*\+/g)) {
        dynamicUsages.push({ file: name, expr: `${m[0].trimEnd()} …)` });
      }
    }
  };
  rec(root);
};
for (const root of SRCS) walk(root);

const resolvePath = (path) =>
  path
    .split(".")
    .reduce((o, k) => (o == null || typeof o !== "object" ? undefined : o[k]), zhCN);

// ---- 3) 校验 ----
const missing = [...staticKeys].filter((k) => typeof resolvePath(k) !== "string");

let failed = false;
if (dynamicUsages.length > 0) {
  failed = true;
  console.log("❌ 发现动态拼键/拼接键(绕过静态检查,一律改为字面量键映射):");
  for (const u of dynamicUsages) console.log(`   ${u.file}: ${u.expr}`);
}
if (missing.length > 0) {
  failed = true;
  console.log("❌ 字典缺失键:");
  for (const k of missing) console.log(`   ${k}`);
}
console.log(
  failed
    ? `检查失败(静态键 ${staticKeys.size} 个)`
    : `✅ i18n 键位全部命中(静态键 ${staticKeys.size} 个)`,
);
process.exit(failed ? 1 : 0);
