# tests/ 地图 — 单元测试 + E2E 套件分类

两层测试,配合使用:

- **单元测试**(`pnpm test`,vitest):纯逻辑层秒级回归,改了就跑,
  不用 build 不用浏览器。**用例在 src/ 内与被测模块同目录
  (`*.test.ts`)**(build 的 tsc 顺带对其做类型检查,产物不打包)
- **e2e 套件**(`node tests/run.mjs <域>`):真扩展 + CDP mock,按域挑着跑;
  **改哪块跑哪块,全量(--all)留给发版与横切重构**

硬约定:mock 必须走 CDP 拦截(lib-cdp-mock.mjs),裸 http server 的
SSE 会让 Playwright 挂死。
e2e 套件先 `pnpm build` 再跑(run.mjs 会提醒 dist 过期);
断言套件 PASS/FAIL 对应退出码。

## 运行环境

- 本地:`node tests/run.mjs <域...> | --all`;视觉截图产物统一在
  `/tmp/tars-m3/`(人看,不进仓库)
- CI:`.github/workflows/e2e.yml`(手动触发,支持按域参数)——e2e 驱动
  真实扩展窗口,headful 跑,CI 里经 `xvfb-run` 包裹;Chromium 用
  `playwright install --with-deps` 安装,另装 `fonts-noto-cjk` 保证
  截图里的中文不是豆腐块
- 保持本地的脚本(`real-search-probe.mjs`,经根 .gitignore 精确排除):
  对真搜索引擎发真实查询,公开等于提供刷引擎工具且会把出口 IP 写进
  CI 日志。仍被 check-test-strings 与 biome 本地扫描

## 单元测试(vitest)

- `pnpm test` / `pnpm test:watch` / `pnpm test:coverage`;用例
  `src/**/*.test.ts` 与被测模块同目录,配置在根目录 `vitest.config.ts` +
  `vitest.setup.ts`(内存版 chrome.storage 桩,供 logger/loadConfig 使用;
  vitest 优先读 vitest.config.ts,与扩展构建的 vite.config.js 互不干扰)。
  coverage 口径是 all:true 全量文件(默认只报被 import 的文件,数字虚高);
  thresholds 只钉已强区域防倒退,零覆盖区先出报告不设门槛
- 现有十二篇:src/background/agent/compaction.test.ts(窗口公式/档位/切分/
  滚动合并/撞窗文案)、src/background/agent/toolBatch.test.ts(读写分组
  并行批次)、src/background/provider/openai.test.ts(SSE 脏形态/看门狗 +
  adapter 流式聚合:arguments 分片/多工具交错/name 分片/length 截断)、
  src/background/tools/toolContext.test.ts(tabId 回退链)、
  src/background/web/engineHealth.test.ts(健康表排序)、
  src/shared/memory.test.ts(注入规划/预算不变式)、
  src/shared/configStore.test.ts(读时迁移:旧版供应商合成、搜索单槽
  弃用)、src/shared/i18n/index.test.ts(zh/en 键位+占位符一致、t() 行为)、
  src/shared/skills.test.ts(SKILL.md frontmatter 解析:嵌套元数据/块标量/
  chomping/非法输入拒绝)、src/offscreen/pipeline.test.ts、
  src/sidepanel/chat/greeting.test.ts,以及 2026-09-17 起的 UI 层三篇
  (useRunSegments 段状态机 / ConfirmCard 内容组装与出口 / ModelPicker
  键盘导航;`@testing-library/react` + jsdom + 每文件
  `// @vitest-environment jsdom` 先例。注意 vitest 未开 globals:RTL
  自动 cleanup 不生效,组件测试文件需手动 `afterEach(cleanup)`)
- 只测「不碰 DOM/IDB/网络的模块」;交互与链路归 e2e

## UI 文案断言规范(强制,run.mjs 入口自动检查)

- **断言用户可见文案一律从 `lib-i18n.mjs` 取键**:`zh.chat.openSettings` /
  `en.memory.pin`;选择器内嵌用模板串 `` `button[aria-label="${zh.chat.send}"]` ``。
  字典改文案,断言自动跟随——**禁止把文案抄成字面量**(2026-09-10 曾因
  招呼语池字面量与字典漂移出 flaky,此规范即其根治)。
