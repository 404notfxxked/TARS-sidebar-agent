# TARS

> 住在浏览器侧栏的 agent：读你正在看的页面，替你联网查，替你点按填写。
> repo: [TARS-sidebar-agent](https://github.com/404notfxxked/TARS-sidebar-agent) · 命名致敬《星际穿越》里诚实度 90%、幽默值 75% 的那个机器人。

一个 Chrome MV3 扩展，内置 ReAct agent 循环（推理 → 工具调用 → 观察），BYOK 接入任意 OpenAI 兼容 API（DeepSeek / Kimi / OpenRouter / Ollama …，Anthropic 协议待适配）。所有请求只在你的浏览器与模型端点之间流转。个人学习项目，练手 agent 架构。

## ✨ 功能

- 📖 **读页答疑** — 页面快照在 offscreen 转成结构化 markdown；长文档支持大纲、关键词定位、分窗阅读，不会刷爆上下文
- 🖱️ **页面操作** — 模拟真实鼠标点击、表单填写与回车提交，React 受控组件也能正确感知
- 🔍 **联网搜索** — 零配置可用：Bing 主力 + DuckDuckGo 自动兜底，被风控的引擎自动冷却；支持时间范围与域名过滤
- 🌐 **读取网页** — 给它一个 http(s) 链接即可读正文（内网页面同样可达，GBK 等编码自动识别），与搜索结果配合使用
- 🛡️ **稳态细节** — 停止按钮即时中断在途请求；工具结果超预算自动瘦身，防止撑爆上下文
- 🌗 深浅色主题 · 会话历史持久化 · 跨上下文诊断日志导出

## 🚀 快速开始

要求 Node ≥ 20、pnpm ≥ 10。

```bash
pnpm install
pnpm build        # 产物输出到 dist/
```

1. 打开 `chrome://extensions`，开启右上角「开发者模式」
2. 点「加载已解压的扩展程序」，选择本项目的 `dist/`
3. 点工具栏图标打开侧栏，在设置里填入 Base URL 与 API Key（例如 `https://api.deepseek.com/v1`）

设置里还有「联网」开关（默认开启）：关闭后 TARS 只读当前页面，不会向搜索引擎发出任何请求。

## 🛠 开发

```bash
pnpm typecheck    # 仅类型检查
pnpm build        # 类型检查 + 构建 + offscreen 后处理
```

E2E 验证脚本与 fixtures 在本地 `tests/`（不随仓库分发），通过 CDP 拦截扩展上下文的网络流量、mock LLM 驱动真实 agent 循环：

```bash
node tests/verify-web-search.mjs   # 联网工具链路（11 场景，含实网）
node tests/verify-cancel.mjs       # 停止按钮链路
```

受限网络环境可为测试浏览器挂代理：`VERIFY_PROXY=http://127.0.0.1:8118 node tests/verify-web-search.mjs`（mock 请求在 CDP 层拦截，不受代理影响）。

## 🧭 架构

```
sidepanel (React) ⇄ port ⇄ Service Worker (ReAct 循环 + provider 适配)
                                ├─ content script   读页 / 页面操作
                                ├─ offscreen doc    HTML → markdown 解析与缓存
                                └─ web 工具          搜索引擎 / 网页抓取
```

设计取舍与实现细节写在各模块的文件头注释里；本地路线图见 `memory/project-roadmap.md`（不进仓库）。
