# AGENTS.md — TARS 开发约定

> 只收跨域的规矩和指针,细节以被指文件为准,不在本文复制。
> 规则会演化:被证伪或事故根源已消失的条目要删或降级,不可只增不减。

## 项目定位

TARS 是 Chrome MV3 侧边栏里的 ReAct agent 扩展:用户自带 API key
(BYOK),没有后端。四个运行域,各有一条不能破的边界:

- `src/sidepanel` — React 面板,只负责渲染,不含业务逻辑
- `src/background` — Service Worker:agent 循环、工具、网络;没有
  DOM,随时可能被浏览器休眠
- `src/offscreen` — DOM 解析(读页、解析 HTML)
- `src/content` — 页面操作,按需注入,保持经典脚本(见「边界」)
- `src/shared` — 跨域共享的代码与契约

全景见 README「架构」。

## 命令

- 包管理器锁定 pnpm,版本只在 package.json `packageManager` 声明
- 日常门禁:`pnpm lint && pnpm typecheck && pnpm test && pnpm build`
- 覆盖率:`pnpm test:coverage`
- e2e:`pnpm build && node tests/run.mjs <域>`,域清单见
  [tests/README.md](tests/README.md)
- **改哪块跑哪块**:改纯逻辑跑对应单测,改交互链路跑对应域的 e2e

## 工作流

1. 非平凡任务先读相关代码,给出计划(改哪里/取舍/怎么验证),
   经确认再动工;你在提问或讨论时,交付的是分析,不是代码改动
2. 操作 git(commit、push、merge、rebase、tag、reset)必须用户当轮
   明确要求,「收尾」「继续」这类泛指不算授权
3. 只做任务要求的事。顺手发现的相邻问题只报告不动手;值得记的
   必须带触发点(下次改到哪处会再看它),修完删条,给不出触发点的
   当场询问用户是否处理
4. 如实汇报验证:已跑的门禁红绿照实说;未跑的明说未跑,不得用
   「应该没问题」搪塞
5. 分支:多提交的功能轮次开 `feat/*` 分支,合回 main 用 `--no-ff`,
   让历史按功能成段、每个落点都完整可发版;单提交的修复/文档可
   直提 main。合流时人工核对语义——「文本无冲突」不等于「语义无
   冲突」,测试登记、输入预算、动作计数这些契约点逐一核验

## 代码与架构铁律

> 违规的发现方式在条末标注:〔CI:检查名〕= 构建或测试自动拦截,
> 〔测试:锚点〕= 有测试锚定但不自动拦截;未标注的规则只靠人审。

### 文案与日志

- 用户可见文案一律走 i18n 字典:`t()` 只写字面量键,禁动态拼键;
  插值用键值 `replace("{n}", 实参)` 派生,禁止手抄文案
  〔CI:check-i18n〕;测试断言从 `tests/lib-i18n.mjs` 取键
  〔CI:check-test-strings〕
- Service Worker 的错误与状态文案目前不经字典(中英混杂透传,
  已知债务):调整前先立设计决定,不得将字典键引入 background
- 后台日志面向模型与诊断,措辞是测试契约——verify-* 套件按日志
  子串断言链路,改措辞前先 grep tests/
- 诊断日志只记功能必需的最少原文(工具参数不记,查询词仅截取
  开头)。判据:导出诊断时是否会携带超出功能必需的原文

### 模型输入与输出

- 拼接后发给模型的文本必须有显式长度上限——读页转写、记忆
  注入、搜索回填,每个拼接点都要有;超限时保留最新内容,并在
  删除处留注记写明省略量。压缩、摘要这类二次请求的输入同样
  受上限约束,否则主链路的预算会被静默绕过
- 已开始的流式请求不自动重试:内容已在输出,重放必然重复;
  只能报错,由用户以「重新生成」兜底
- 流式响应必须挂不活动看门狗:HTTP 连接超时只护到响应头,流
  中途停滞需由看门狗发现并中断
- SSE 解析须容忍真实端点的脏形态(CRLF、多行 data、坏帧)
  〔测试:chatCompletions.test.ts 脏形态回归,改解析必须全绿〕

### 前端界面

- 后到的异步数据先核对新鲜度再替换视图:结果返回时先确认期间
  没有新的用户操作,否则丢弃本次结果,避免旧数据覆盖新状态
  (既有模式:动作计数快照)
- 构建启用了 React Compiler,不来自 props/state 的值会被它当
  永久缓存:组件文案每次渲染现取(`const t = useT()`),渲染期
  辅助函数第一参传入 t。切换语言后文案不变这类问题,查编译
  产物排查,仅凭源码推不出来
- 新 UI 只用 `styles/` 既有接口类(settings.css、chat.css),不
  私造样式;`m3.css` 是生成物禁手改,改源色需同步
  `scripts/generate-m3.mjs` 与设置页的色块副本并重新生成

### 架构不变式

- 共享单例大多默认「同一时刻只有一件事在发生」:增加并发路径
  前,先逐条审过注释里的串行假设,注释与代码同步改;清理公共
  状态只清自己那份(先比对再清空)
- 虚拟上下文:裁剪、压缩只改发给模型的 prompt,落盘永远全量
  ——这是历史回放、记忆摘除、重新生成的地基
  〔测试:e2e compaction/persist〕
- 页面写动作必须过确认门(CONFIRM_TOOLS 集合),新增写工具
  先入集合再上线〔CI:tools.test.ts 双向不变式〕
- 联网、MCP 能力默认关闭,开启时界面明示;动作前查 hostAccess
  权限,无权限返回可行动指引,不抛裸错误
- Service Worker 随时休眠:状态即时落盘,落盘失败不打断运行,
  留边界等下个收口点重写

### 边界

- `src/content/*` 保持经典脚本:不得运行时 import `src/shared/*`,
  跨域常量在本地声明〔CI:guard-content-classic-script〕
- 每个非测试源文件的头部注释写清职责与关键取舍;Service Worker
  与 offscreen 间的协议常量单点声明,确需镜像的(如 content 侧
  选择器常量)在镜像处写明同步义务

## 测试

分层契约、断言规范、等待写法、mock 方式、覆盖率口径,细则都在
[tests/README.md](tests/README.md),改测试前先读它。

## 提交与发版

- commit 风格:conventional commits + 中文主题,测试改动用
  `test(...)` scope
- push/PR 到 main 自动跑四件套;e2e 手动按域跑,nightly 全量
- 入库文档固定四份:README、CHANGELOG、AGENTS.md、tests/README,
  新增 `*.md` 须经用户当轮确认
- 发版三步:manifest 与 package.json 升版本 → CHANGELOG 的
  `[Unreleased]` 定版并开新段 → 推 `v*` tag;release 流程从
  CHANGELOG 取对应段发 notes,缺段即拦。用户可感知的变化及时记入
  `[Unreleased]`
- 有意偏离 lint 时用 `biome-ignore` 注明理由
