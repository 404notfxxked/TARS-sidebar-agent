// 验证 web_search / web_fetch 工具链路(tab 通道 + BYOK API)
// 用法: pnpm build && node tests/verify-web-search.mjs
//   网络受限环境: VERIFY_PROXY=http://127.0.0.1:8118 node tests/verify-web-search.mjs
//   (mock 请求在 CDP 层拦截,不受代理影响;只有「实网」场景的放行流量走代理)
//
// web_search 双通道验证:auto = 免 Key 真实标签页(tab 通道)/ 手动配置 Key 的 BYOK API。
// 本套件用 CDP Fetch 拦截 mock 搜索引擎结果页与三家服务端点,断言:
//   S0. 默认关闭:不注入任何搜索配置时 web_* 工具不可见 + 系统提示声明
//   A0. 免 Key tab 通道:后台开真实标签页,ddg fixture 解析回填、URL 最小形态、记录 mode=tab
//   A0b. 兜底切换:ddg 风控挑战页 → 冷却 → 自动换 bing(uddg/ck 链接还原)
//   A0c. 风控冷却:冷却中的 ddg 被直接跳过(不再发请求)
//   A0d. 同引擎节流:两次连续 ddg 搜索的间隔被拉开(≥2.3s)
//   A/B/C. API 通道三家:Tavily POST+Bearer / 博查 count+freshness / Brave GET+market 映射
//   D. 限流冷却:429 → 报错回填;冷却期不再发请求;清除后恢复
//   H. 取消传播:中止 run 立即中断在途搜索请求(非等超时)
//   E. web_fetch 分页 / E2. GBK 解码 / F. 实网 example.com / J. 工具结果预算
//   G. 联网开关:关→隐藏;开→可见;选服务商但没填 Key→自动退回 tab 通道
//
// mock 手段:CDP Fetch 域直连扩展 SW target(DevTools 同款机制)。为什么不用
// Playwright 的 context.route:实测它不拦截扩展 SW 主动发起的 organic fetch;
// CDP 的 Fetch.requestPaused 是确定性拦截。见 lib-cdp-mock.mjs。

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { ask, bodyText, injectTestConfig, launchWithCdp, makeChecker, openPanel, waitForRunLog, answerSSE, toolCallSSE } from "./lib-cdp-mock.mjs";
import { zh } from "./lib-i18n.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(__dirname, "..", "dist");
const USER_DATA_DIR = `/tmp/verify-web-search-${Date.now()}`;
const pageFixture = readFileSync(resolve(__dirname, "fixtures", "fetch-page.html"), "utf8");
const gbkFixtureB64 = readFileSync(resolve(__dirname, "fixtures", "fetch-gbk.html")).toString("base64");
const bingFixture = readFileSync(resolve(__dirname, "fixtures", "search-bing.html"), "utf8");
const ddgFixture = readFileSync(resolve(__dirname, "fixtures", "search-ddg.html"), "utf8");

const SEARCH_QUERY = "React 19 新特性";
// 三家 mock 响应(形状对齐各家真实 API)
const TAVILY_OK = {
  results: [
    { title: "React v19 发布说明", url: "https://react.dev/blog/react-19", content: "React 19 带来 Actions 等新特性。" },
    { title: "React 19 升级指南", url: "https://react.dev/guide/upgrading", content: "如何升级到 React 19。" },
    { title: "React 19 新特性速览", url: "https://example.com/react19", content: "概览。" },
  ],
};
const BOCHA_OK = {
  code: 200,
  data: { webPages: { value: [
    { name: "博查搜索结果一", url: "https://example.com/b1", snippet: "片段", summary: "博查摘要一" },
    { name: "博查搜索结果二", url: "https://example.com/b2", snippet: "片段二", summary: "博查摘要二" },
  ] } },
};
const BRAVE_OK = {
  web: { results: [
    { title: "Brave Result One", url: "https://example.com/br1", description: "first" },
    { title: "Brave Result Two", url: "https://example.com/br2", description: "second" },
  ] },
};

// ---- 场景状态(CDP handler 按此分发)----
// 搜索服务 mock 模式:ok=正常 JSON / 429=限流 / hang=挂住(取消场景)
const searchState = { mode: "ok" };
const searchHits = { count: 0 };
/** 免 Key tab 通道:引擎模式(fixture=正常回放 / captcha=风控挑战页)与命中时间戳(节流断言) */
const scrapeMode = { bing: "fixture", ddg: "fixture" };
const scrapeHits = { bing: [], ddg: [] };
/** 最近一次抓取请求快照(URL/语言头),auto 场景断言用 */
let lastScrape = null;
/** 最近一次搜索服务请求快照(URL/方法/鉴权头/请求体),API 场景断言用 */
let lastSearch = null;
/** 本次 run 的工具调用脚本 */
let chain = [];
/** web_search 的调用参数(场景注入 recency/market 等) */
let searchArgs = { query: SEARCH_QUERY };
/** web_fetch 第一跳的 URL 与附加参数 */
let fetchUrl = "https://mock.test/page";
let fetchArgs = {};
/** 最近一次 LLM 请求里是否见到预算截断标记 */
let budgetMarkerSeen = false;
let lastToolNames = [];
let lastSystemPrompt = "";

