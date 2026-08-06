# 文档答疑侧栏

Chrome 扩展 — 浏览文档/文章时打开侧栏，AI agent 能读取页面内容并答疑。

## 技术栈

- React 19 + TypeScript + Tailwind CSS 4 + Vite 6
- Chrome MV3 (service worker + side panel + content script)
- BYOK — 支持 OpenAI 兼容 API（DeepSeek、Groq 等），Anthropic 待适配

## 架构

```
src/
├── background/       # Service Worker — agent loop + provider 适配器
│   ├── agent.ts      # ReAct 循环（推理 → 工具调用 → 观察）
│   ├── index.ts      # 端口管理、会话生命周期、取消控制
│   ├── tools.ts      # 工具注册表（read_page 等）
│   └── provider/     # LLM 适配器（openai / anthropic）
├── sidepanel/        # 侧栏 UI（React）
│   ├── App.tsx       # 主布局
│   ├── ChatView.tsx  # 对话视图 + 浮动输入胶囊
│   └── SettingsPanel.tsx  # BYOK 设置（滑层）
├── content/          # Content script — 页面内容提取
└── shared/           # 共享类型、消息协议、配置存储
```

## 消息流

```
侧栏 UI ←→ port ←→ Service Worker ←→ LLM API
                        ↓
                  Content Script（工具调用：读页面文本）
```

## 开发

```bash
pnpm install
pnpm build           # 输出到 dist/
pnpm typecheck       # 仅类型检查
node scripts/verify-cancel.mjs  # Playwright 验证停止按钮链路
```

加载到 Chrome：`chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选择 `dist/`

## 配置

点击侧栏右上角齿轮图标 → 选择协议 → 填入模型名、Base URL、API Key。Key 可选「记住我」持久化到本地存储。

## 路线图

见 memory/project-roadmap.md（P0 中止+多轮 → P1 日志+快照 → P2 测试+压缩）