- 文案是有限选项集(时段问候 greetMorning~LateNight 这类)时,从字典
  显式列键取值拼「任一命中」正则,不手抄文案数组。
- 含 `{n}`/`{query}` 插值的文案,断言用键值 `replace("{n}", 实参)` 填参
  (比抄子串更强);只断言措辞片段时用键派生子串
  `键值.split("{")[0].trim()` / `.split("·")[1]?.split("{")[0].trim()`。
- 字面量仅允许标注 `// i18n-ok` 豁免的三类:①后端日志语义(后台文案
  硬编码于 agent.ts 等,与字典同文不同源,如 `msg.includes("失败")`);
  ②子串选择器/源码硬编码前缀(与源码同文不同源);③测试种子与 mock
  内容(非 UI 断言,如 seedSessions 的会话标题)。
- 强制手段:`check-test-strings.mjs` 扫描全部测试脚本(双/单引号 +
  模板串静态段),命中三类漂移形态即 FAIL——A 逐字等于字典值;
  B 字面量(≥3 字)是字典值的子串;C 字面量以含占位符字典值的首段
  开头(插值填参形态)。2026-09-17 反转升级:旧规则只抓逐字相等,
  插值填参与子串绑定全部漏放,本次评审实锤后收口。豁免:行内
  `i18n-ok`,以及 check/ok/assert/fail/console.log 第一参(断言标签与
  诊断横幅是人读输出,不是 UI 断言)。已知局限:跨行模板串、正则
  字面量不在扫描范围。`run.mjs` 每次入口先跑它;写新测试先 import
  lib-i18n;拿不准键名查 `src/shared/i18n/locales/zh-CN.ts`。

## e2e 底座

- `lib-cdp-mock.mjs` — CDP Fetch 拦截 + 环形日志断言(readLogs/waitForRunLog)
  + ask/sse + seedSessions/seedMemories/setTheme;所有套件的地基,新链路照
  verify-*.mjs 模式加套件(并在 run.mjs SUITES 登记)
- `fixtures/` — 搜索结果页/读页 HTML(verify-web-search 专用)

## e2e 断言套件(verify-*,按功能域一一对应;node tests/run.mjs <域名>)

