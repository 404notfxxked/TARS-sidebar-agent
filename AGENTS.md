# AGENTS.md — AI 助手开发约定

> 目的:让任何新会话(AI 助手或新人)在动手前就知道这个仓库的硬约定,
> 不靠口口相传。**本文件只写"必然影响正确性的约定 + 指针",细节以被指
> 文件为准**——这里是路标,不是地图副本(副本必然腐化)。协作约定管
> 「怎么一起干活」,硬规则管「什么会弄坏产品」;本文件只引用仓库内
> 文件,公开仓库可直接复用。

## 改代码前必读

- **这是什么**:TARS,Chrome MV3 侧栏 ReAct agent 扩展(BYOK,无后端)。
  四个运行域:`src/sidepanel`(React 面板,只渲染)、`src/background`
  (SW:agent 循环/工具/网络,无 DOM、随时休眠)、`src/offscreen`(DOM
  解析)、`src/content`(页面操作,按需注入);跨域共享在 `src/shared`。
  全景见 README「架构」
- **测试分层契约**:[tests/README.md](tests/README.md) —— 纯逻辑归
  vitest 单测(`pnpm test`,与被测模块同目录 `*.test.ts(x)`),交互链路
  归 e2e(`pnpm build && node tests/run.mjs <域>`),改哪块跑哪块

## 协作约定(行为层,与技术硬规则同效力)

1. **先调研规划,经确认再动工**:非平凡任务先读相关代码,给出计划
   (改动面/取舍/怎么验证),用户认可后再实施;用户在提问或讨论时,
   交付的是分析结论,不是代码改动
2. **commit 必须用户明确要求**:未经明示不 commit、不 push;提交按
   「提交与验证」的风格与门禁执行,完成后回报 hash 与改动范围
3. **只做任务要求的事**:顺手发现相邻问题就报告并记账(不动手);
   批量重构、删文件、改公共接口一律先经确认
4. **如实汇报验证**:交付前按「改哪块跑哪块」跑对应门禁,红绿照实
   说;没跑的验证明说没跑,不用「应该没问题」替代

## 硬规则(违反即返工)

1. **用户可见文案一律走 i18n 字典键**:源码用 `t("key")`,测试断言经
   `tests/lib-i18n.mjs` 取键;插值文案用键值 `replace("{n}", 实参)` 或
   `split("{")[0]` 派生子串,禁止手抄文案。`tests/check-test-strings.mjs`
   在每次 e2e 入口强制(逐字/子串/占位符前缀三类漂移都抓),确属协议
   常量/测试种子的行内标 `// i18n-ok`。源码侧同纪律:`t()` 只写字面量
   键,动态拼键被 check-i18n 拦 build(`scripts/check-i18n.mjs`,键映射
   一律写字面量);SW 侧错误/状态文案当前不经字典(中英混杂透传),属
   已知债务——动它先立设计决定,别把字典键穿进 background
2. **e2e 断言不做恒真打卡**:`check(true, ...)` 是零信息断言;waitFor
   成功后必须对捕获值断言。环境敏感分支(剪贴板等)只对"环境拒绝"
   降级,内容不匹配照常 FAIL
3. **e2e 等待一律事件驱动/轮询**:新增固定 `sleep(N)` 等待状态会引入
   单点 flake(启动等待、按钮翻转、异步回填都有事件式写法可抄,见
   `lib-cdp-mock.mjs` 的 waitForEvent/waitForRunLog 与套件内轮询先例)
4. **e2e mock 必须走 CDP 拦截**(`lib-cdp-mock.mjs`),裸 http server 的
   SSE 会挂死;网络注入用 `ctx.fulfill`(HTTP 形态)或 `ctx.failNetwork`
   (断连形态)
5. **测试文案选择器从 `lib-i18n.mjs` 取键拼模板串**;新链路照
   verify-*.mjs 模式加套件并在 `tests/run.mjs` SUITES 登记
6. **单元测试环境**:默认 node;碰 DOM 的文件头加
   `// @vitest-environment jsdom`。组件测试(vitest 未开 globals)必须
   手动 `afterEach(cleanup)`,期望串从 `zhCN` 字典键派生(组件拼装用
   全角标点,手写期望必错)
7. **覆盖率口径是 all:true 全量**(`pnpm test:coverage`),thresholds 只
   钉已强区域防倒退;新增测试落在哪,就把那个区域的棘轮抬上去
