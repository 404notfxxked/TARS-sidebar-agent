# tests/ 地图 — 单元测试 + E2E 套件 + evals 分类

两层测试,配合使用:

- **单元测试**(`pnpm test`,vitest):纯逻辑层秒级回归,改了就跑,
  不用 build 不用浏览器。**用例在 src/ 内与被测模块同目录
  (`*.test.ts`;React 组件用 `*.test.tsx`)**(build 的 tsc 顺带对其做类型
  检查,产物不打包)
- **e2e 套件**(`node tests/run.mjs <域>`):真扩展 + CDP mock,按域挑着跑;
  **改哪块跑哪块,全量(--all)留给发版与横切重构**

硬约定:mock 必须走 CDP 拦截(lib-cdp-mock.mjs),裸 http server 的
SSE 会让 Playwright 挂死。
e2e 套件先 `pnpm build` 再跑(dist 过期时 run.mjs 警告并置红退出码);
断言套件 PASS/FAIL 对应退出码。

## 断言纪律(所有套件通用)

- `check(true, ...)` 是零信息断言,禁止——waitFor 成功只代表等到了,
  必须对捕获到的值再断言(等到了 ≠ 内容对)
- 环境敏感的分支(剪贴板之类)只对「环境拒绝」降级跳过;内容不
  匹配照常 FAIL,不许借环境之名放过

## 运行环境

- 本地:`node tests/run.mjs <域...> | --all`;视觉截图产物统一在
  `/tmp/tars-m3/`(人看,不进仓库)
- CI:`.github/workflows/e2e.yml`(e2e:手动触发,支持按域参数;另有
  schedule nightly 全量,UTC 19:00 = 北京 03:00)——e2e 驱动
  真实扩展窗口,headful 跑,CI 里经 `xvfb-run` 包裹;Chromium 用
  `playwright install --with-deps` 安装,另装 `fonts-noto-cjk` 保证
  截图里的中文不是豆腐块
- 保持本地的脚本(`real-search-probe.mjs`,经根 .gitignore 精确排除):
  对真搜索引擎发真实查询,公开等于提供刷引擎工具且会把出口 IP 写进
  CI 日志。仍被 check-test-strings 与 biome 本地扫描

## 单元测试(vitest)

- `pnpm test` / `pnpm test:watch` / `pnpm test:coverage`;用例
  `src/**/*.test.ts(x)` 与被测模块同目录,配置在根目录 `vitest.config.ts` +
  `vitest.setup.ts`(内存版 chrome.storage 桩,供 logger/loadConfig 使用;
  vitest 优先读 vitest.config.ts,与扩展构建的 vite.config.js 互不干扰)。
  coverage 口径是 all:true 全量文件(默认只报被 import 的文件,数字虚高);
  thresholds 只钉已强区域防倒退,零覆盖区先出报告不设门槛
- **完整清单现取**:`find src -name '*.test.ts*'`(截至 2026-09-20 为 30 篇
  ——别在本文件手抄篇数,只举例说明覆盖)。既有用例覆盖(举例):
  src/background/agent/compaction.test.ts(窗口公式/档位/切分/
  滚动合并/撞窗文案)、src/background/agent/toolBatch.test.ts(读写分组
  并行批次)、src/background/provider/chatCompletions.test.ts(SSE 脏形态/看门狗 +
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
  自动 cleanup 不生效,组件测试文件需手动 `afterEach(cleanup)`;组件
  拼装用全角标点,期望串从 zhCN 字典键派生,手抄必错)
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
- 强制手段:`check-test-strings.mjs` 扫描 `tests/*.mjs` 与
  `src/**/*.test.ts(x)`(双/单引号 + 模板串静态段),命中三类漂移形态
  即 FAIL——A 逐字等于字典值;B 字面量(≥3 字;选择器内层 ≥2)是
  字典值的子串;C 字面量以含占位符字典值的首段开头(插值填参形态)。
  2026-09-17 反转升级:旧规则只抓逐字相等,插值填参与子串绑定全部
  漏放,实测实锤后收口。2026-09-21 补嵌套引号盲区:选择器形态行
  (含 `[`、`^=`、`*=`、`:has-text`、`aria-label`、`alt=`)的外层字面量
  再抽一层内层引号串套同一规则(内层子串下限 2,两字手抄如
  `'img[alt^="图片"]'` 同样入闸)——仍只限选择器形态行,断言标签
  不卷入。豁免:行内 `i18n-ok`,以及 check/ok/assert/fail/console.log
  第一参(断言标签与诊断横幅是人读输出,不是 UI 断言)。已知局限:
  跨行模板串、正则字面量里的 CJK 不在扫描范围;转义引号:单/双引号
  外层的同型转义内层不抽,模板串外层会抽出(内层正则不识别反斜杠)。
  **2026-09-29 补充**:断言惯用法统一为 `check(条件, 标签)`(makeChecker,
  参数序全仓归一)后,标签位于第二参,不再落入「第一参」豁免窗——
  与字典值撞形的标签按行内 `i18n-ok` 豁免(人读断言标签,合法类),
  条件内的字符串仍在扫描面内,不受影响。
  `run.mjs` 每次入口先跑它;写新测试先 import lib-i18n;拿不准键名
  查 `src/shared/i18n/locales/zh-CN.ts`。

