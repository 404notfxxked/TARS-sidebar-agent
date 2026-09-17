// e2e 套件 runner:按影响面挑套件跑,不必每次全量回归。
// 用法:
//   node tests/run.mjs                  # 列出全部域与用法(不跑)
//   node tests/run.mjs memory mcp       # 只跑指定域(顺序执行,汇总退出码)
//   node tests/run.mjs --all            # 全量(发版/横切重构才需要)
// 前置:pnpm build(本脚本只提醒 dist 过期,不代跑)。
// 单元测试不在这里:pnpm test(vitest,秒级,改纯逻辑就该跑)。

import { spawnSync } from "node:child_process";
import { statSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 域名 → 脚本。断言型套件(verify-* + 带断言的探针);纯视觉截图的
// shot-m3 不进 --all(人看产物,不判 PASS/FAIL),要跑直接 node tests/shot-m3.mjs
const SUITES = {
  memory: "verify-memory.mjs",
  skills: "verify-skills.mjs",
  mcp: "verify-mcp.mjs",
  persist: "verify-persist.mjs",
  compaction: "verify-compaction.mjs",
  "web-search": "verify-web-search.mjs",
  vision: "verify-vision.mjs",
  screenshot: "verify-screenshot.mjs",
  cancel: "verify-cancel.mjs",
  "llm-errors": "verify-llm-errors.mjs",
  interact: "verify-interact.mjs",
  confirm: "verify-confirm.mjs",
  layout: "probe-layout.mjs", // 契约 6 悬浮层硬规则的断言防线
  locale: "probe-locale.mjs", // 语言切换行为(带断言)
  focus: "probe-focus.mjs", // 焦点流(autofocus/悬浮层回归/运行中可输入)+ 回到底部 + 模型键盘导航
  "tool-labels": "probe-en-tools.mjs", // 英文界面下工具名走面板字典(SW 中文名不泄漏)
  actions: "probe-actions.mjs", // 消息动作行:复制(剪贴板) + 末条重新生成(截库重跑,两条挂点)
  quote: "probe-quote.mjs", // 每日一句:缓存 miss 不跳变/出处悬停显形/设置开关与持久化
};

// ---- 参数解析 ----
const argv = process.argv.slice(2);
const wantsAll = argv.includes("--all");
const asked = wantsAll ? Object.keys(SUITES) : argv.filter((a) => !a.startsWith("-"));

if (asked.length === 0) {
  console.log("e2e 套件按域组织 —— 改哪块跑哪块,全量留给发版与横切重构:\n");
  for (const [domain, script] of Object.entries(SUITES)) {
    console.log(`  ${domain.padEnd(12)} ${script}`);
  }
  console.log(
    "\n用法: node tests/run.mjs <域...> | --all" +
      "\n单元测试: pnpm test(纯逻辑层,秒级)" +
      "\n各域覆盖明细见 tests/README.md",
  );
  process.exit(0);
}

const unknown = asked.filter((a) => !(a in SUITES));
if (unknown.length > 0) {
  console.error(`❌ 未知域: ${unknown.join(", ")}(无参运行可看清单)`);
  process.exit(2);
}

// ---- UI 文案断言规范检查(任何 e2e 运行前强制;规范见 tests/README.md)----
const guard = spawnSync("node", [join(__dirname, "check-test-strings.mjs")], {
  stdio: "inherit",
});
if (guard.status !== 0) {
  console.error("\n先修复上面的硬编码文案,再跑套件。");
  process.exit(2);
}

// ---- dist 陈旧提醒(src 比 dist 新 = 大概率忘了 build)----
const newestSrc = (() => {
  let newest = 0;
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else newest = Math.max(newest, st.mtimeMs);
    }
  };
  walk(resolve(__dirname, "..", "src"));
  return newest;
})();
const distMtime = existsSync(resolve(__dirname, "..", "dist"))
  ? statSync(resolve(__dirname, "..", "dist")).mtimeMs
  : 0;
if (newestSrc > distMtime) {
  console.log(
    "⚠️  src/ 比 dist/ 新 —— 套件跑的是旧构建。先 pnpm build,再重跑。\n",
  );
}

// ---- 顺序执行 ----
// 单套件保险丝:浏览器僵死/WS 挂住时不至于无限等(本地没有 CI job 级
// 45min 熔断)。默认 15 分钟,可用 RUN_SUITE_TIMEOUT_MS 覆盖。
const SUITE_TIMEOUT_MS = Number(process.env.RUN_SUITE_TIMEOUT_MS ?? 15 * 60_000);
const results = [];
for (const domain of asked) {
  const script = SUITES[domain];
  console.log(`\n════════ ${domain}(${script})════════`);
  const startedAt = Date.now();
  const r = spawnSync("node", [join(__dirname, script)], {
    stdio: "inherit",
    timeout: SUITE_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const timedOut = r.signal === "SIGKILL";
  if (timedOut) {
    console.error(`\n⏱️ ${domain} 超过 ${SUITE_TIMEOUT_MS / 1000}s 被强杀(疑似挂死),记 FAIL`);
  }
  results.push({
    domain,
    ok: r.status === 0 && !timedOut,
    seconds: ((Date.now() - startedAt) / 1000).toFixed(1),
  });
}

// ---- 汇总 ----
console.log("\n════════ 汇总 ════════");
for (const r of results) {
  console.log(`  ${r.ok ? "✅" : "❌"} ${r.domain.padEnd(12)} ${r.seconds}s`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(
  failed === 0
    ? `\n✅ ${results.length} 套全 PASS`
    : `\n❌ ${failed}/${results.length} 套 FAIL`,
);
process.exit(failed === 0 ? 0 : 1);