| 域名 | 套件 | 覆盖 |
|---|---|---|
| `persist` | `verify-persist.mjs` | 会话库:旧存储迁移/多会话/删除/浏览器重启/保留期 |
| `compaction` | `verify-compaction.mjs` | 上下文压缩:触发/滚动/UI 分隔条/压缩模型/撞窗重试 |
| `memory` | `verify-memory.mjs` | 长期记忆:工具存取/<user-memory> 注入/预算裁剪/记忆页 CRUD+清空(Esc 层级/两段确认)/标题防污染/轻提示 |
| `skills` | `verify-skills.mjs` | 技能:SKILL.md 安装解析// 菜单(触发/过滤/键盘回填)/<skill> 注入与位置/未知与停用透传/总开关/历史回放投影/编辑改名/两段确认删除。坑:编辑器值经 SKILL_RAW 异步回填,断言前必须轮询等非空(waitFor 只保证挂载) |
| `mcp` | `verify-mcp.mjs` | MCP 接入:工具注入与调用/现代协议头/旧版 initialize 握手/isError 回传/宕机隔离/设置页 UI |
| `web-search` | `verify-web-search.mjs` | 搜索 tab 通道(fixture 解析/兜底切换/风控冷却/节流)/BYOK API 三家/web_fetch/开关门控/工具预算/取消(工具中) |
| `vision` | `verify-vision.mjs` | 图片链路:门控/发送/持久化/历史回放 |
| `screenshot` | `verify-screenshot.mjs` | 视觉通道:page_screenshot 主链路(SoM marks 表/捕获/带图 user 消息注入/images store 落库)/非视觉门控滤除/scroll_page 几何联动。headful 必须(xvfb-run) |
| `cancel` | `verify-cancel.mjs` | 停止按钮链路(LLM 流中取消;与 web-search 的 H 场景互补) |
| `llm-errors` | `verify-llm-errors.mjs` | LLM 端点异常路径:401 鉴权失败(明确错误不重试)/流中途错误帧(服务端文案透传)/网络层断连(Fetch.failRequest,重试耗尽)/finish_reason=length(截断上屏不报错) |
| `interact` | `verify-interact.mjs` | 页面交互工具(独立 harness:esbuild 注入,不加载扩展;esbuild 为显式 devDep) |
| `confirm` | `verify-confirm.mjs` | 写操作确认门(安全 V1):确认卡内容(目标页/写入/回车/定位)/拒绝 declined 回给模型/允许放行到内容层/设置页安全分节;断言用 readRunLogs(run 窗口),mock 环境整轮 <100ms 时间窗会串 |
| `layout` | `probe-layout.mjs` | 悬浮层布局回归(docScrollable/headerTop/innerScrollable 数值断言),契约 6 硬规则的自动化防线 |
| `locale` | `probe-locale.mjs` | 语言切换:整树刷新/回首页/重载持久化 |
| `focus` | `probe-focus.mjs` | 焦点与滚动体验:面板 autofocus/悬浮层关闭焦点回归/运行中输入框可编辑/「回到最新」出现-回底-消失/模型选择键盘导航(↑↓/Home/End/Enter/Tab/Esc)/历史搜索 autofocus |
| `tool-labels` | `probe-en-tools.mjs` | 英文界面下工具行/摘要走面板字典(SW 侧中文 displayName 不泄漏);内置工具名 = 字典键映射,MCP 回退「服务器 · 工具名」 |
| `actions` | `probe-actions.mjs` | 消息动作行:复制(剪贴板+已复制反馈)/末条重新生成(本轮收尾气泡与历史回放两条挂点,断言 IDB 库态:提问不重复、旧答案行已截掉) |
| `quote` | `probe-quote.mjs` | 每日一句:缓存 miss(API 延迟 2.5s)挂载不跳变/出处悬停显形(computed opacity)/设置开关与重载持久化 |

## 视觉/诊断探针(人看截图/DOM,不判 PASS/FAIL)

- `shot-m3.mjs` — 视觉主工具(2026-09 并入 probe-memory-ui/probe-mcp-ui/
  probe-hints):一条命令留档全部页面 —— mock 对话驱动 深浅色 × 对话/设置/
  历史/模型弹层/记忆页(12 条/空态/超预算)/ MCP 设置卡与过程卡 +
  console error 收集;`--accents` 只跑 8 套重点色试色;`--hints` 只跑
  设置提示分层留档(ⓘ 悬停/「了解详情」折叠展开,中英各一组,带 ok
  健康检查)

## 保持本地(.gitignore 精确排除,不入库)

- `real-search-probe.mjs` — 真网探针(不进 run.mjs):只 mock 模型,
  搜索引擎走真网,验证当前网络下 tab 通道各引擎的真实可达性与解析结果。
  对引擎发真实自动化查询,不宜公开分发,也勿在 CI 跑(出口 IP 入日志)

## 已删除 / 并入(2026-09 二次清理;2026-09-17 三次清理补两行)

- `try-search.mjs` → 删(2026-09-17:退役调试器,扩展链路早已不同形,
  本地排查改用 real-search-probe.mjs)
- `probe-hints.mjs` → 并入 shot-m3 --hints(2026-09-17:视觉家族归一,
  顺修 en 未导入的 ReferenceError)
- `probe-memory-flow.mjs` → 删(与 verify-memory T5-5/6/7 完全重合)
- `probe-search-key-slot.mjs` → 并入 verify-web-search G9(串 key 回归归搜索域)
- `probe-memory-ui.mjs` / `probe-mcp-ui.mjs` → 并入 shot-m3(同 profile 同产出的视觉家族)
- `probe-switch.mjs`(2026-09 首轮清理:断言的记住我开关已随多供应商重构删除)
- `probe-shots.mjs`/`probe-sticky.mjs` → 并入 probe-layout(同上)
- `shot-accents.mjs` → 并入 shot-m3 --accents(同上)
