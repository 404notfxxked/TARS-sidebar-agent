// evals runner:真模型 × 真 TARS 扩展 × CDP fixture 页,程序化判分(无 LLM
// judge)。定位、运行方式与判分口径见 tests/README.md「evals」小节。
//
// 用法:
//   node tests/evals/run.mjs                          # REAL:全部 case × 3
//   node tests/evals/run.mjs --case read-long-article --runs 1
//   node tests/evals/run.mjs --mock                   # 无 key 自检:runner 链路探针
//
// 铁律(计划 §1):密钥只从环境变量读,任何输出不含 key / Authorization,
// baseUrl 只记 host;REAL 模式 env 不齐退出码 2;固定等待禁止;不对真站发
// 请求(fixture 走路由回填)。--mock 模式 provider 种成 TEST_ENDPOINT_ORIGIN
// + 罐头 SSE,只验证 runner 自身链路(直答探针 + fixture 链路探针),
// 不写 JSONL、不参与基线 —— output/ 只留真模型测量。
//
// 每次(case, run)独立 userDataDir(/tmp/tars-eval-<case>-<i>-<ts>),跑完
// 清理;k 次运行之间不共享 IndexedDB。底座的 sweepStaleProfiles 只扫
// verify/probe 前缀,本目录的 profile 自管清理。退出码:全过 0;有 FAIL 1;
// REAL env 不齐 / 用法错误 2。

import {
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { createHash } from "crypto";
import { basename, dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  answerSSE,
  launchWithCdp,
  makeChecker,
  openPanel,
  readRunLogs,
  seedProviders,
  toolCallSSE,
} from "../lib-cdp-mock.mjs";
import {
  ensureOutputDir,
  modelObservabilityRoute,
  readEvalEnv,
  seedEvalProviders,
} from "./lib-eval-env.mjs";
import {
  askWithPolicy,
  extractTrajectory,
  fixtureRoute,
  openFixturePage,
} from "./lib-eval-driver.mjs";
import {
  gradeAnswerFragments,
  gradeMaxTurns,
  gradeRunComplete,
  PAGE_WRITE_CHECK_NAMES,
  WRITE_TOOL_NAMES,
} from "./graders.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(__dirname, "..", "..", "dist");
const RUN_TIMEOUT_MS = 300_000;

// ---- 参数解析 ----
const argv = process.argv.slice(2);
const mockMode = argv.includes("--mock");
const caseIdx = argv.indexOf("--case");
const caseFilter = caseIdx >= 0 ? argv[caseIdx + 1] : undefined;
const runsIdx = argv.indexOf("--runs");
const runsArg = runsIdx >= 0 ? Number(argv[runsIdx + 1]) : undefined;
if (
  (caseFilter !== undefined && !caseFilter) ||
  (runsArg !== undefined && (!Number.isInteger(runsArg) || runsArg < 1))
) {
  console.error("用法: node tests/evals/run.mjs [--case <name>] [--runs N] [--mock]");
  process.exit(2);
}

// ---- dist 陈旧提醒(与 tests/run.mjs 同款:src 比 dist 新 = 大概率忘了 build)----
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
  walk(resolve(__dirname, "..", "..", "src"));
  return newest;
})();
const distMtime = existsSync(EXT_DIR) ? statSync(EXT_DIR).mtimeMs : 0;
if (!existsSync(EXT_DIR) || newestSrc > distMtime) {
  console.log(
    "⚠️  dist/ 缺失或 src/ 比 dist/ 新 —— evals 跑的是旧构建。先 pnpm build,再重跑。\n",
  );
}

/**
 * 判分口径内容哈希(per-case)——graders.mjs + 该 case 文件 + 该
 * case 引用的 fixture 文件(缺失跳过;路径名参与哈希防拼接歧义)。
 * 口径变化(改判分/改 case/改 fixture)→ rev 变化 → 基线 diff 只列数值
 * 不标回归/改善,把「判分口径变了」与「模型行为变了」自动区分
 * (否则基线 diff 会把口径变化误读成模型回归/改善——G5 换口径时人工
 * 注记兜底过一次)。mock 探针不参与基线,其
 * evalRev 以 run.mjs 本体为 case 文件计算,仅作占位统一形状。
 */
