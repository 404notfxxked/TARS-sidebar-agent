import { defineConfig } from "vitest/config";

// 单元测试与被测模块同目录(src/**/*.test.ts,随仓库管理);只测不碰
// DOM/IDB/网络的纯逻辑,环境为 node。扩展构建的 vite.config.js 与本文件
// 互不干扰(vitest 优先读本文件)。e2e 套件在 tests/*.mjs(本地,不进仓),
// 用 node tests/run.mjs 跑,见 tests/README.md。
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: ["vitest.setup.ts"],
    environment: "node",
  },
});
