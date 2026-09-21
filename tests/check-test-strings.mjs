// UI 文案断言规范检查(规范全文见 tests/README.md「UI 文案断言规范」):
// 测试脚本的用户可见文案断言一律经 lib-i18n.mjs 的 zh/en 按键取用,
// 字典改文案断言自动跟随。2026-09-17 反转升级:旧规则只抓「与字典值
// 逐字相等」,插值填参(已写入 {n} → 已写入 1 条)与子串绑定
// (includes("回车提交"))全部漏放——两类绕过都曾被实锤。
// 现行三类漂移形态(仅对 zh 字典做模糊匹配;en 值 ASCII,只查精确相等):
//   A. 字面量与字典值逐字相等(双/单引号/模板串静态段)
//   B. 字面量(≥3 字;选择器内层 ≥2)是某字典值的子串 —— 断言绑定了
//      字典措辞的片段
//   C. 字面量(≥4 字)以某含占位符字典值的首段开头 —— 占位符填参形态
// 扫描面:tests/*.mjs + src/**/*.test.ts(x)(组件测试的期望串同样
// 必须从 zhCN 派生,AGENTS.md 硬规则 6)。
// 2026-09-21 补嵌套引号盲区:选择器形态行(含 [ / ^= / *= / :has-text /
// aria-label / alt=)的外层字面量,再抽一层内层引号子串(单外抽双内、
// 双外抽单内、模板两者)套用同一 driftKind——'img[alt^="待发送图片"]'
// 这类手抄由此入闸。仍只对选择器形态行生效:断言标签天然含功能名词,
// 无差别做「包含」方向会被标签假阳性淹没(2026-09-17 实测 39 命中里
// 近 30 条是标签),这条限定就是把标签排除在外。
// 命中即 FAIL;两类豁免:
//   ① 行内标注 i18n-ok(合法场景见 README:后端日志语义 / 子串选择器
//     与源码同文不同源 / 测试种子与 mock 内容);
//   ② check/ok/assert/fail/console.log 的第一个参数(断言标签与诊断
//     横幅是人读的测试输出,不是 UI 断言,措辞随功能名走是正常的)。
//   设计上刻意不做「字面量包含字典值」方向:断言标签天然含功能名词,
//   该方向假阳性淹没信号(2026-09-17 语料实测 39 命中里近 30 条是标签)。
// 已知局限(记录不掩盖):跨行模板串、正则字面量里的 CJK 不在扫描范围;
// 转义引号:单/双引号外层的同型转义内层(如 \"…\")不抽,模板串外层会
// 抽出(内层正则不识别反斜杠,捕获可能带尾随反斜杠)。
// 用法:node tests/check-test-strings.mjs;run.mjs 每次入口自动执行。
import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from "fs";
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

const zhValues = await loadValues("zh-CN.ts");
const enValues = await loadValues("en-US.ts");

const CJK = /[\u4e00-\u9fff]/;
// 含占位符字典值的首段(首个 {xx} 之前的部分),去空白后 ≥3 字才参与 C 规则
const leadSegment = (v) => (v.split(/\{[a-zA-Z]+\}/)[0] ?? "").trim();
const zhLeads = [...zhValues]
  .filter((v) => /\{[a-zA-Z]+\}/.test(v))
  .map(leadSegment)
  .filter((s) => s.length >= 3);

/** 返回字面量命中的漂移形态描述,null = 干净。minSub = 方向 B 的字长
 *  下限:全局路径保持 3(断言标签天然含功能名词,更低会把标签卷进
 *  「包含」方向),选择器内层传 2 收两字手抄(如 alt^="图片") */
function driftKind(s, minSub = 3) {
  if (zhValues.has(s) || enValues.has(s)) return "逐字等于字典值";
  if (!CJK.test(s)) return null; // 非中文不做模糊匹配(en 值已查精确相等)
  for (const v of zhValues) {
    if (s.length >= minSub && v.includes(s) && s !== v) return `是字典值「${v.slice(0, 24)}…」的子串`;
  }
  for (const lead of zhLeads) {
    if (s.length >= 4 && s.startsWith(lead)) return `以占位符字典值首段「${lead}」开头`;
  }
  return null;
}

let failed = false;
const report = (f, ln, s, kind) => {
  failed = true;
  console.log(
    `❌ ${f}:${ln} 疑似绑定 UI 文案(${kind}):"${s.slice(0, 40)}" —— 改用 lib-i18n.mjs 字典键,或行内标注 i18n-ok`,
  );
};

// 扫描面:tests/*.mjs(lib-i18n/check-test-strings 自身除外)+
// src/**/*.test.ts(x)。label 用于报告输出(src 侧带路径,tests 侧沿用文件名)
const listTargets = () => {
  const targets = [];
  for (const f of readdirSync(__dirname).filter(
    (x) => x.endsWith(".mjs") && x !== "lib-i18n.mjs" && x !== "check-test-strings.mjs",
  )) {
    targets.push({ label: f, path: join(__dirname, f) });
  }
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        walk(p, join(rel, name));
      } else if (/\.test\.tsx?$/.test(name)) {
        targets.push({ label: join(rel, name), path: p });
      }
    }
  };
  walk(resolve(__dirname, "..", "src"), "src");
  return targets;
};

// 选择器形态行:外层字面量里嵌的内层引号串也要过闸(嵌套引号盲区)
const SELECTOR_LINE = /\[|\^=|\*=|:has-text|aria-label|alt=/;

for (const { label: f, path } of listTargets()) {
  const lines = readFileSync(path, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (line.trimStart().startsWith("//") || line.includes("i18n-ok")) return;
    const selectorLine = SELECTOR_LINE.test(line);
    // 双引号 / 单引号 / 模板串;模板串剥掉 ${...} 插值后按静态段校验
    for (const m of line.matchAll(
      /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g,
    )) {
      const raw = m[1] ?? m[2] ?? m[3] ?? "";
      // 断言标签/诊断横幅(check/ok/assert/fail/console.log 的第一个
      // 参数)是人读的测试输出,措辞随功能名走是正常的,整体跳过
      const before = line.slice(Math.max(0, m.index - 24), m.index);
      if (/(?:check|ok|assert|fail|console\.log)\s*\(\s*$/.test(before)) continue;
      const parts = m[3] !== undefined ? raw.split(/\$\{[^}]*\}/) : [raw];
      for (const part of parts) {
        const s = part.trim();
        if (!s) continue;
        const kind = driftKind(s);
        if (kind) report(f, i + 1, s, kind);
      }
      if (selectorLine) {
        // 内层引号子串:单外层抽双引号,双外层抽单引号,模板两者都抽
        // (下限 2:两字内层手抄也入闸;全局路径保持 3 防标签假阳性)
        const innerRe =
          m[1] !== undefined ? /'([^']*)'/g : m[2] !== undefined ? /"([^"]*)"/g : /"([^"]*)"|'([^']*)'/g;
        for (const n of raw.matchAll(innerRe)) {
          const s = (n[1] ?? n[2] ?? "").trim();
          if (!s) continue;
          const kind = driftKind(s, 2);
          if (kind) report(f, i + 1, s, `选择器内嵌文案(${kind})`);
        }
      }
    }
  });
}
console.log(failed ? "UI 文案断言规范检查失败" : "✅ 测试脚本无硬编码 UI 文案");
process.exit(failed ? 1 : 0);