## 固定等待计数棘轮(run.mjs 入口自动检查)

- 等待一律事件驱动/轮询(waitFor / waitForRunLog / 轮询循环),**禁止新增**
  `await sleep(<数字>)` 与 `await new Promise((r) => setTimeout(r, <数字>))`。
  存量按文件计数入 `check-fixed-waits.mjs` 的基线表(2026-09-21 修掉
  probe-actions / probe-locale 两处承重等待后实测),**超基线即 FAIL**,
  基线只降不升;确属必须的新增(如等外部 TTL)同步抬基线并说明理由。
- 豁免:`shot-m3`(纯视觉,人看不判 PASS/FAIL)、`real-search-probe`
  (.gitignore 排除)、`lib-cdp-mock`(库内轮询实现)。已知局限:只防
  数量增长,不防等量替换(有意取舍,成本远高于收益)。

## e2e 底座

- `lib-cdp-mock.mjs` — CDP Fetch 拦截 + 环形日志断言(readLogs/waitForRunLog)
  + ask/sse + seedSessions/seedMemories/setTheme;所有套件的地基,新链路照
  verify-*.mjs 模式加套件(并在 run.mjs SUITES 登记)。**层归属(2026-10):
  Playwright ^1.62 已能拦到扩展 SW 的 fetch,故 SW 发起的请求由手动 CDP 层
  独占处理,pw 路由层识别到 SW 请求立即让渡(不查路由表);页面导航类仍走
  pw 层——两层共用一条路由表,新套件的 mock 路由无需关心层。
  **统一入口(2026-09-29 收敛,新套件禁止再手抄这些样板)**:断言用
  `makeChecker`(ok,label,detail,全仓唯一签名);面板开关用 `openPanel`
  (goto/就绪/注配置+reload 一条龙;窄视口在其后 setViewportSize,勿在
  newPage 传 viewport——会破坏 mouse.wheel,详见其头注);模型配置用
  `seedProviders`;会话消息读 `idbMessages`;历史投影读 `loadHistoryViaPort`;
  整页文本 `bodyText`;固定等待 `sleep`(仍按调用点入棘轮计数)。
  **manifest flavor**(`launchWithCdp({ flavor })`,缺省 `granted`):
  `granted` = 静态全站授权 + 静态 content script(既有套件);`zero` = 只授权
  模型端点域,页面全部未授权(拒绝路径);`dynamic` = 全站授权但无静态
  content script(生产按需注入路径)。flavor 的用户数据目录必须按
  扩展目录+flavor 哈希确定性生成——路径一变扩展 ID 就变,
  verify-persist 这类跨重启对比存储的套件会全丢数据
- `fixtures/` — 搜索结果页/读页 HTML(verify-web-search 专用)

### e2e 不覆盖什么(避免误读「全绿」)

- **授权动作本身**:`chrome.permissions.request` 的原生弹窗无法自动化
  (实测 CDP userGesture 无效;Secure Preferences 种子会被 MAC 校验重置)。
  e2e 用 flavor 静态模拟授权的「结果」,判定路径(chrome.permissions.contains)
  与生产一致,但「点弹窗授权」这一步只有人工验证
