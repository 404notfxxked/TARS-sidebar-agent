import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// 多入口构建：
//   - sidepanel  (HTML 入口) → dist/sidepanel.html + 关联 JS/CSS
//   - background (JS 入口)   → dist/background.js（service worker, 单文件, ESM）
//   - content    (JS 入口)   → dist/content.js（content script, 必须自包含经典脚本）
//   - offscreen  (HTML 入口) → dist/offscreen.html + offscreen.js(扩展私有页面,
//                              chrome.offscreen 创建的常驻 DOM 环境,page_* 快照管线)
// public/ 下的 manifest.json 原样拷贝
export default defineConfig({
  plugins: [
    // React Compiler 1.0:构建期自动记忆化(useMemo/useCallback/memo 手写件
    // 在 chat 视图已删,行为耦合的 memo 保留,编译器对其按依赖提示尊重)。
    // 违反 Rules of React 的组件编译器会保守跳过(bail out),不影响语义
    react({
      babel: {
        plugins: [["babel-plugin-react-compiler", {}]],
      },
    }),
    tailwindcss(),
    // content script 以经典脚本执行(manifest 注入与 executeScript 兜底皆然),
    // 顶层 import/export 直接 SyntaxError、listener 注册不上。
    // 多入口共享运行时模块会被 Rollup 拆成 chunk,content.js 顶部就会冒出 import ——
    // 这里守住:产物一旦非自包含立即构建失败。
    // (src/content 对 shared/ 的依赖只允许 type-only import,常量在 content 侧本地声明)
    {
      name: "guard-content-classic-script",
      generateBundle(_, bundle) {
        const chunk = bundle["content.js"];
        if (
          chunk?.type === "chunk" &&
          /^\s*(import|export)\b/m.test(chunk.code)
        ) {
          this.error(
            "dist/content.js 含顶层 import/export:content script 必须是自包含经典脚本," +
              "不能引用共享 chunk。请让 src/content 的依赖保持自包含" +
              "(对 shared/ 只做 type-only import,常量在 content 侧本地声明)。",
          );
        }
      },
    },
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // sidepanel 单 chunk ~566KB 触发 Vite 的 500KB 警告,已确认是有意识的取舍:
    // 构成 ≈ react 全家 31% + markdown 渲染栈 39%(其中 highlight.js 22%,
    // rehype-highlight 默认带 ~37 种语言)+ 自有代码 4%。扩展从本地磁盘加载,
    // 无下载成本,解析多花十几毫秒;拆 manualChunks 无用(单入口静态引用,
    // 全量加载)。待办(视情况决定):把 highlight.js 换成小语言子集
    // (如 js/ts/html/css/json/python/bash),min 后可省约 100-150KB。
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      input: {
        sidepanel: resolve(__dirname, 'sidepanel.html'),
        background: resolve(__dirname, 'src/background/index.ts'),
        content: resolve(__dirname, 'src/content/index.ts'),
        offscreen: resolve(__dirname, 'src/offscreen/offscreen.html'),
      },
      output: {
        entryFileNames: (chunk) => {
          if (chunk.name === "background") return "background.js"
          if (chunk.name === "content") return "content.js"
          if (chunk.name === "offscreen" || chunk.name === "offscreen_main") return "offscreen.js"
          return "assets/[name]-[hash].js"
        },
        chunkFileNames: "assets/[name]-[hash].js",
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
