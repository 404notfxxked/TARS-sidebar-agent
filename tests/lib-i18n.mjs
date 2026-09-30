// 测试断言的 UI 文案来源:esbuild 加载双语字典,断言按键取文案。
// 规范(tests/README.md「UI 文案断言规范」):用户可见文案禁止写成字面量,
// 一律 `zh.chat.openSettings` / `en.memory.pin` 取用 —— 字典改文案,断言
// 自动跟随;字面量仅允许 后端日志语义 / wire-DB 值 / 第三方文案。
// tests/check-test-strings.mjs 在 run.mjs 入口强制此规则(字面量命中字典
// 值即 FAIL)。
import { mkdtempSync, rmSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCALES = resolve(__dirname, "..", "src", "shared", "i18n", "locales");

async function loadLocale(file) {
  const tmp = mkdtempSync(join("/tmp", "tars-dict-"));
  try {
    await esbuild.build({
      entryPoints: [join(LOCALES, file)],
      outfile: join(tmp, "out.mjs"),
      bundle: true,
      format: "esm",
      write: true,
      logLevel: "silent",
    });
    const mod = await import(join(tmp, "out.mjs"));
    return Object.values(mod)[0];
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export const zh = await loadLocale("zh-CN.ts");
export const en = await loadLocale("en-US.ts");

/** 拼 RegExp 用:转义文案里的正则元字符(? . % 均可能出现) */
export function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 空态标题按时段定档(早/中/下午/晚/深夜 5 档),断言「任一档可见」。
 *  e2e 共用:verify-persist / probe-locale 曾各自手抄一份 */
export function greetRe(dict) {
  return new RegExp(
    "^(?:" +
      ["greetMorning", "greetNoon", "greetAfternoon", "greetEvening", "greetLateNight"]
        .map((k) => escapeRegExp(dict.chat[k]))
        .join("|") +
      ")$",
  );
}
