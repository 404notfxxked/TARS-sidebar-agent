// 版本号单一来源校验:manifest.json 与 package.json 必须同版本。
// 发版时两处一起改(或等将来引入发版脚本从此处生成);漂移即构建失败。
// 用法:随 pnpm build 自动执行,或 node scripts/check-version.mjs;
// release 工作流额外传 tag 版本做三方校验:
//   node scripts/check-version.mjs v1.3.0 → tag = package.json = manifest
//   (tag 与包版本对不上就发错包,在打 zip 前拦下)
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

const tag = process.argv[2]?.replace(/^v/, "");
if (tag !== undefined && tag !== pkg.version) {
  console.error(
    `❌ tag 版本与包版本不一致:tag=v${tag}, package.json/manifest.json=${pkg.version}。\n` +
      "   发版前把两处版本号 bump 到与 tag 相同(或删 tag 重打)。",
  );
  process.exit(1);
}

console.log(
  tag !== undefined
    ? `✅ 三方版本一致:tag=v${tag} = package.json = manifest.json`
    : `✅ 版本一致:${pkg.version}`,
);
