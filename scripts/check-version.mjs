// 版本号单一来源校验:manifest.json 与 package.json 必须同版本。
// 发版时两处一起改(或等将来引入发版脚本从此处生成);漂移即构建失败。
// 用法:随 pnpm build 自动执行,或 node scripts/check-version.mjs
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const manifest = JSON.parse(
  readFileSync(resolve(root, "public", "manifest.json"), "utf8"),
);

if (pkg.version !== manifest.version) {
  console.error(
    `❌ 版本号漂移:package.json=${pkg.version}, manifest.json=${manifest.version}。\n` +
      "   两处需同版本:发版时同步修改,或改造发版脚本从单一来源生成。",
  );
  process.exit(1);
}
console.log(`✅ 版本一致:${pkg.version}`);
