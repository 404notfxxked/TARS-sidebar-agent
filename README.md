<div align="center">

<img src="public/icons/icon.svg" width="56" alt="TARS">

# TARS

> 住在浏览器侧栏的 agent：读你正在看的页面，替你联网查，替你点按填写。
> 名字来自《星际穿越》里那个机器人：诚实值 90%，幽默值 75%，冷笑话讲得一般，活儿干得漂亮。

**Chrome MV3 扩展 · BYOK · 数据不出本机**

[![version](https://img.shields.io/github/v/tag/404notfxxked/TARS-sidebar-agent?style=flat-square&label=version)](https://github.com/404notfxxked/TARS-sidebar-agent/releases)
[![chrome](https://img.shields.io/badge/Chrome-MV3-4285F4?style=flat-square&logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/develop/mv3/mv3-migration)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

<!-- TODO(release-plan 阶段 1)：补演示 GIF / 截图；Releases 挂 dist zip 后在快速开始加下载入口 -->

</div>

一个 Chrome MV3 扩展，内置手写的 ReAct agent 循环（推理 → 工具调用 → 观察 → 再推理）。BYOK 接入任意 OpenAI 兼容端点——DeepSeek、Kimi、OpenRouter、本地 Ollama 都行；没有账号体系，没有后端服务器，不收订阅费：你自己的 Key，你自己的数据，你自己的模型账单。

常见的侧栏 AI 助手大多要求订阅、把对话送到厂商后端；本地模型侧栏则往往只是一个聊天窗口。TARS 的差异点在于把「代理」做成了动词——它能真的读懂长页面、操作页面、带着工具箱上网。

## ✨ 功能

- 📖 **读页答疑** — 当前页面转成结构化 markdown 再喂给模型；长文档支持大纲、关键词定位、分窗阅读，不会刷爆上下文
- 🖱️ **页面操作** — 模拟真实鼠标点击、表单填写与回车提交，React 受控组件也能正确感知；执行前弹确认卡供你放行（目标页面、写入内容一目了然），只在明确要求时才动页面
- 🔍 **联网搜索** — 默认关闭；开启即用且无需任何 Key：后台短暂打开真实搜索引擎标签页（DuckDuckGo / Bing / Google / 百度），读取完整渲染的结果页后立即关闭，引擎按健康表动态排序；进阶用户仍可手动配置 Tavily / 博查 / Brave API
- 🌐 **读取网页** — 给它一个链接即可读正文，长文分页读，GBK 等编码自动识别
- ⚡ **技能** — 安装 SKILL.md 格式的任务指令包（兼容 Agent Skills 开放标准），输入 `/` 呼出联想菜单随时调用；自带管理页，可编辑、停用、删除
- 🧠 **长期记忆** — 明说「记住…」即可跨会话记住偏好与个人信息；稳定事实存成可更新的卡片，每轮自动携带，记忆页随时查看管理
- 🔌 **MCP 服务器接入** — 远程 MCP 服务器的工具自动并入工具箱（GitHub / Linear 等托管端点或本机 HTTP 端点），支持新旧两代协议与自定义请求头
- 🖼️ **图片输入** — 选图或粘贴发给视觉模型，面板内自动压缩转码，按模型能力门控
- 🧩 **多供应商模型** — 保存多个模型服务随时切换，模型选择器按供应商分组；每个模型可独立配置上下文窗口、最大输出与视觉能力
- 🗜 **上下文自动压缩** — 对话过长时自动把较早轮次压成结构化摘要，长会话不「失忆」；三档触发时机，摘要可指定便宜模型生成，聊天记录本身不受影响
- 🌗 深浅色主题 · 8 套重点色 · 界面语言切换（简体中文 / English）· 多会话历史 · 任务完成系统通知 · 诊断日志导出

## 🔒 隐私与数据

TARS 没有后端，谈不上「上传」：

- **安装零站点授权**：manifest 不声明任何 host 权限。读取页面、联网搜索、按链接读网页，需要你在 设置 → 安全 里用 Chrome 标准弹窗显式授权「页面与网络访问」（可随时撤销）；模型端点在添加服务时按域单独授权
- 对话、记忆、技能、设置与 API Key **只存在你的浏览器里**（IndexedDB + `chrome.storage.local`），卸载扩展即消失
- 模型请求从你的浏览器**直连你配置的端点**，途中没有第三台服务器；日志在导出前自动脱敏 Key
- 打开联网搜索后，搜索词会发给搜索引擎（或你配置的搜索服务）；启用 MCP 工具后，相关请求内容会发给对应服务器——两类能力都默认关闭、开启时界面明示
- 源码即声明：一切请求路径都可以在代码里直接验证

## 🚀 快速开始

要求 Node ≥ 20、pnpm ≥ 10。

```bash
git clone https://github.com/404notfxxked/TARS-sidebar-agent.git
cd TARS-sidebar-agent
pnpm install
pnpm build        # 产物输出到 dist/
```

1. 打开 `chrome://extensions`，开启右上角「开发者模式」
2. 点「加载已解压的扩展程序」，选择本项目的 `dist/`
3. 点工具栏图标打开侧栏，在设置里填入 Base URL 与 API Key（例如 `https://api.deepseek.com/v1`）
4. 想让它读页面 / 联网 / 操作网页：到 设置 → 安全 点「授权页面与网络访问」；不需要读页问答的话，跳过这步也能正常聊天

「联网搜索」默认关闭：开启后默认走免 Key 抓取通道（质量随网络出口浮动），也可在设置里改选搜索服务并填入对应的 API Key。关闭状态下 TARS 只读当前页面，不发出任何联网请求。

## 💡 使用须知

- **安装后默认不读任何页面**：站点授权是显式的——读页 / 搜索 / 读网页前到 设置 → 安全 授权一次即可，撤销立即生效；模型端点在添加服务时单独按域授权
- **首条回复偏慢**：MV3 的 service worker 按需冷启动 + 首次连接模型端点，属预期；同会话后续请求正常速度
- **搜索时会看到一闪而过的标签页**：免 Key 通道靠真实搜索引擎标签页拿完整结果页，读完即自动关闭、不留痕迹；引擎健康表会记住哪些引擎在你当前网络下好用，不可达的自动沉底
- **清除浏览数据会连带清掉会话历史**：会话按 7 天短命数据设计（可调或关闭），重要内容别指望它长期保存
- **MCP 仅支持远程 HTTP 服务器**：需要本地进程的 stdio 服务器不支持（零安装的产品取舍）

## 🧭 架构

```
sidepanel (React) ⇄ port（消息协议）⇄ Service Worker
                                      ├─ agent/     ReAct 循环 · 上下文压缩
                                      ├─ tools/     内置工具注册表（读页/操作/记忆…）
                                      ├─ web/       联网搜索 · 网页抓取
                                      ├─ mcp/       远程 MCP 服务器接入
                                      ├─ sessions/  会话持久化（IndexedDB）
                                      ├─ memory/    长期记忆
├─ offscreen doc   HTML → markdown 解析（SW 无 DOM）
└─ content script  页面感知与操作（按需注入,只碰被授权的页面）
```

MV3 的 service worker 没有 DOM 且随时休眠——解析放进 offscreen document，状态即时落盘，网络全部收归 SW，面板只管渲染。设计取舍写在各模块的文件头注释里。

## 🛠 设计上的几处较真

- **手写 ReAct 循环，不用框架**：裁剪、预算、取消传播、超步收尾这些框架替你做的默认值，都在自己手里，每段可讲清为什么
- **虚拟上下文**：裁剪与压缩只改「发给模型的 prompt」，落盘永远全量——历史与记忆随时可摘除，界面回放与模型所见互不污染
- **确定性 E2E**：CDP Fetch 层拦截扩展上下文的真实网络请求，mock LLM 按脚本驱动真循环、断言锚定日志与实库；纯逻辑另有 vitest 单测层
- **无 UI 组件库**：Material 3 配色由单一源色生成，深浅色 × 8 套重点色共用一套设计令牌

## 🗺 路线

- [ ] page_screenshot 视觉回传（让 agent 看见它操作的页面）
- [ ] PDF 读取
- [ ] 技能脚本（`scripts/`）执行
- [ ] Chrome Web Store 上架（条件触发）

## 📄 License

[MIT](LICENSE)。第三方依赖：React（MIT）、turndown（BSD-3-Clause）、highlight.js（BSD-3-Clause）、tailwindcss（MIT）——完整清单见 [package.json](package.json) 与 `pnpm-lock.yaml`。

版本变更见 [CHANGELOG](CHANGELOG.md)。