const { browser, extId, mock } = await launchWithCdp({
  extDir: EXT_DIR,
  userDataDir: USER_DATA_DIR,
  proxy: process.env.VERIFY_PROXY,
});
console.log("✅ 扩展:", extId, process.env.VERIFY_PROXY ? `(代理 ${process.env.VERIFY_PROXY})` : "");

// ---- mock 路由 ----
mock.setRoutes([
  // LLM:按 chain 逐跳发工具调用,chain 走完回终答(引用最后一条工具结果)
  {
    match: (url) => url.includes("/chat/completions"),
    handle: async (ctx) => {
      const body = JSON.parse(ctx.params.request.postData ?? "{}");
      lastToolNames = (body.tools ?? []).map((t) => t.function?.name);
      lastSystemPrompt = body.messages?.[0]?.content ?? "";
      const messages = body.messages ?? [];
      const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
      const done = messages
        .slice(lastUserIdx + 1)
        .flatMap((m) => (m.role === "assistant" ? m.tool_calls ?? [] : []))
        .map((t) => t.function?.name);

      const lastToolMsg = [...messages.slice(lastUserIdx + 1)].reverse().find((m) => m.role === "tool");
      const answer = (text) => answerSSE(ctx, text);
      const toolCall = (name, args) => toolCallSSE(ctx, name, args);

      if (done.length >= chain.length) {
        budgetMarkerSeen = (body.messages ?? []).some(
          (m) => m.role === "tool" && m.content.includes("已因长度限制省略"),
        );
        let text = "无工具结果,直接回答:EMPTY_OK";
        const c = lastToolMsg?.content ?? "";
        if (c.startsWith("Error:")) {
          text = `工具报错,如实回答:ERR_OK:${c.slice(0, 80)}`;
        } else {
          try {
            const parsed = JSON.parse(c);
            if (Array.isArray(parsed.results)) {
              text = `根据搜索结果回答:SEARCH_OK:${parsed.results[0]?.title ?? ""}`;
            } else if (typeof parsed.text === "string") {
              text = `读完网页:FETCH_OK:${parsed.title}`;
            }
          } catch { /* 保持默认文案 */ }
        }
        return answer(text);
      }
      const next = chain[done.length];
      if (next === "web_search") return toolCall("web_search", searchArgs);
      if (next === "web_fetch") {
        let args = { url: fetchUrl, ...fetchArgs };
        if (done[done.length - 1] === "web_fetch") {
          try {
            args = { url: fetchUrl, ...fetchArgs, offset: JSON.parse(lastToolMsg.content).next_offset || undefined };
          } catch { /* 保持从头发起 */ }
        }
        return toolCall("web_fetch", args);
      }
      return answer("未知脚本,直接回答");
    },
  },
  // 免 Key 抓取通道:搜索引擎结果页(bing/ddg),按 scrapeMode 分发
  {
    match: (url) => url.includes("bing.com/search"),
    handle: async (ctx) => {
      scrapeHits.bing.push(Date.now());
      const req = ctx.params.request;
      lastScrape = {
        url: req.url,
        acceptLanguage:
          Object.entries(req.headers ?? {}).find(
            ([k]) => k.toLowerCase() === "accept-language",
          )?.[1] ?? "",
      };
      if (scrapeMode.bing === "403") {
        return ctx.fulfill({ status: 403, body: "forbidden" });
      }
      return ctx.fulfill({
        headers: { "Content-Type": "text/html; charset=utf-8" },
        body: bingFixture,
      });
    },
  },
  {
    match: (url) => url.includes("duckduckgo.com/html"),
    handle: async (ctx) => {
      scrapeHits.ddg.push(Date.now());
      const req = ctx.params.request;
      lastScrape = {
        url: req.url,
        acceptLanguage:
          Object.entries(req.headers ?? {}).find(
            ([k]) => k.toLowerCase() === "accept-language",
          )?.[1] ?? "",
      };
      if (scrapeMode.ddg === "captcha") {
        // tab 通道的风控形态:页面可注入但解析不出条目,由 blockMarkers 识别
        return ctx.fulfill({
          headers: { "Content-Type": "text/html; charset=utf-8" },
          body: "<html><body><div class='anomaly'>Unfortunately, bots use DuckDuckGo too — please complete the captcha to continue.</div></body></html>",
        });
      }
      return ctx.fulfill({
        headers: { "Content-Type": "text/html; charset=utf-8" },
        body: ddgFixture,
      });
    },
  },
  // 搜索服务(三家端点统一拦截,按 host 回对应形状;模式控制 429/hang)
  {
    match: (url) =>
      /api\.tavily\.com\/search|(?:api\.bochaai\.com|api\.bocha\.cn)\/v1\/web-search|api\.search\.brave\.com\/res\/v1\/web\/search/.test(url),
    handle: async (ctx) => {
      searchHits.count += 1;
      const req = ctx.params.request;
      const headers = Object.fromEntries(
        Object.entries(req.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
      );
      lastSearch = {
        url: req.url,
        method: req.method,
        auth: headers.authorization ?? headers["x-subscription-token"] ?? "",
        postData: req.postData ?? "",
      };
      if (searchState.mode === "hang") {
        await ctx.delay(20000); // 远超 15s 超时:验证取消能立即中断在途请求
        return ctx.fulfill({ status: 429, body: "slow" });
      }
      if (searchState.mode === "429") {
        return ctx.fulfill({ status: 429, body: "rate limited" });
      }
      const json = (obj) =>
        ctx.fulfill({ headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });
      if (req.url.includes("bochaai.com") || req.url.includes("bocha.cn")) return json(BOCHA_OK);
      if (req.url.includes("search.brave.com")) return json(BRAVE_OK);
      return json(TAVILY_OK);
    },
  },
  // web_fetch fixture:长文分页页(UTF-8)与 GBK 页
  {
    match: (url) => url.includes("mock.test/page"),
    handle: (ctx) =>
      ctx.fulfill({
        headers: { "Content-Type": "text/html; charset=utf-8" },
        body: pageFixture,
      }),
  },
  {
    match: (url) => url.includes("mock.test/gbk"),
    handle: async (ctx) =>
      ctx.fulfill({
        headers: { "Content-Type": "text/html; charset=gbk" },
        bodyBase64: gbkFixtureB64,
      }),
  },
  // 场景 R:白名单内域 302 重定向到私网(重定向绕行链路)。
  // 私网落点也给 mock 响应 —— 拦截必须发生在「读正文之前」,若实现漏了
  // 复核,正文标记会进上下文,断言即红
  {
    match: (url) => url.includes("mock.test/redir"),
    handle: async (ctx) =>
      ctx.fulfill({
        status: 302,
        headers: { Location: "http://10.0.0.5/private-admin" },
        body: "",
      }),
  },
  {
    match: (url) => url.includes("10.0.0.5"),
    handle: async (ctx) =>
      ctx.fulfill({
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
        body: "<html><head><title>内部系统</title></head><body>INTRANET-MARKER 内网正文</body></html>",
      }),
  },
]);
console.log("✅ mock 路由已注册");

// ---- 面板 + 配置 ----
const sidepanel = await openPanel(browser, extId, { configure: injectTestConfig });

const check = makeChecker();
async function toolLogs(name) {
  const logs = await waitForRunLog(sidepanel,
    (e) => e.tag === "tool" && e.msg.includes(`${name} 完成`), `${name} 完成`);
  return logs.filter((e) => e.tag === "tool" && e.msg.includes(`${name} 完成`));
}
const unesc = (s) => (s ?? "").replaceAll('\\"', '"');
/** 空的服务连接条目(新结构:每家 {baseUrl, apiKey} 各存一格) */
const _svc = (baseUrl = "", apiKey = "") => ({ baseUrl, apiKey });
/** 改搜索配置(storage 直写,SW 每次 run 现读,无需刷新)。
 *  key/地址写入 provider(缺省沿用当前)对应槽位——按服务商各存一格 */
const setSearchCfg = (patch) =>
  sidepanel.evaluate(
    (p) =>
      new Promise((done) =>
        chrome.storage.local.get(["search"], (bag) => {
          const prev = bag.search ?? {};
          const provider = p.provider ?? prev.provider ?? "auto";
          const services = { ...prev.services };
          if (p.apiKey !== undefined || p.baseUrl !== undefined) {
            services[provider] = {
              ...(services[provider] ?? {}),
              ...(p.apiKey !== undefined ? { apiKey: p.apiKey } : {}),
              ...(p.baseUrl !== undefined ? { baseUrl: p.baseUrl } : {}),
            };
          }
          chrome.storage.local.set({ search: { provider, services } }, done);
        }),
      ),
    patch,
  );

// ---- 场景 S0:默认关闭(未注入任何搜索配置)----
console.log("\n===== S0. 默认关闭:web_* 工具不可见 =====");
chain = [];
// biome-ignore lint/complexity/noUselessLoneBlockStatements: 块用于限定场景变量作用域
{
  await ask(sidepanel, "还没开联网时的提问");
  check(lastToolNames.length > 0 && !lastToolNames.includes("web_search") && !lastToolNames.includes("web_fetch"),
    "S0-1 未开启时请求不含 web_* 工具", JSON.stringify(lastToolNames));
  check(lastSystemPrompt.includes("Web search is disabled in this session"),
    "S0-2 系统提示声明联网已关闭", lastSystemPrompt.slice(-120));
}

// 注入联网开关(provider=auto:免 Key 抓取通道;新结构每家一格,evaluate 内联字面量)
await sidepanel.evaluate(() =>
  chrome.storage.local.set({
    webSearch: true,
    search: {
      provider: "auto",
      services: {
        tavily: { baseUrl: "", apiKey: "" },
        bocha: { baseUrl: "", apiKey: "" },
        brave: { baseUrl: "", apiKey: "" },
      },
    },
    // 引擎健康表种子:全部可达且新鲜,SW 启动的真网探测不会重排引擎
    // (测试网络里 ddg/google 实际不可达,若被标 dead 会沉底打乱 A0 断言)
    "webSearch:engineHealth": Object.fromEntries(
      ["ddg", "bing", "google", "baidu"].map((id) => [
        id,
        { reach: "ok", checkedAt: Date.now() },
      ]),
    ),
  }));
await new Promise((r) => setTimeout(r, 200));

// ---- 场景 A0:auto 抓取通道端到端(ddg 优先)----
console.log("\n===== A0. auto 抓取通道(mock DDG fixture)=====");
chain = ["web_search"];
searchArgs = { query: SEARCH_QUERY };
{
  await ask(sidepanel, "免 Key 搜一下 React 19 有什么新特性");
  const logs = await waitForRunLog(sidepanel,
    (e) => e.tag === "search" && e.msg.includes("web_search 完成"), "web_search 完成(auto)");
  const done = logs.find((e) => e.msg.includes("web_search 完成"));
  const data = JSON.parse(done?.data ?? "{}");
  check(data.engine === "ddg" && data.mode === "tab", "A0-1 引擎=ddg 且标记 tab 通道", done?.data);
  const u0 = new URL(lastScrape.url);
  check(
    u0.searchParams.get("q") === SEARCH_QUERY &&
      [...u0.searchParams.keys()].every((k) => k === "q"),
    "A0-2 URL 最小形态:仅带 q(无 count/kl/df 等辅助参数)",
    lastScrape.url,
  );
  // A0-3(断言请求带 Accept-Language 头)已随 SW fetch 通道移除:tab 通道
  // 的请求头是浏览器原生的,Accept-Language 恒在,无断言价值。
  const text = await bodyText(sidepanel);
  check(text.includes("SEARCH_OK:DDG React 19 发布说明"),
    "A0-4 fixture 结果解析回填(uddg 跳转已还原)", text.slice(-300));
}

// ---- 场景 A0b:ddg 风控挑战页 → 兜底 bing ----
console.log("\n===== A0b. 兜底:ddg 风控页 → 冷却 → 切换 bing =====");
scrapeMode.ddg = "captcha";
{
  await ask(sidepanel, "再搜一次(此时 ddg 会弹验证码页)");
  const logs = await waitForRunLog(sidepanel,
    (e) => e.tag === "search" && e.msg.includes("web_search 完成"), "web_search 完成(bing 兜底)");
  const switched = logs.find((e) => e.msg.includes("引擎失败,切换下一个"));
  check(!!switched && (switched.data ?? "").includes("bot-check"), "A0b-1 ddg 风控页被识别并切换", switched?.data);
  const done = logs.find((e) => e.msg.includes("web_search 完成"));
  check((done?.data ?? "").includes('"engine":"bing"'), "A0b-2 兜底引擎=bing", done?.data);
  check((await bodyText(sidepanel)).includes("SEARCH_OK:React v19 发布说明"),
    "A0b-3 bing 结果回填(/ck/a 点击包装还原)", (await bodyText(sidepanel)).slice(-300));
}

// ---- 场景 A0c:风控冷却(ddg 已因风控页进冷却)----
console.log("\n===== A0c. 冷却:被风控的 ddg 被直接跳过 =====");
{
  const ddgHitsBefore = scrapeHits.ddg.length;
  await ask(sidepanel, "冷却期内再搜一次");
  const logs = await waitForRunLog(sidepanel,
    (e) => e.tag === "search" && e.msg.includes("web_search 完成"), "web_search 完成(冷却跳过)");
  const skipped = logs.find((e) => e.msg.includes("引擎冷却中,跳过") && (e.data ?? "").includes("ddg"));
  check(!!skipped, "A0c-1 冷却中的 ddg 被跳过", skipped?.data ?? "未发现跳过日志");
  check(scrapeHits.ddg.length === ddgHitsBefore,
    `A0c-2 冷却期内未向 ddg 发请求(${ddgHitsBefore} → ${scrapeHits.ddg.length})`);
  check(logs.some((e) => (e.data ?? "").includes('"engine":"bing"')), "A0c-3 兜底引擎=bing");
}

// ---- 场景 A0d:同引擎节流 ----
console.log("\n===== A0d. 节流:同引擎请求被拉开间隔 =====");
{
  await sidepanel.evaluate(() => chrome.storage.session.remove("webSearch:engineCooldown"));
  scrapeMode.ddg = "fixture";
  await ask(sidepanel, "节流测试第一搜");
  await waitForRunLog(sidepanel,
    (e) => e.tag === "search" && e.msg.includes("web_search 完成"), "节流第一搜完成");
  const before = scrapeHits.ddg[scrapeHits.ddg.length - 1];
  await ask(sidepanel, "节流测试第二搜");
  await waitForRunLog(sidepanel,
    (e) => e.tag === "search" && e.msg.includes("web_search 完成"), "节流第二搜完成");
  const after = scrapeHits.ddg[scrapeHits.ddg.length - 1];
  const gap = after - before;
  check(gap >= 2300, `A0d 两次 ddg 请求间隔 ${gap}ms(≥2300ms,连发节律被打散)`);
}

// 切到 API 通道:provider=tavily + key(后续 A-D/H 场景;key 写入 tavily 槽位)
await setSearchCfg({ provider: "tavily", apiKey: "tvly-test" });

// ---- 场景 A:Tavily 端到端 + 参数映射 ----
console.log("\n===== A. Tavily 端到端(mock)=====");
chain = ["web_search"];
searchArgs = { query: SEARCH_QUERY, max_results: 3, recency: "week" };
{
  await ask(sidepanel, "搜一下 React 19 有什么新特性");
  await waitForRunLog(sidepanel,
    (e) => e.tag === "search" && e.msg.includes("web_search 完成"), "web_search 完成");
  check(lastSearch?.method === "POST" && lastSearch.url.includes("api.tavily.com/search"),
    "A1 POST 到官方 /search(留空 baseUrl 用默认端点)", lastSearch?.url);
  check(lastSearch.auth === "Bearer tvly-test", "A2 Bearer 鉴权头正确", lastSearch?.auth);
  const body = JSON.parse(lastSearch.postData ?? "{}");
  check(body.query === SEARCH_QUERY && body.max_results === 3 && body.time_range === "week",
    "A3 query/max_results/time_range 映射正确", lastSearch.postData);
  const text = await bodyText(sidepanel);
  check(text.includes(`SEARCH_OK:${TAVILY_OK.results[0].title}`),
    "A4 结果回填模型,终答引用标题", text.slice(-300));
}

// ---- 场景 B:博查(provider 切换 + 字段映射 + 槽位不串 key)----
console.log("\n===== B. 博查端到端(mock)=====");
searchArgs = { query: SEARCH_QUERY, max_results: 2 };
// 博查槽位独立填 key:若实现串槽(旧 bug),这里会带 tavily 的 key 打博查
await setSearchCfg({ provider: "bocha", apiKey: "bocha-test" });
{
  await ask(sidepanel, "用博查再搜一次");
  await waitForRunLog(sidepanel,
    (e) => e.tag === "search" && e.msg.includes("web_search 完成"), "web_search 完成(博查)");
  check(lastSearch.url.includes("/v1/web-search"), "B1 端点=/v1/web-search", lastSearch.url);
  check(lastSearch.auth === "Bearer bocha-test", "B2 Bearer 用博查自己的 key(不串 tavily 的)", lastSearch.auth);
  const body = JSON.parse(lastSearch.postData ?? "{}");
  check(body.count === 2 && body.summary === true && body.freshness === undefined,
    "B3 count/summary 映射正确(无 recency 时无 freshness)", lastSearch.postData);
  const text = await bodyText(sidepanel);
  check(text.includes("SEARCH_OK:博查搜索结果一"),
    "B4 webPages.value 解析(summary 优先于 snippet)", text.slice(-300));
}

// ---- 场景 C:Brave(GET + query 参数 + market 映射)----
console.log("\n===== C. Brave 端到端(mock)=====");
  searchArgs = { query: SEARCH_QUERY, max_results: 2, recency: "day", market: "ja-JP" };
  await setSearchCfg({ provider: "brave", apiKey: "brave-test" });
  {
    await ask(sidepanel, "换 Brave 搜日文市场");
    await waitForRunLog(sidepanel,
      (e) => e.tag === "search" && e.msg.includes("web_search 完成"), "web_search 完成(brave)");
    check(lastSearch.method === "GET" && lastSearch.url.includes("api.search.brave.com/res/v1/web/search"),
      "C1 GET 到 /res/v1/web/search", lastSearch.url);
    check(lastSearch.auth === "brave-test", "C2 X-Subscription-Token 用 Brave 自己的 key(不串)", lastSearch.auth);
    const u = new URL(lastSearch.url);
    check(u.searchParams.get("q") === SEARCH_QUERY && u.searchParams.get("count") === "2",
      "C3 q/count 参数正确", u.href);
    check(u.searchParams.get("freshness") === "pd", "C4 recency=day → freshness=pd", u.href);
    check(u.searchParams.get("search_lang") === "ja" && u.searchParams.get("country") === "jp",
      "C5 market=ja-JP → search_lang/country(小写)", u.href);
    const text = await bodyText(sidepanel);
    check(text.includes("SEARCH_OK:Brave Result One"), "C6 web.results 解析", text.slice(-300));
    // 中文市场:Brave 不接受 "zh",必须是 zh-hans
    searchArgs = { query: SEARCH_QUERY, market: "zh-CN" };
    await ask(sidepanel, "Brave 搜中文市场");
    const uzh = new URL(lastSearch.url);
    check(
      uzh.searchParams.get("search_lang") === "zh-hans" &&
        uzh.searchParams.get("country") === "cn",
      "C7 market=zh-CN → search_lang=zh-hans + country=cn",
      lastSearch.url,
    );
}

// ---- 场景 D:限流冷却(切回 tavily;槽位独立 → 中间切过两家,key 仍在)----
console.log("\n===== D. 限流冷却:429 → 报错回填 → 冷却直报 → 清除恢复 =====");
searchArgs = { query: SEARCH_QUERY };
await setSearchCfg({ provider: "tavily" });
searchState.mode = "429";
chain = ["web_search"];
{
  await ask(sidepanel, "搜索一个会被限流的查询");
  const errLogs = await waitForRunLog(sidepanel,
    (e) => e.tag === "tool" && e.msg.includes("web_search 失败"), "web_search 失败日志");
  const err = errLogs.find((e) => e.tag === "tool");
  check((err?.data ?? "").includes("HTTP 429"), "D1 429 被识别并进入观察", err?.data);
  check((await bodyText(sidepanel)).includes("ERR_OK"), "D2 agent 未被打断,仍给出收尾回答", (await bodyText(sidepanel)).slice(-300));

  // 冷却生效:下一次直接报冷却错误,不再发请求(hits 不增长)
  const hitsBefore = searchHits.count;
  await ask(sidepanel, "冷却期内再搜一次");
  const cdLogs = await waitForRunLog(sidepanel,
    (e) => e.tag === "tool" && e.msg.includes("web_search 失败"), "冷却期失败日志");
  check(searchHits.count === hitsBefore,
    `D3 冷却期内未发请求(hits ${hitsBefore} → ${searchHits.count})`);
  check(cdLogs.some((e) => (e.data ?? "").includes("冷却")),
    "D4 冷却期报错文案可直接转告用户", cdLogs.map((e) => e.data).join(" | ").slice(0, 200));

  // 清冷却 → 恢复正常
  await sidepanel.evaluate(() => chrome.storage.session.remove("webSearch:engineCooldown"));
  searchState.mode = "ok";
  await ask(sidepanel, "冷却已清,再搜一次");
  await waitForRunLog(sidepanel,
    (e) => e.tag === "search" && e.msg.includes("web_search 完成"), "web_search 完成(恢复)");
  check(searchHits.count === hitsBefore + 1, "D5 清除冷却后请求恢复发出");
}

// ---- 场景 H:取消传播 ----
console.log("\n===== H. 取消传播:中止 run 立即中断搜索请求 =====");
searchState.mode = "hang";
chain = ["web_search"];
{
  const input = sidepanel.locator(`textarea[aria-label="${zh.chat.askInput}"]`);
  await input.waitFor({ timeout: 5000 });
  await input.fill("搜索一个会很慢的查询");
  await sidepanel.locator(`button[aria-label="${zh.chat.send}"]`).click();
  await sidepanel.locator(`button[aria-label="${zh.chat.stop}"]`).waitFor({ timeout: 10000 });
  await sidepanel.locator(`button[aria-label="${zh.chat.stop}"]`).click();
  await sidepanel.locator(`button[aria-label="${zh.chat.send}"]`).waitFor({ state: "visible", timeout: 15000 });
  const logs = await waitForRunLog(sidepanel,
    (e) => e.ctx === "bg" && e.tag === "agent" && e.msg.includes("run ended"), "run ended(取消后)");
  const cancelled = logs.find((e) => e.msg.includes("cancel requested"));
  const ended = logs.find((e) => e.msg.includes("run ended"));
  const aborted = logs.find((e) => e.msg.includes("aborted by user"));
  check(!!cancelled && !!ended, "H1 取消请求与 run 退出都在当前 run 窗口内");
  const gap = ended && cancelled ? ended.t - cancelled.t : Infinity;
  check(gap < 5000, `H2 取消到 run 退出 ${gap}ms(< 5s,证明在途请求被立即中断)`);
  check(!!aborted, "H3 agent 静默退出路径生效(aborted by user)");
  const fail = logs.find((e) => e.tag === "tool" && e.msg.includes("web_search 失败"));
  check(!!fail && (fail.data ?? "").includes("cancelled"), "H4 工具侧感知取消", fail?.data);
}
searchState.mode = "ok";

// ---- 场景 E:web_fetch 分页(长文两跳) ----
console.log("\n===== E. web_fetch 分页:next_offset 翻页 =====");
fetchUrl = "https://mock.test/page";
chain = ["web_fetch", "web_fetch"];
{
  await ask(sidepanel, "读一下 https://mock.test/page 这篇文档");
  const fetchDone = await toolLogs("web_fetch");
  if (fetchDone.length < 2) throw new Error(`web_fetch 应有两跳,实际 ${fetchDone.length}`);
  const firstData = unesc(fetchDone[0].data);
  check(firstData.includes("MARKER-HEAD-WORDS"), "E1 第一窗含开头标记", firstData.slice(0, 200));
  check(firstData.includes('"done":false'), "E1 第一窗 done=false(还有下页)", firstData.slice(0, 300));
  check(!firstData.includes("MARKER-MIDDLE-99"), "E2 第一窗不含中段标记(未越窗)");
  const secondData = unesc(fetchDone[1].data);
  check(secondData.includes("MARKER-MIDDLE-99"), "E3 第二窗按 offset 读到中段标记", secondData.slice(0, 200));
  const text = await bodyText(sidepanel);
  check(text.includes("FETCH_OK:GLM 侧栏使用手册"), "E4 终答引用网页标题", text.slice(-300));
  // 来源域白名单:URL 出自用户消息 → 命中 → 全程不弹确认卡(两跳都直抓)
  check(
    (await sidepanel.locator('[role="alertdialog"]').count()) === 0,
    "E5 白名单内抓取不弹确认卡(用户消息 URL 直接入集)",
  );
}

// ---- 场景 E2:GBK 编码页解码 ----
console.log("\n===== E2. web_fetch 字符集:GBK 页解码 =====");
fetchUrl = "https://mock.test/gbk";
chain = ["web_fetch"];
{
  await ask(sidepanel, "读一下内网公告页");
  const first = (await toolLogs("web_fetch"))[0];
  const data = first?.data ?? "";
  check(data.includes("内部系统公告"), "E2-1 GBK 标题正确解码(非乱码)", data.slice(0, 260));
  check(data.includes("MARKER-GBK-OK"), "E2-2 GBK 正文正确解码", data.slice(0, 400));
}

// ---- 场景 F:实网 web_fetch ----
console.log("\n===== F. 实网 web_fetch:example.com =====");
fetchUrl = "https://example.com/";
chain = ["web_fetch"];
{
  await ask(sidepanel, "读一下 https://example.com/ 的内容");
  const first = (await toolLogs("web_fetch"))[0];
  const data = first?.data ?? "";
  // 只认真实内容标志:请求的就是 example.com,URL 本身恒真不起检查作用
  check(data.includes("Example Domain"),
    "F1 实网页面读取成功", data.slice(0, 260));
}

// ---- 场景 R:重定向复核(白名单内域 302 → 私网) ----
console.log("\n===== R. 重定向到私网被拦截 =====");
fetchUrl = "https://mock.test/redir";
fetchArgs = {};
chain = ["web_fetch"];
{
  await ask(sidepanel, "读一下 https://mock.test/redir 这篇文档");
  // 落点是私网:fetchHtml 在读正文前抛模型可读错误 —— 工具日志是「失败」
  const logs = await waitForRunLog(sidepanel,
    (e) => e.tag === "tool" && e.msg.includes("web_fetch 失败"), "web_fetch 重定向拦截");
  const failLog = logs.find((e) => e.msg.includes("web_fetch 失败"));
  const data = failLog?.data ?? "";
  check(data.includes("重定向到了私网地址"), "R1 私网落点被拦,错误回给模型", data.slice(0, 300));
  check(data.includes("10.0.0.5"), "R2 错误带落点地址(用户可决断是否明示抓取)", data.slice(0, 300));
  check(
    !logs.some((e) => e.msg.includes("web_fetch 完成")),
    "R3 正文未读取(无完成日志,内网标记不可能进上下文)",
  );
  const text = await bodyText(sidepanel);
  check(text.includes("FETCH_OK"), "R4 run 正常收口(拒绝是转告不是崩溃)", text.slice(-200));
}

// ---- 场景 J:工具结果预算 ----
console.log("\n===== J. 工具结果预算:超限后截断最旧结果 =====");
fetchUrl = "https://mock.test/page";
fetchArgs = { chars: 20000 };
chain = ["web_fetch", "web_fetch", "web_fetch", "web_fetch"];
{
  await ask(sidepanel, "连着读同一篇长文的多个部分");
  const logs = await waitForRunLog(sidepanel,
    (e) => e.tag === "agent" && e.msg.includes("工具结果超出预算"), "预算截断日志");
  check(!!logs.find((e) => e.msg.includes("工具结果超出预算")), "J1 run 内触发预算截断");
  check(budgetMarkerSeen, "J2 截断标记已进入发给模型的请求(旧结果被替换为省略标记)");
  const text = await bodyText(sidepanel);
  check(text.includes("FETCH_OK:GLM 侧栏使用手册"), "J3 最新结果未被截断,终答正常引用", text.slice(-200));
}

// ---- 场景 G:联网开关 ----
console.log("\n===== G. 联网开关:关→隐藏;开+有key→可见;开+没key→隐藏 =====");
fetchArgs = {};
chain = [];
{
  await sidepanel.evaluate(() => chrome.storage.local.set({ webSearch: false }));
  await ask(sidepanel, "开关关闭后的提问");
  check(lastToolNames.length > 0 && !lastToolNames.includes("web_search") && !lastToolNames.includes("web_fetch"),
    "G1 关闭后请求不含 web_* 工具", JSON.stringify(lastToolNames));
  check(lastToolNames.includes("page_read"), "G2 页面工具保留", JSON.stringify(lastToolNames));
  check(lastSystemPrompt.includes("Web search is disabled in this session"), "G3 系统提示声明联网已关闭", lastSystemPrompt.slice(-120));
  check((await bodyText(sidepanel)).includes("EMPTY_OK"), "G4 agent 正常回答", (await bodyText(sidepanel)).slice(-200));

  await sidepanel.evaluate(() => chrome.storage.local.set({ webSearch: true }));
  chain = ["web_search"];
  await ask(sidepanel, "开关重新打开后的提问");
  check(lastToolNames.includes("web_search") && lastToolNames.includes("web_fetch"),
    "G5 开启后 web_* 工具恢复", JSON.stringify(lastToolNames));
  check(!lastSystemPrompt.includes("Web search is disabled in this session"), "G6 系统提示不再声明关闭", "");
  await waitForRunLog(sidepanel, (e) => e.tag === "search" && e.msg.includes("web_search 完成"),
    "web_search 完成(重新开启)");

  // 选了服务商但该家没填 Key(别家槽位有 key):仍自动退回免 Key 抓取通道
  // —— 只清 tavily 槽位,bocha/brave 的 key 保留,验证按家取槽不误用
  await sidepanel.evaluate(() =>
    new Promise((done) =>
      chrome.storage.local.get(["search"], (bag) => {
        const prev = bag.search ?? { services: {} };
        chrome.storage.local.set(
          {
            search: {
              provider: "tavily",
              services: { ...prev.services, tavily: { baseUrl: "", apiKey: "" } },
            },
          },
          done,
        );
      }),
    ));
  await sidepanel.evaluate(() => chrome.storage.session.remove("webSearch:engineCooldown"));
  scrapeMode.ddg = "fixture";
  chain = ["web_search"];
  await ask(sidepanel, "服务商没填 Key 的提问");
  check(lastToolNames.includes("web_search") && lastToolNames.includes("web_fetch"),
    "G7 该家没填 Key 时工具仍可见(退回 tab 通道)", JSON.stringify(lastToolNames));
  const g7logs = await waitForRunLog(sidepanel,
    (e) => e.tag === "search" && e.msg.includes("web_search 完成"), "G7 完成");
  check(g7logs.some((e) => (e.data ?? "").includes('"engine":"ddg"') && (e.data ?? "").includes('"mode":"tab"')),
    "G8 只认选中槽位:该家无 Key 实际走 tab 通道(别家 key 不顶替)", g7logs[g7logs.length-1]?.data);
}

// ---- 汇总 ----
console.log("\n========================================");
if (check.failures.length > 0) {
  console.log("❌ VERDICT: FAIL —", check.failures.join("; "));
  await browser.close();
  process.exit(1);
}
console.log("✅ VERDICT: PASS");
await browser.close();
process.exit(0);
