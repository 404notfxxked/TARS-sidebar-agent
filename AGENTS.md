# AGENTS.md — AI 助手开发约定

> 目的:让任何新会话(AI 助手或新人)在动手前就知道这个仓库的硬约定,
> 不靠口口相传。**本文件只写"必然影响正确性的规则 + 指针",细节以被指
> 文件为准**——这里是路标,不是地图副本(副本必然腐化)。

## 改代码前必读

- **测试分层契约**:[tests/README.md](tests/README.md) —— 纯逻辑归
  vitest 单测(`pnpm test`,与被测模块同目录 `*.test.ts(x)`),交互链路
  归 e2e(`pnpm build && node tests/run.mjs <域>`),改哪块跑哪块
- **优化项台账**:`memory/test-optimization-plan.md`(本地,不入库;
  agent 能力项在 `memory/agent-capability-plan.md`),完成条目回填 hash

## 硬规则(违反即返工)

1. **用户可见文案一律走 i18n 字典键**:源码用 `t("key")`,测试断言经
   `tests/lib-i18n.mjs` 取键;插值文案用键值 `replace("{n}", 实参)` 或
   `split("{")[0]` 派生子串,禁止手抄文案。`tests/check-test-strings.mjs`
   在每次 e2e 入口强制(逐字/子串/占位符前缀三类漂移都抓),确属协议
   常量/测试种子的行内标 `// i18n-ok`
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
   (CRLF/多行 data/坏帧)以 `openai.test.ts` 的 9 用例为准绳,改流式
   解析必须保持全绿
10. **面板异步回填必须比新鲜度**:后到的异步数据替换本地视图前,必须
    带动作计数快照比对(actionSeq 模式,见 useAgentChannel),期间有
    本地动作即作废——不比新鲜度的补全会覆盖刚提交的用户输入
11. **并行化破坏「串行化/单例」假设时,实现与头注必须同步改**:给共享
    单例加并发路径前,先审它全部注释里的串行假设(toolContext 竞态先例);
    多持有者的清理用条件清除(`current === mine` 才置空),不越权
12. **诊断日志不记超出功能必需的原文**:content 工具不记 args;联网
    工具 query 只留 40 字符;新工具日志按同一判据——「导出诊断时是否
    带走超出功能必需的原文」

## 提交与验证

- 常规门禁:`pnpm lint && pnpm typecheck && pnpm test && pnpm build`
  (build 串 check-version/check-i18n);e2e 用 `node tests/run.mjs <域>`
- commit 风格:conventional commits + 中文主题(见 `git log`),测试
  改动用 `test(...)` scope
- 覆盖率基线与优化优先级见 `memory/test-optimization-plan.md`
