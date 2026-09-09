// i18n 键位静态检查(随 pnpm build 自动执行):
// 1. 扫描 src/sidepanel 的 t("...") 静态键,逐一核对 zh-CN 字典 —— 缺键 FAIL
//    (否则上线就是用户可见的裸键名,如 "sessions.weekday.fr")
// 2. 发现动态拼键 t(`a.b.${x}`) 直接 FAIL —— 动态拼键绕过本检查
//    (compactEarly 漏键即此形态),键映射一律写字面量
// 用法: 随 build 自动跑,或 node scripts/check-i18n.mjs
import { readFileSync, readdirSync, statSync, rmSync, mkdtempSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, "..", "src", "sidepanel");

// ---- 1) 收集键:按命名空间扫描全部字符串字面量(覆盖 t() 直呼与
//         KEY_MAP 字面量映射两种写法) ----
const NS = /^(common|chat|sessions|memory|settings)(\.[A-Za-z0-9_]+)+$/;
const staticKeys = new Set();
const dynamicUsages = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p);
      continue;
    }
    if (!/\.(tsx|ts)$/.test(name)) continue;
    const src = readFileSync(p, "utf-8");
    for (const m of src.matchAll(/"([^"\n]+)"/g)) {
      if (NS.test(m[1])) staticKeys.add(m[1]);
    }
    for (const m of src.matchAll(/\bt\(`([^`]+)`\)/g)) {
      dynamicUsages.push({ file: name, expr: m[1] });
    }
  }
};
walk(SRC);

// ---- 2) esbuild 转译字典并加载 ----
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

const resolvePath = (path) =>
  path
    .split(".")
    .reduce((o, k) => (o == null || typeof o !== "object" ? undefined : o[k]), zhCN);

// ---- 3) 校验 ----
const missing = [...staticKeys].filter((k) => typeof resolvePath(k) !== "string");

let failed = false;
if (dynamicUsages.length > 0) {
  failed = true;
  console.log("❌ 发现动态拼键(绕过静态检查,一律改为字面量键映射):");
  for (const u of dynamicUsages) console.log(`   ${u.file}: t(\`${u.expr}\`)`);
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
