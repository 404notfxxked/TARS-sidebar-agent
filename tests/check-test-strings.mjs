// UI 文案断言规范检查(规范全文见 tests/README.md「UI 文案断言规范」):
// 测试脚本禁止出现与字典值逐字相等的字符串字面量 —— 用户可见文案一律经
// lib-i18n.mjs 的 zh/en 按键取用,字典改文案断言自动跟随。
// 白名单:行内标注 i18n-ok(日志语义 / 子串选择器等同文不同源场景)。
// 用法:node tests/check-test-strings.mjs;run.mjs 每次入口自动执行。
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCALES = resolve(__dirname, "..", "src", "shared", "i18n", "locales");

async function loadValues(file) {
  const tmp = mkdtempSync(join("/tmp", "check-strings-"));
  await esbuild.build({
    entryPoints: [join(LOCALES, file)],
    outfile: join(tmp, "out.mjs"),
    bundle: true,
    format: "esm",
    write: true,
    logLevel: "silent",
  });
  const mod = await import(join(tmp, "out.mjs"));
  rmSync(tmp, { recursive: true, force: true });
  const values = new Set();
  (function flat(o) {
    for (const v of Object.values(o)) typeof v === "string" ? values.add(v) : flat(v);
  })(Object.values(mod)[0]);
  return values;
}

const values = new Set([...(await loadValues("zh-CN.ts")), ...(await loadValues("en-US.ts"))]);

let failed = false;
for (const f of readdirSync(__dirname).filter(
  (x) => x.endsWith(".mjs") && x !== "lib-i18n.mjs" && x !== "check-test-strings.mjs",
)) {
  const lines = readFileSync(join(__dirname, f), "utf8").split("\n");
  lines.forEach((line, i) => {
    if (line.trimStart().startsWith("//") || line.includes("i18n-ok")) return;
    for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
      if (values.has(m[1])) {
        failed = true;
        console.log(
          `❌ ${f}:${i + 1} 硬编码 UI 文案 "${m[1].slice(0, 40)}" —— 改用 lib-i18n.mjs 字典键,或行内标注 i18n-ok`,
        );
      }
    }
  });
}
console.log(failed ? "UI 文案断言规范检查失败" : "✅ 测试脚本无硬编码 UI 文案");
process.exit(failed ? 1 : 0);
