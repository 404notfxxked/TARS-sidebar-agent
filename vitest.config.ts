import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 单元测试与被测模块同目录(src/**/*.test.ts,随仓库管理);只测不碰
// DOM/IDB/网络的纯逻辑,环境为 node。扩展构建的 vite.config.js 与本文件
// 互不干扰(vitest 优先读本文件)。e2e 套件在 tests/*.mjs(同样随仓库
// 管理,本地跑 node tests/run.mjs,地图见 tests/README.md)。
//
// 覆盖率:pnpm test:coverage。all:true 报全量文件——默认口径只统计被
// 测试 import 过的文件,数字会严重虚高(2026-09-17 实测:默认 68.9% vs
// 全量 12.8%)。thresholds 只钉已强区域防倒退;零覆盖区(UI 层/agent.ts/
// sessions/mcp 等)先只出报告不设门槛,补测后把棘轮逐步爬上去,别一次
// 拉全局大门槛(现状必红,逼人写凑数用例)。

// thresholds 键是手写源文件路径,而 vitest(实测 v5.0.0)对「未匹配任何
// 被覆盖文件」的键静默忽略 —— 被测文件改名/移动后该条棘轮会无声失效。
// 在配置加载时逐键校验(精确键取自身,glob 键取通配符前的目录前缀),
// 指空的键直接让 vitest 拒启:任何 vitest 运行(含 CI 的 test:coverage)
// 都会带上这道自检,不需要额外的单测或 script。
const coverageThresholds = {
  "src/shared/memory.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
  "src/shared/skills.ts": { statements: 95, branches: 85, functions: 100, lines: 95 },
  "src/background/agent/compaction.ts": { statements: 90, branches: 80, lines: 90 },
  "src/background/agent/toolBatch.ts": {
    statements: 100,
    branches: 100,
    functions: 100,
    lines: 100,
  },
  "src/background/web/engineHealth.ts": { statements: 90, branches: 85, lines: 90 },
  "src/shared/i18n/**": { statements: 100, branches: 90, functions: 100, lines: 100 },
  // provider 层:双适配器改造时随新测试钉上(2026-09,Anthropic Messages)
  "src/background/provider/anthropicMessages.ts": { statements: 95, branches: 80, lines: 95 },
  "src/background/provider/chatCompletions.ts": { statements: 85, branches: 78, lines: 85 },
  "src/background/provider/client.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
  "src/background/provider/sse.ts": { statements: 100, branches: 85, functions: 85, lines: 100 },
} as const;
const configRoot = resolve(dirname(fileURLToPath(import.meta.url)));
for (const key of Object.keys(coverageThresholds)) {
  const base = key.split("*")[0].replace(/\/+$/, "") || ".";
  if (!existsSync(resolve(configRoot, base))) {
    throw new Error(
      `覆盖率阈值键「${key}」在磁盘上不存在 —— 该条棘轮已静默失效;` +
        "文件改名/移动后须同步 vitest.config.ts 的 thresholds",
    );
  }
}

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["vitest.setup.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      all: true,
      include: ["src/**"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/locales/**",
        "src/**/*.d.ts",
        "src/**/*.html",
        "src/**/*.css",
      ],
      reporter: ["text"],
      thresholds: coverageThresholds,
    },
  },
});
