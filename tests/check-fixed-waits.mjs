// 固定等待计数棘轮(AGENTS.md 硬规则 3「e2e 等待一律事件驱动/轮询」的配套):
// 统计每个测试脚本里两种固定等待形态的出现次数,与下方基线表逐一比较——
//   形态 1:await sleep(<数字>)
//   形态 2:await new Promise((r) => setTimeout(r, <数字>))
// 超基线即 FAIL(报出文件 + 实测 + 基线)。基线 = 2026-09-21 修掉
// probe-actions / probe-locale 两处承重等待(sleep 代轮询)后的实测数;
// 之后只降不升。确属必须的新增固定等待(如等外部 TTL),同步抬高基线并
// 在改动说明里给理由。
// 豁免(有意不入表):
//   shot-m3.mjs —— 纯视觉留档,人看不判 PASS/FAIL,固定等待无 flake 代价;
//   real-search-probe.mjs —— 真网探针,.gitignore 排除,不入库不入 CI;
//   lib-cdp-mock.mjs —— harness 库,setTimeout 是库内轮询实现,不是等状态;
//   本脚本自身(内含形态字面量,扫自己必误报)。
// 已知局限(记录不掩盖):计数棘轮只能防「数量增长」,不能防「等量替换」
// —— 把一个 sleep 换成另一个同样违规的 sleep 仍会通过。这是有意取舍:
// 全仓 CI 套件约百处固定等待,逐处注解/逐处改写的成本远高于收益。
// 自校验:基线表里的文件键必须在磁盘上存在,防改名后棘轮静默失效
// (思路同 vitest.config.ts 的阈值键自检);基线外的文件隐含基线 0。
// 用法:node tests/check-fixed-waits.mjs;run.mjs 入口自动执行。
import { existsSync, readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SLEEP_RE = /await\s+sleep\(\s*\d+\s*\)/g;
const SETTIMEOUT_RE =
  /new\s+Promise\s*\(\s*\(?([A-Za-z_$][\w$]*)\)?\s*=>\s*setTimeout\s*\(\s*\1\s*,\s*\d+\s*\)\s*\)/g;

const BASELINE = {
  "probe-actions.mjs": 5,
  "probe-en-tools.mjs": 4,
  "probe-focus.mjs": 16,
  "probe-layout.mjs": 7,
  "probe-locale.mjs": 6,
  "probe-quote.mjs": 13,
  "verify-cancel.mjs": 3,
  "verify-compaction.mjs": 1,
  "verify-confirm.mjs": 2,
  "verify-host-access.mjs": 2,
  "verify-llm-errors.mjs": 3,
  "verify-mcp.mjs": 1,
  "verify-memory.mjs": 3,
  "verify-persist.mjs": 9,
  "verify-screenshot.mjs": 6,
  "verify-skills.mjs": 6,
  "verify-vision.mjs": 6,
  "verify-web-search.mjs": 3,
};

const EXEMPT = new Set([
  "shot-m3.mjs",
  "real-search-probe.mjs",
  "lib-cdp-mock.mjs",
  "check-fixed-waits.mjs",
]);

let failed = false;

// 自校验:基线键必须真实存在(改名/删除后棘轮不得静默失效)
const ghost = Object.keys(BASELINE).filter((f) => !existsSync(join(__dirname, f)));
if (ghost.length > 0) {
  failed = true;
  console.log("❌ 基线表里有磁盘上不存在的文件(改名/删除后没同步棘轮):");
  for (const f of ghost) console.log(`   ${f}`);
}

// 逐文件计数比较(基线外的非豁免文件隐含基线 0,新增违规同样拦)
for (const f of readdirSync(__dirname).filter(
  (x) => x.endsWith(".mjs") && !EXEMPT.has(x),
)) {
  const src = readFileSync(join(__dirname, f), "utf8");
  const measured =
    (src.match(SLEEP_RE)?.length ?? 0) + (src.match(SETTIMEOUT_RE)?.length ?? 0);
  const baseline = BASELINE[f] ?? 0;
  if (measured > baseline) {
    failed = true;
    console.log(
      `❌ ${f}: 固定等待 ${measured} 处 > 基线 ${baseline} —— 新增加固定等待前先读 AGENTS.md 硬规则 3(等待一律事件驱动/轮询);确属必须(如等外部 TTL)则同步抬高基线,并在改动说明里给理由`,
    );
  }
}

console.log(
  failed
    ? "固定等待计数棘轮检查失败"
    : "✅ 固定等待计数未超基线(硬规则 3 棘轮;只防增量,不防等量替换)",
);
process.exit(failed ? 1 : 0);
