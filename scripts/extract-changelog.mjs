// 从 CHANGELOG.md 抽取指定版本的段落,作为 GitHub Release 的发布说明。
// 用法:node scripts/extract-changelog.mjs v1.3.0(带不带 v 前缀均可);
// 随 .github/workflows/release.yml 在打 tag 后自动执行,输出到 stdout。
// 匹配 `## [x.y.z]` 标题,截到下一个 `## [` 标题为止;缺段即非零退出——
// 发版三步(m bump → CHANGELOG 定版 → tag)没走完就打 tag,在这里拦下。
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const raw = process.argv[2];
const version = raw?.replace(/^v/, "");
if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`用法:node scripts/extract-changelog.mjs <版本号>,收到:"${raw ?? ""}"`);
  process.exit(1);
}

const md = readFileSync(resolve(root, "CHANGELOG.md"), "utf8");
const heading = new RegExp(`^## \\[${version}\\]([^\\n]*)\\n`, "m");
const start = md.search(heading);
if (start === -1) {
  console.error(
    `❌ CHANGELOG.md 里没有 [${version}] 段——按发版三步先定版再打 tag:\n` +
      `   把 [Unreleased] 中本版本的内容移入 "## [${version}] - 日期",另开空 Unreleased。`,
  );
  process.exit(1);
}
const rest = md.slice(start);
const next = rest.slice(1).search(/^## \[/m); // 从标题行之后找下一个版本标题
const section = (next === -1 ? rest : rest.slice(0, next + 1)).trim();

if (!section.replace(/^## \[[^\]]*\][^\n]*\n*/, "").trim()) {
  console.error(`❌ CHANGELOG.md 的 [${version}] 段是空的,无可发布内容。`);
  process.exit(1);
}
process.stdout.write(`${section}\n`);