- **零授权的运行态**:既有套件都跑在 `granted` flavor 上;拒绝路径
  (工具给可行动指引)只由 `host-access` 套件的 zero/dynamic 两个 flavor 覆盖

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
| `page-tools` | `verify-page-tools.mjs` | 读页三件套真实链路(面板→SW→offscreen→content 采样回填):outline→find→read 的 offset 体系/pos 续读/P0-1 截断标记(sections_truncated + web_fetch 指引,且不指 refresh)/正常页零误报 |
| `notify` | `verify-notify.mjs` | run 结束通知:开关关闭不通知/开启后按实测判据定期望(自洽断言:可见+持焦⇒抑制,否则⇒产生;getAll 可观测)/取消不打扰(基线相对)。焦点分支语义由 notify.test.ts 单测钉住 |
| `confirm` | `verify-confirm.mjs` | 写操作确认门(安全 V1 + 三档 confirmLevel):确认卡内容(目标页/写入/回车/定位;记忆族/外链族标题与内容)/拒绝 declined 回给模型/允许放行到内容层/web_fetch 出口判定(私网必卡/白名单命中直抓/白名单外逐个出卡 + 批准后同域复用)/三档矩阵(off:click/fill/memory 全程无卡真实分发;auto:click 免门、memory 仍过门拒绝 declined)/composer 档位 pill(场景 9:存储跟随/菜单切 strict 后弹卡 declined/菜单三项含 off 三档同权/单击切 off 下一轮全程无卡)/设置页安全分节(站点授权在场,档位反向断言);断言用 readRunLogs(run 窗口),mock 环境整轮 <100ms 时间窗会串 |
| `host-access` | `verify-host-access.mjs` | 权限拒绝路径与生产注入路径(zero/dynamic flavor):未授权工具给可行动指引且 run 正常收口(find_elements / web_fetch)/授权态无静态 content script 时按需注入真实执行(sendMessage 失败 → executeScript → 重试) |
| `layout` | `probe-layout.mjs` | 悬浮层布局回归(docScrollable/headerTop/innerScrollable 数值断言),悬浮层硬规则的自动化防线 |
| `locale` | `probe-locale.mjs` | 语言切换:整树刷新/回首页/重载持久化 |
| `focus` | `probe-focus.mjs` | 焦点与滚动体验:面板 autofocus/悬浮层关闭焦点回归/运行中输入框可编辑/「回到最新」出现-回底-消失/模型选择键盘导航(↑↓/Home/End/Enter/Tab/Esc)/历史搜索 autofocus |
| `tool-labels` | `probe-en-tools.mjs` | 英文界面下工具行/摘要走面板字典(SW 侧中文 displayName 不泄漏);内置工具名 = 字典键映射,MCP 回退「服务器 · 工具名」 |
| `actions` | `probe-actions.mjs` | 消息动作行:复制(剪贴板+已复制反馈)/末条重新生成(本轮收尾气泡与历史回放两条挂点,断言 IDB 库态:提问不重复、旧答案行已截掉) |

## 视觉/诊断探针(人看截图/DOM,不判 PASS/FAIL)

- `shot-m3.mjs` — 视觉主工具(2026-09 并入 probe-memory-ui/probe-mcp-ui/
  probe-hints):一条命令留档全部页面 —— mock 对话驱动 深浅色 × 对话/设置/
  历史/模型弹层/记忆页(12 条/空态/超预算)/ MCP 设置卡与过程卡 +
  console error 收集;`--accents` 只跑 8 套重点色试色;`--hints` 只跑
  设置提示分层留档(ⓘ 悬停/「了解详情」折叠展开,中英各一组,带 ok
  健康检查)

## evals(真模型行为基线,`node tests/evals/run.mjs`)

与断言套件的分工:verify-* 的模型永远是 mock(lib-cdp-mock 回放罐头 SSE),
锚定 harness 的确定性逻辑;evals 用**真模型**跑真扩展 + CDP fixture 页,度量
**模型 × harness 的耦合行为**——工具选择、确认门遵守、长文预算下的表现。
mock 能测的归 tests,evals 只测真模型才暴露的问题。程序化判分,无 LLM judge。

- 运行:`pnpm evals`(= `node tests/evals/run.mjs`)
  `[--case <name>] [--runs N]`(N 缺省 3)`[--mock]`;前置 `pnpm build`。
  REAL 模式(缺省)环境变量:`EVALS_BASE_URL` / `EVALS_API_KEY` /
  `EVALS_MODEL` 必填,`EVALS_KIND`(缺省 chat-completions)、
  `EVALS_CONTEXT_TOKENS`(缺省 128000)可选;env 不齐退出码 2 并报缺哪个。
  provider 约定 baseUrl 含 /v1(如 `https://api.deepseek.com/v1`),实测
  不带 /v1 亦可工作,观测计数与形态无关。`EVALS_DEBUG=1` 时观测路由向
  stderr 打印每次命中的 host/path/msgs/chars 计数(不含 query 与 body),
  供请求计数诊断。密钥只从 env 读,任何输出(JSONL/报告/日志)不含 key,
  baseUrl 只记 host
- `--mock`:罐头模型自检 runner 自身链路(直答探针 + fixture 转写探针 +
  两段式探针),无 key 可跑;不写 JSONL、不参与基线——output/ 只留真模型
  测量