8. **喂给模型的拼接输入必须有硬预算**:转写/注入/检索回填一律设上界,
   放不下即打桩(保留最新、桩里声明体量),禁止无上界拼接;摘要/压缩类
   子请求的输入同样受预算约束,否则主链路的兜底会静默失效(先例:压缩
   转写 120k 打桩,compaction.ts `toTranscript`)
9. **已开始的流式请求不得自动重试**:delta 已发出,UI 与落库都在消费,
   重放必重复——只能 abort 报错交给人,「重新生成」是唯一兜底;流必须
   挂 inactivity watchdog(30s 超时只护响应头);SSE 解析的脏形态
   (CRLF/多行 data/坏帧)以 `openai.test.ts`「readSSE 兼容端点脏形态」
   一组用例为准绳,改流式解析必须保持全绿
10. **面板异步回填必须比新鲜度**:后到的异步数据替换本地视图前,必须
    带动作计数快照比对(actionSeq 模式,见 useAgentChannel),期间有
    本地动作即作废——不比新鲜度的补全会覆盖刚提交的用户输入
11. **并行化破坏「串行化/单例」假设时,实现与头注必须同步改**:给共享
    单例加并发路径前,先审它全部注释里的串行假设(先例:
    `toolContext.ts` 头注的并发安全修订);多持有者的清理用条件清除
    (`current === mine` 才置空),不越权
12. **诊断日志不记超出功能必需的原文**:content 工具不记 args;联网
    工具 query 只留 40 字符;新工具日志按同一判据——「导出诊断时是否
    带走超出功能必需的原文」
13. **React Compiler 下渲染期禁读模块可变态**:构建开了
    babel-plugin-react-compiler(vite.config.js),它把「非 props/state/
    hook 返回值」当永久缓存。面板组件文案一律 `const t = useT()`
    (ui/hooks.ts),禁用模块级 `t()`;render 期辅助函数第一参收 `TFn`
    (shared/i18n);手写 memo 判据「删了语义变不变,变才留」。语言切换
    文案冻结这类问题,排查终点是编译产物而不是源码推理
14. **面板 UI 不私造样式,生成物禁手改**:新 UI 只用 `styles/` 下既有
    接口类(`.settings-card` / `.settings-field` / `.settings-btn` /
    `.switch` / `.combo-pop` 等见 settings.css,chat 浮层见 chat.css;
    `.settings-card` 直接子块不自垫上下 padding,节奏由选择器统一管);
    `styles/m3.css` 是 `pnpm tokens:m3` 的生成物,改色板去
    `scripts/generate-m3.mjs` 改源色重新生成
15. **架构不变式(违反即架构回退)**:①虚拟上下文——裁剪/压缩只改发给
    模型的 prompt,落盘永远全量(历史回放/记忆摘除/重新生成的地基);
    ②页面写动作必须过确认门(`confirmations.ts` CONFIRM_TOOLS),新增
    写工具先入集合再上线;③联网/MCP 类能力默认关闭、开启时界面明示,
    新联网/读页链路动作前经 `shared/hostAccess.ts` 查权限,无权限回
    可行动指引而非裸错误;④SW 随时休眠——状态即时落盘,落盘失败不打断
    run、留边界等下个收口点重写

## 提交与验证

- 常规门禁:`pnpm lint && pnpm typecheck && pnpm test && pnpm build`
  (build 串 check-version/check-i18n);e2e 用 `node tests/run.mjs <域>`;
  有意为之的偏离用 `biome-ignore` 注明理由
- CI:push/PR 到 main 自动跑上述四件套(checks.yml);e2e 手动按域 +
  nightly 全量、失败自动开 issue(e2e.yml)。pnpm 版本只在 package.json
  `packageManager` 声明(CI 自动跟随,同一事实只写一处);本地门禁
  先行,push 是重放不是首验
- 发版:三步 manifest/package.json bump → CHANGELOG `[Unreleased]` 定版
  并开新段 → 推 `v*` tag;release.yml 随 tag 自动跑单测 + 构建门禁 +
  tag 三方校验 + 全量 e2e,全绿才打包 zip 并发布(notes 取 CHANGELOG
  对应段,缺段即拦)。用户可感知的变化随手进 `[Unreleased]`
  (Keep a Changelog + 语义化版本,政策见 CHANGELOG 头)
- commit 风格:conventional commits + 中文主题(见 `git log`),测试
  改动用 `test(...)` scope