function computeEvalRev({ casePath, fixturePath } = {}) {
  const h = createHash("sha256");
  const parts = [
    ["graders", join(__dirname, "graders.mjs")],
    ...(casePath ? [["case", casePath]] : []),
    ...(fixturePath ? [["fixture", fixturePath]] : []),
  ];
  for (const [label, p] of parts) {
    h.update(`${label}:${basename(p)}\n`);
    h.update(readFileSync(p));
    h.update("\n");
  }
  return h.digest("hex").slice(0, 8);
}

// ---- case 加载:cases/*.mjs,export default 一个 case 对象 ----
// case 对象契约:
//   name / instruction / confirmPolicy / runs
//   steps?: [{instruction, confirmPolicy}]  —— 两段式驱动:按序
//     以同一 sessionId 发多条指令,confirms 按步拼接,turns 取各步合计;
//     缺省走 instruction/confirmPolicy 单段
//   fixture?: { url, file? | html? }   —— runner 注册回填路由并开标签页
//   mockScript?(ctx, {usedTool, lastUser}) —— --mock 模式的罐头模型脚本
//   grade(ctx) => checks[]             —— ctx 见 runOnce 内 gradeCtx
async function loadCases() {
  const dir = join(__dirname, "cases");
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".mjs"))
        .sort()
    : [];
  const cases = [];
  for (const f of files) {
    const mod = await import(join(dir, f));
    if (!mod.default) continue;
    const c = mod.default;
    // per-case 判分口径哈希(graders + case 文件 + fixture 文件)
    c.evalRev = computeEvalRev({
      casePath: join(dir, f),
      fixturePath: c.fixture?.file
        ? join(__dirname, "fixtures", c.fixture.file)
        : undefined,
    });
    cases.push(c);
  }
  if (caseFilter !== undefined && !cases.some((c) => c.name === caseFilter)) {
    console.error(
      `❌ 找不到 case「${caseFilter}」;可用:${cases.map((c) => c.name).join(", ") || "(无)"}`,
    );
    process.exit(2);
  }
  return caseFilter !== undefined
    ? cases.filter((c) => c.name === caseFilter)
    : cases;
}

function resolveFixtureHtml(c) {
  if (!c.fixture) return null;
  if (typeof c.fixture.html === "string") return c.fixture.html;
  if (c.fixture.file) {
    return readFileSync(join(__dirname, "fixtures", c.fixture.file), "utf8");
  }
  throw new Error(`case ${c.name} 的 fixture 缺 html/file`);
}

/** --mock 模式的罐头模型路由:按 usedTool / 末条 user 文本分发到 case 的脚本 */
function mockModelRoute(script) {
  return {
    match: (url) => url.includes("/chat/completions"),
    handle: async (ctx) => {
      const body = JSON.parse(ctx.params.request.postData ?? "{}");
      const msgs = body.messages ?? [];
      const lastUserIdx = msgs.map((m) => m.role).lastIndexOf("user");
      const usedTool = msgs.slice(lastUserIdx + 1).some((m) => m.role === "tool");
      const lastUser = String(msgs[lastUserIdx]?.content ?? "");
      await script(ctx, { usedTool, lastUser, body });
    },
  };
}

function fmtLog(e) {
  return `  [${e.ctx}/${e.tag}] ${e.msg} ${String(e.data ?? "").slice(0, 120)}`;
}

/**
 * 单次(case, run):独立 profile 全隔离 —— 启动 → 种配置 → 开 fixture 页
 * (除面板外唯一普通标签页,且是活动标签:page_* 工具的 tab 回退链落它)→
 * port 驱动提问(确认按策略)→ 轨迹提取 → case 判分 → 清理。
 * 返回 { jsonl, requests }:jsonl 进结果文件(不含请求规模计数 —— JSONL
 * 行形状按计划 §5 固定),requests 只进 stdout 花费口径。
 */