- 判分口径:**pass^k**(k 次全过才算 pass);每 (case, run) 一行 JSONL 写
  `tests/evals/output/run-<时间戳>.jsonl`(.gitignore 排除,本地产物),
  行含 `llmRequests`(本 run 的 LLM 请求计数)、`answerHead`(最终回答
  前 500 字;仅回答文本不含工具参数原文——output/ 是 gitignore 本地
  产物不进 CI,与「最小原文纪律」的取舍:判分可诊断性优先,原文不出
  本机)与 `evalRev`(判分口径内容哈希:graders.mjs + 该 case 文件
  + 该 case 的 fixture 文件,sha256 前 8 位;口径变化 → rev 变化);
  结束打印按 case 聚合表(pass^k / 平均 turns / 平均工具调用数;
  error 行只进通过率分母,不进均值)并和 output/ 下最近一次**同模型+
  同 host** 的 JSONL 做基线 diff(单 model 不区分端点;kind 不入
  key):rev 一致才标回归/改善,rev 不同只列数值并提示「判分口径与
  基线不同」。退出码:全过 0 / 有 FAIL 1 / env 缺失 2。FAIL 是发现
  不是障碍——禁止为变绿放宽 grader、改 fixture 事实或改 instruction
- case 清单(按单一场景拆分,每条判分均为可达断言):
  `read-long-article`(145k 长文事实抽取,原六条判分;已知形态:事实在
  短末卷,模型可能仅凭 page_find+page_outline 直达、page_read 零调用,
  「翻窗阅读」要单独设计跨节聚合型 fixture 才测得到)/
  `truncated-doc-honesty`(180k fixture,事实不可达时**不编造、交代缺失**;
  其期望建立在每节 4k 截断之上(2026-10 起截断带省略量注记,信号已在,
  可达性仍无),src 截断策略再改动需重审,见 case 头注)/
  `confirm-deny-honesty`(被拒后如实交代,四条)/
  `confirm-retry-completion`(两段式:被拒→交代→用户再授权→应完成,
  五条+完成语义定稿判分)
- 两段式驱动:case 可选 `steps: [{instruction, confirmPolicy}]`,runner 以
  同一 sessionId 按序发送,confirms 按步拼接,turns 记各步合计;无 steps
  的 case 沿用 instruction/confirmPolicy 单段
- case 规格:`cases/*.mjs` export default(形状见 run.mjs 头注)。grade 从
  `graders.mjs` 取共享判分原语(结果/轨迹/终态三类)组装 checks;轨迹由
  `lib-eval-driver.mjs` 统一提取(历史投影里的工具调用序列 + 最终回答 +
  run 窗口日志),case 不摸原始结构。确认策略三档(auto_deny /
  deny_first_approve_rest / approve_all)由驱动经 port 自动应答;单步 run
  超时 300s;每次 (case, run) 独立 userDataDir,k 次运行之间不共享 IndexedDB
- fixture 规则:`fixtures/` 下合成内容(事实串全文唯一、置于指定区域,
  `<title>` 不含答案,无交互元素),经 CDP 路由回填(`https://eval-fixture.test/`
  域,永不触真网);**禁本地 HTTP server**(与 e2e 同款硬规则)。fixture 页
  由 runner 保证是除面板外唯一普通标签页——port 驱动不带 tabId,page_*
  工具的 tab 回退链落「实时激活 tab」。**设计约束**:读页转写对每节内容
  有 4k 截断(src/offscreen/pipeline.ts sectionText maxChars=4000;
  2026-10 起截断节末带「[本节超长,已省略 N 字]」注记——注记只加信号不加可达
  性,尾部内容仍读不到;全局 DOC_MAX_CHARS=160k 才置 truncated_total)
  ——判分所需的事实必须放在内容 <4k 的节里,否则尾部会被砍掉
- 花费口径:REAL 模式给模型端点注册 pass-through 观测路由,计数为 **CDP
  Fetch 层口径**——Playwright 路由层会对同一请求二次拦截(实测与 CDP 层
  成对到达),不计入,否则系统性 2×;健康标准是 `llmRequests` 与 turns
  1:1,偏离即用 `EVALS_DEBUG=1` 诊断。只记每轮请求的 messages 条数与字符
  数,不存原文
- 守卫说明:`check-test-strings` 与固定等待棘轮只扫 tests/ 根目录,
  不递归 `tests/evals/`——但规范照样遵守(eval 文件不写死 UI 文案、
  不用盲等)

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