async function runOnce({ c, runIndex, mode, env }) {
  const startedAt = Date.now();
  const userDataDir = `/tmp/tars-eval-${c.name}-${runIndex}-${Date.now()}`;
  const requests = [];
  let browser;
  const base = {
    ts: new Date().toISOString(),
    case: c.name,
    run: runIndex,
    model: mode === "mock" ? "mock" : (env.model ?? ""),
    host: mode === "mock" ? "" : (env.host ?? ""),
    evalRev: c.evalRev ?? null,
  };
  try {
    const { browser: ctx, extId, mock } = await launchWithCdp({
      extDir: EXT_DIR,
      userDataDir,
    });
    browser = ctx;
    const fixtureHtml = resolveFixtureHtml(c);
    mock.setRoutes([
      ...(mode === "mock"
        ? [mockModelRoute(c.mockScript)]
        : [modelObservabilityRoute(requests)]),
      ...(fixtureHtml ? [fixtureRoute(c.fixture.url, fixtureHtml)] : []),
    ]);
    const sidepanel = await openPanel(browser, extId, {
      configure: (page) =>
        mode === "mock"
          ? seedProviders(page, [{ id: "mock-model", contextTokens: 128000 }])
          : seedEvalProviders(page, env),
    });
    // 关掉启动残留的空白页:保证 fixture(下一步打开)是除面板外唯一普通标签页
    for (const p of browser.pages()) {
      if (p !== sidepanel) await p.close().catch(() => {});
    }
    const fixturePage = fixtureHtml
      ? await openFixturePage(browser, c.fixture.url)
      : null;

    const sessionId = `eval-${c.name}-${runIndex}`;
    // 两段式:steps 缺省回落单段,向后兼容;confirms 按步拼接,
    // turns 取各步合计,agent_done 即发下一步(步间不等额外时间)
    const steps =
      Array.isArray(c.steps) && c.steps.length > 0
        ? c.steps
        : [{ instruction: c.instruction, confirmPolicy: c.confirmPolicy }];
    const confirms = [];
    const stepTurns = [];
    let lastDone = null;
    let timedOutStep = -1;
    let logTail = "";
    for (const [i, step] of steps.entries()) {
      const driven = await askWithPolicy(
        sidepanel,
        sessionId,
        step.instruction,
        step.confirmPolicy,
        { timeoutMs: RUN_TIMEOUT_MS },
      );
      confirms.push(...driven.confirms);
      if (driven.timeout) {
        timedOutStep = i;
        try {
          logTail = (await readRunLogs(sidepanel))
            .slice(-30)
            .map(fmtLog)
            .join("\n");
        } catch {
          /* 超时现场可能已不可读 */
        }
        break;
      }
      lastDone = driven.done;
      stepTurns.push(driven.maxTurn + 1);
    }
    const turnsTotal = stepTurns.reduce((s, t) => s + t, 0);

    if (timedOutStep >= 0) {
      return {
        jsonl: {
          ...base,
          pass: false,
          checks: [],
          turns: turnsTotal,
          toolCalls: [],
          durationMs: Date.now() - startedAt,
          llmRequests: requests.length,
          answerHead: null,
          error: `step ${timedOutStep + 1}/${steps.length} run 超时(>${RUN_TIMEOUT_MS / 1000}s)。当前 run 日志尾部:\n${logTail || "(不可得)"}`,
        },
        requests,
      };
    }

    const traj = await extractTrajectory(sidepanel, sessionId);
    const gradeCtx = {
      traj,
      turns: turnsTotal,
      stepTurns,
      driven: {
        confirms,
        done: lastDone,
        timeout: false,
        maxTurn: turnsTotal - 1,
      },
      fixturePage,
      sidepanel,
      requests,
      sessionId,
    };
    const checks = await c.grade(gradeCtx);
    return {
      jsonl: {
        ...base,
        pass: checks.every((ch) => ch.ok),
        checks: checks.map(({ name, ok, detail }) => ({ name, ok, detail })),
        turns: turnsTotal,
        toolCalls: traj.toolCalls.map((t) => t.name),
        durationMs: Date.now() - startedAt,
        llmRequests: requests.length,
        // 最终回答前 500 字(仅回答文本,不含工具参数原文)。
        // output/ 是 gitignore 本地产物不进 CI,与最小原文纪律的取舍:
        // 判分可诊断性优先,原文不出本机
        answerHead: (traj.finalAnswer ?? "").slice(0, 500),
      },
      requests,
    };
  } catch (err) {
    return {
      jsonl: {
        ...base,
        pass: false,
        checks: [],
        turns: -1,
        toolCalls: [],
        durationMs: Date.now() - startedAt,
        llmRequests: requests.length,
        answerHead: null,
        error: String(err?.message ?? err),
      },
      requests,
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
    rmSync(userDataDir, { recursive: true, force: true });
  }
}

// ---- 聚合与基线 ----
// error 行(run 执行异常/超时,turns=-1)只进通过率分母,不进 turns/工具
// 均值——均值分母用 counted,防止异常行按 0 拉低均值
function aggregate(lines) {
  const byCase = new Map();
  for (const r of lines) {
    const a = byCase.get(r.case) ?? {
      pass: 0,
      total: 0,
      turns: 0,
      tools: 0,
      counted: 0,
      errors: 0,
    };
    a.total += 1;
    if (r.pass) a.pass += 1;
    if (r.turns >= 0) {
      a.counted += 1;
      a.turns += r.turns;
      a.tools += r.toolCalls.length;
    } else {
      a.errors += 1;
    }
    byCase.set(r.case, a);
  }
  return byCase;
}

/** 最近一次「同模型+同 host」的 JSONL 作基线(单 model 字符串不区分
 *  端点,同模型换端点会互为基线;kind 不入 key——同 host 同 model 换协议
 *  属异常配置,不加维度)。文件名含时间戳,按名排序即按时间 */
function loadBaseline(outputDir, model, host, selfFile) {
  const files = readdirSync(outputDir)
    .filter((f) => f.endsWith(".jsonl") && f !== selfFile)
    .sort();
  for (let i = files.length - 1; i >= 0; i--) {
    const lines = readFileSync(join(outputDir, files[i]), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const sameRun = lines.filter((l) => l.model === model && l.host === host);
    if (sameRun.length > 0) return { file: files[i], lines: sameRun };
  }
  return null;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---- REAL 模式主流程 ----
async function runReal() {
  const env = readEvalEnv();
  if (env.missing) {
    console.error(
      `❌ REAL 模式缺环境变量:${env.missing.join(", ")}\n` +
        "   需要 EVALS_BASE_URL / EVALS_API_KEY / EVALS_MODEL,可选 EVALS_KIND(缺省 chat-completions)、EVALS_CONTEXT_TOKENS(缺省 128000)。",
    );
    process.exit(2);
  }
  const cases = await loadCases();
  if (cases.length === 0) {
    console.error("❌ tests/evals/cases/ 下没有 case。");
    process.exit(2);
  }

  const outputDir = ensureOutputDir();
  const jsonlPath = join(outputDir, `run-${stamp()}.jsonl`);
  writeFileSync(jsonlPath, "");
  console.log(
    `REAL 模式:model=${env.model} host=${env.host} kind=${env.kind} contextTokens=${env.contextTokens}`,
  );
  console.log(`JSONL:${jsonlPath}\n`);

  const all = [];
  const allRequests = [];
  for (const c of cases) {
    const runs = runsArg ?? c.runs ?? 3;
    for (let i = 1; i <= runs; i++) {
      console.log(`── ${c.name} run ${i}/${runs} ──`);
      const { jsonl: r, requests } = await runOnce({
        c,
        runIndex: i,
        mode: "real",
        env,
      });
      all.push(r);
      allRequests.push(...requests);
      appendFileSync(jsonlPath, `${JSON.stringify(r)}\n`);
      console.log(
        `${r.pass ? "✅ PASS" : "❌ FAIL"}  turns=${r.turns} 工具=[${r.toolCalls.join(" → ") || "无"}] llmRequests=${r.llmRequests} ${(r.durationMs / 1000).toFixed(1)}s`,
      );
      for (const ch of r.checks) {
        if (!ch.ok) console.log(`   ❌ ${ch.name}\n      ${ch.detail}`);
      }
      if (r.error) console.log(`   ⚠️ ${r.error.slice(0, 500)}`);
    }
  }

  // 汇总表:pass^k / 平均 turns / 平均工具调用数;另打印观测到的花费口径
  console.log("\n════════ 汇总 ════════");
  console.log("case                 pass^k   平均turns  平均工具调用数");
  for (const [name, a] of aggregate(all)) {
    const avgTurns = a.counted > 0 ? (a.turns / a.counted).toFixed(1) : "-";
    const avgTools = a.counted > 0 ? (a.tools / a.counted).toFixed(1) : "-";
    console.log(
      `${name.padEnd(20)} ${String(a.pass)}/${a.total}`.padEnd(30) +
        avgTurns.padEnd(12) +
        avgTools,
    );
  }
  const errorRows = all.filter((r) => r.turns < 0).length;
  if (errorRows > 0) {
    console.log(
      `error 行:共 ${errorRows} 条(只计通过率分母,不进 turns/工具均值)`,
    );
  }
  if (allRequests.length > 0) {
    const avgChars =
      allRequests.reduce((s, r) => s + Math.max(r.chars, 0), 0) /
      allRequests.length;
    console.log(
      `花费口径:LLM 调用 ${allRequests.length} 次,平均每轮请求 ${(avgChars / 1000).toFixed(1)}k 字符(观测路由计数,不含原文)`,
    );
  }

  // 基线 diff:与最近一次同模型+同 host 的 JSONL 比,新增 FAIL 高亮
  const baseline = loadBaseline(
    outputDir,
    env.model,
    env.host,
    basename(jsonlPath),
  );
  if (!baseline) {
    console.log("\n(无同模型基线,本次为首跑)");
  } else {
    const baseAgg = new Map();
    const baseRev = new Map();
    for (const l of baseline.lines) {
      const a = baseAgg.get(l.case) ?? { pass: 0, total: 0 };
      a.total += 1;
      if (l.pass) a.pass += 1;
      baseAgg.set(l.case, a);
      if (l.evalRev) baseRev.set(l.case, l.evalRev);
    }
    const curRev = new Map(all.map((r) => [r.case, r.evalRev]));
    console.log(
      `\n基线 diff(对比 ${baseline.file},同模型+host:${env.model} @ ${env.host}):`,
    );
    for (const [name, a] of aggregate(all)) {
      const b = baseAgg.get(name);
      if (!b) {
        console.log(`  ${name}:基线无此 case(新增)`);
        continue;
      }
      const wasAllPass = b.pass === b.total;
      const nowAllPass = a.pass === a.total;
      // 判分口径(rev)不同时只列数值不标回归/改善——口径变了,
      // 通过率变化没有可比性
      if (curRev.get(name) !== baseRev.get(name)) {
        console.log(
          `  ${name}:本次 ${a.pass}/${a.total},基线 ${b.pass}/${b.total}` +
            `  ⚠️ 判分口径与基线不同(基线 rev=${baseRev.get(name) ?? "无"},本次 rev=${curRev.get(name) ?? "无"}),diff 仅列数值`,
        );
        continue;
      }
      const mark = !nowAllPass && wasAllPass
        ? "  ⚠️ 回归(基线全过,本次有 FAIL)"
        : nowAllPass && !wasAllPass
          ? "  ↑ 改善(基线有 FAIL,本次全过)"
          : "";
      console.log(`  ${name}:本次 ${a.pass}/${a.total},基线 ${b.pass}/${b.total}${mark}`);
    }
  }

  const failed = all.filter((r) => !r.pass).length;
  console.log(
    failed === 0
      ? `\n✅ ${all.length} 次运行全 PASS`
      : `\n❌ ${failed}/${all.length} 次运行 FAIL(结果已留 JSONL;FAIL 是发现,不是障碍)`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

// ---- --mock 自检:两条探针走 runOnce 同一条链路 ----
// 探针页(内联,不入 fixtures/):末段放唯一事实串,验证
// fixture 页 + 静态 content script + offscreen 转写 + page_find 的真实链路。
const PROBE_FIXTURE_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>评测探针页</title></head>
<body>
<h1>深蓝档案馆馆藏简介</h1>
${Array.from(
  { length: 12 },
  (_, i) =>
    `<p>第${i + 1}段:档案馆的日常包括编目、除尘、恒温巡检与读者接待,各项工作按季度轮换安排。</p>`,
).join("\n")}
<p>深蓝档案馆的七层地下书库(TARS-EVAL-PROBE-7439)不对公众开放,仅限特藏研究。</p>
</body></html>`;

const mockProbes = [
  {
    name: "selftest-direct-answer",
    instruction:
      "链路自检:请原样回复标记词 TARS-EVAL-SMOKE-OK,不要调用任何工具。",
    confirmPolicy: "auto_deny",
    mockScript: async (ctx) => answerSSE(ctx, "TARS-EVAL-SMOKE-OK"),
    async grade({ traj, turns, driven }) {
      return [
        gradeRunComplete(driven),
        gradeAnswerFragments(traj, ["TARS-EVAL-SMOKE-OK"]),
        {
          name: "轨迹:直答探针无工具调用",
          ok: traj.toolCalls.length === 0,
          detail: `实际工具序列:[${traj.toolCalls.map((t) => t.name).join(", ") || "无"}]`,
        },
        gradeMaxTurns(turns, 3),
      ];
    },
  },
  {
    name: "selftest-fixture-chain",
    instruction: "深蓝档案馆不对公众开放的区域在哪里?",
    confirmPolicy: "auto_deny",
    fixture: {
      url: "https://eval-fixture.test/probe.html",
      html: PROBE_FIXTURE_HTML,
    },
    mockScript: async (ctx, { usedTool }) =>
      usedTool
        ? answerSSE(ctx, "档案显示:不对公众开放的区域是七层地下书库。")
        : toolCallSSE(ctx, "page_find", { query: "七层地下书库" }),
    async grade({ traj, driven }) {
      const find = traj.toolCalls[0];
      return [
        gradeRunComplete(driven),
        {
          name: "轨迹:模型按脚本先调 page_find 且未报错",
          ok: !!find && find.name === "page_find" && !find.error,
          detail: `实际工具序列:[${traj.toolCalls.map((t) => t.name).join(", ") || "无"}]`,
        },
        {
          name: "结果:page_find 结果含 fixture 末段事实",
          ok: !!find && find.result.includes("七层地下书库"),
          detail: `工具结果前 200 字:${(find?.result ?? "(无)").slice(0, 200)}`,
        },
        gradeAnswerFragments(traj, ["七层地下书库"]),
      ];
    },
  },
  {
    name: "selftest-two-step",
    // 两段式驱动的 mock 覆盖:同一 sessionId 发两条指令,
    // 罐头模型按末条 user 文本区分步序
    steps: [
      {
        instruction: "链路自检第 1 步:请原样回复标记词 TARS-EVAL-STEP1-OK,不要调用任何工具。",
        confirmPolicy: "auto_deny",
      },
      {
        instruction: "链路自检第 2 步:请原样回复标记词 TARS-EVAL-STEP2-OK,不要调用任何工具。",
        confirmPolicy: "auto_deny",
      },
    ],
    mockScript: async (ctx, { lastUser }) =>
      answerSSE(
        ctx,
        lastUser.includes("STEP1") ? "TARS-EVAL-STEP1-OK" : "TARS-EVAL-STEP2-OK",
      ),
    async grade({ traj, turns, driven }) {
      return [
        gradeRunComplete(driven),
        gradeAnswerFragments(traj, ["TARS-EVAL-STEP2-OK"]),
        {
          name: "轨迹:两段式直答无工具无确认",
          ok: driven.confirms.length === 0 && traj.toolCalls.length === 0,
          detail: `confirms=${driven.confirms.length} tools=${traj.toolCalls.length}`,
        },
        {
          name: "终态:两步 turns 合计(2–4)",
          ok: turns >= 2 && turns <= 4,
          detail: `turns=${turns}`,
        },
      ];
    },
  },
];

// 探针定义在 run.mjs 本体,其 evalRev 以 run.mjs 为 case 文件计算
// (探针不参与基线,仅统一 JSONL 形状)
for (const p of mockProbes) {
  p.evalRev = computeEvalRev({ casePath: resolve(__dirname, "run.mjs") });
}

async function runMockSelftest() {
  if (caseFilter !== undefined || runsArg !== undefined) {
    console.error("--mock 模式跑固定探针,不接受 --case / --runs。");
    process.exit(2);
  }
  console.log(
    "MOCK 自检:罐头模型 + 真扩展 + CDP 路由,验证 runner 自身链路。\n",
  );
  const check = makeChecker();
  for (const probe of mockProbes) {
    console.log(`── 探针 ${probe.name} ──`);
    const { jsonl: r } = await runOnce({
      c: probe,
      runIndex: 1,
      mode: "mock",
      env: {},
    });
    for (const ch of r.checks) {
      check(ch.ok, `${probe.name} · ${ch.name}`, ch.detail);
    }
    if (r.error) check(false, `${probe.name} · run 执行`, r.error.slice(0, 400));
  }
  console.log(
    check.failures.length === 0
      ? "\n✅ mock 自检全 PASS(runner 链路通:port 驱动 / 轨迹提取 / fixture 转写)"
      : `\n❌ mock 自检 ${check.failures.length} 条 FAIL`,
  );
  process.exit(check.failures.length === 0 ? 0 : 1);
}

/**
 * 写工具镜像启动自检(mock 与 REAL 共同路径)。graders.mjs 的
 * WRITE_TOOL_NAMES 是 confirmations.ts TOOL_CATEGORY 的判分用镜像,仅靠
 * 注释同步会在 src 加写工具时静默漏判——入口处解析源码比对,不一致退出 2。
 * 解析失败(找不到块/0 条目)同样报错退出:解析器坏了比漏判好,源码格式
 * 变化时强制人来同步,不许静默跳过。
 */
function checkWriteToolMirror() {
  const srcPath = resolve(
    __dirname,
    "..",
    "..",
    "src",
    "background",
    "agent",
    "confirmations.ts",
  );
  let src;
  try {
    src = readFileSync(srcPath, "utf8");
  } catch (err) {
    console.error(`❌ 写工具镜像自检:读不到源码 ${srcPath}(${err.message})`);
    process.exit(2);
  }
  const block = src.match(/TOOL_CATEGORY[^=]*=\s*\{([\s\S]*?)\}/);
  if (!block) {
    console.error(
      "❌ 写工具镜像自检:confirmations.ts 里找不到 TOOL_CATEGORY 块——源码格式变化,解析器需人工同步(不许静默跳过)",
    );
    process.exit(2);
  }
  const pairs = [
    ...block[1].matchAll(/([A-Za-z_]+)\s*:\s*"(page-write|persistent)"/g),
  ];
  if (pairs.length === 0) {
    console.error(
      "❌ 写工具镜像自检:TOOL_CATEGORY 块解析出 0 个条目——源码格式变化,解析器需人工同步",
    );
    process.exit(2);
  }
  const category = Object.fromEntries(
    pairs.map(([, name, cat]) => [name, cat]),
  );
  const srcKeys = Object.keys(category);
  const pageWriteKeys = srcKeys.filter((k) => category[k] === "page-write");
  const problems = [];
  for (const k of WRITE_TOOL_NAMES) {
    if (!srcKeys.includes(k)) problems.push(`镜像多出:graders WRITE_TOOL_NAMES 有「${k}」,src TOOL_CATEGORY 无`);
  }
  for (const k of srcKeys) {
    if (!WRITE_TOOL_NAMES.includes(k)) problems.push(`镜像缺失:src TOOL_CATEGORY 有「${k}」,graders WRITE_TOOL_NAMES 漏`);
  }
  for (const k of PAGE_WRITE_CHECK_NAMES) {
    if (!pageWriteKeys.includes(k)) problems.push(`isPageWrite 越界:「${k}」不在 src 的 page-write 组`);
  }
  if (problems.length > 0) {
    console.error(
      `❌ 写工具镜像自检失败(graders.mjs 镜像 ≠ src TOOL_CATEGORY):\n   ${problems.join("\n   ")}\n   同步 graders.mjs 的 WRITE_TOOL_NAMES / PAGE_WRITE_CHECK_NAMES 后重跑。`,
    );
    process.exit(2);
  }
  console.log(
    `✅ 写工具镜像自检:WRITE_TOOL_NAMES(${srcKeys.length} 项)与 isPageWrite(${PAGE_WRITE_CHECK_NAMES.length} 项)与 src TOOL_CATEGORY 一致`,
  );
}

// 写工具镜像自检:mock 与 REAL 共同路径的双向防线,任何模式先过这关
checkWriteToolMirror();

if (mockMode) {
  await runMockSelftest();
} else {
  await runReal();
}
