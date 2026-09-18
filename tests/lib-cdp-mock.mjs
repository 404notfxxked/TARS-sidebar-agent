// Playwright + CDP 的扩展测试底座(verify-* 脚本共用):
// - launchWithCdp():启动 Chromium(加载扩展),并通过 **browser 级 CDP 会话**
//   Target.setAutoAttach(flatten) 自动附加扩展的所有上下文 target(service
//   worker / offscreen document / 页面),在每个扩展 target 上启用 Fetch 域,
//   提供确定性网络拦截。
//   为什么不用 Playwright 的 context.route:实测它拦不到扩展上下文主动发起的
//   organic fetch(尤其 SW / offscreen)。为什么要覆盖多个 target:web_search
//   的引擎请求和 LLM 请求走 SW,web_fetch 的抓取走 offscreen document ——
//   它们是不同 target,Fetch 域要各挂各的。
//   实现说明:autoAttach 在 flatten 模式下,子会话的域名事件(Fetch.*)
//   直接出现在同一条 WebSocket 上,消息带 sessionId 字段;发命令时也带
//   sessionId。新 target(SW 重启、offscreen 懒创建)由 Chrome 主动推送,
//   无需轮询。
// - 路由表:setRoutes([{match(url), handle(ctx)}]),首个 match 生效;
//   ctx 提供 fulfill({status,headers,body|bodyBase64}) / pass() / delay(ms)。
//   未匹配的请求一律放行。注意 handler 不返回时请求会一直挂起。

import { chromium } from "playwright";
import { cpSync, rmSync, readFileSync, existsSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { createHash } from "crypto";
import { zh } from "./lib-i18n.mjs";

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

/** 测试配置的默认模型端点 origin(zero flavor 只授权它,LLM mock 可达) */
export const TEST_ENDPOINT_ORIGIN = "https://api.test.example.com";

/**
 * E2E manifest flavor:生产 manifest 已把站点授权改为 optional(安装零警告),
 * 而 chrome.permissions.request 的授权弹窗是原生对话框,自动化无法确认
 * (实测:CDP userGesture 也不行;Secure Preferences 种子会被 MAC 校验重置
 * —— 覆盖范围见 tests/README「e2e 不覆盖什么」)。按套件选形态:
 * - granted(缺省):静态全站授权 + 静态 content script,既有套件的形态;
 * - zero:只授权模型端点域,页面工具/搜索通道/web_fetch 全部未授权 ——
 *   验证拒绝路径的可行动指引(verify-host-access);
 * - dynamic:静态全站授权但无静态 content script —— 生产唯一的注入路径
 *   (sendMessage 失败 → executeScript → 重试)在授权态下被真实执行。
 * 权限门代码不含测试分叉 —— chrome.permissions.contains 对静态授权同样
 * 返回 true,生产与测试走同一条判定路径,只差授权的「来源」。
 * 路径必须确定性(按 extDir+flavor 哈希,非每次随机):未打包扩展 ID = 路径
 * 哈希,verify-persist 等套件跨浏览器重启对比存储,路径一变 ID 就变,存储
 * 全丢。并行跑多个套件会共享同一 flavor 目录,请按 run.mjs 约定串行执行。
 */
const FLAVORS = {
  granted: {
    hostPermissions: ["<all_urls>"],
    contentScripts: [
      { matches: ["<all_urls>"], js: ["content.js"], run_at: "document_idle", all_frames: false },
    ],
  },
  zero: { hostPermissions: [`${TEST_ENDPOINT_ORIGIN}/*`], contentScripts: [] },
  dynamic: { hostPermissions: ["<all_urls>"], contentScripts: [] },
};

function prepareTestExtension(extDir, flavor = "granted") {
  const shape = FLAVORS[flavor] ?? FLAVORS.granted;
  const hash = createHash("sha256").update(`${resolve(extDir)}:${flavor}`).digest("hex").slice(0, 12);
  const dir = resolve(tmpdir(), `tars-e2e-ext-${hash}`);
  rmSync(dir, { recursive: true, force: true });
  cpSync(extDir, dir, { recursive: true });
  const manifestPath = resolve(dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.host_permissions = shape.hostPermissions;
  if (shape.contentScripts.length > 0) {
    manifest.content_scripts = shape.contentScripts;
  } else {
    delete manifest.content_scripts;
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

export async function launchWithCdp({ extDir, userDataDir, proxy, flavor = "granted" } = {}) {
  extDir = prepareTestExtension(extDir, flavor);
  const args = [
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
    "--remote-debugging-port=0",
  ];
  // 网络受限环境下可给浏览器挂代理(mock 请求在 CDP 层拦截,不受代理影响)
  if (proxy) args.push(`--proxy-server=${proxy}`);

  const browser = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args,
    viewport: { width: 1400, height: 900 },
  });

  // 等 SW 启动并取扩展 ID:先查已起的,没有则事件驱动等待。固定 sleep 在
  // 慢机 / CI xvfb 下会竞态抛「找不到扩展 ID」(2026-09 评审定位的单点 flake)
  const known = browser
    .serviceWorkers()
    .find((sw) => /chrome-extension:\/\//.test(sw.url()));
  const sw = known ?? (await browser.waitForEvent("serviceworker", { timeout: 15_000 }));
  const extId = sw.url().match(/chrome-extension:\/\/([^/]+)\//)?.[1];
  if (!extId) throw new Error("找不到扩展 ID");

  // ---- browser 级 CDP:autoAttach 所有 target,扩展 target 上启用 Fetch ----
  const routes = [];

  // DevToolsActivePort 由 Chrome 在调试端口就绪时写出,launch 返回后通常
  // 已在,慢机上偶发晚写 → 轮询等它,不盲抛也不固定 sleep
  const portFile = resolve(userDataDir, "DevToolsActivePort");
  const portDeadline = Date.now() + 10_000;
  while (!existsSync(portFile)) {
    if (Date.now() > portDeadline) throw new Error("DevToolsActivePort 不存在");
    await new Promise((r) => setTimeout(r, 100));
  }
  const port = parseInt(readFileSync(portFile, "utf8").split("\n")[0], 10);
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();

  let msgId = 0;
  const pending = new Map();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolvePromise, reject) => {
    ws.onopen = resolvePromise;
    ws.onerror = () => reject(new Error("CDP WebSocket 连接失败"));
    ws.onmessage = (ev) => onMessage(ev.data);
    ws.onclose = () => console.error("[cdp-mock] browser CDP 连接关闭");
  });

  function send(method, params = {}, sessionId) {
    return new Promise((resolvePromise, reject) => {
      const id = ++msgId;
      pending.set(id, { resolvePromise, reject });
      ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }

  function onMessage(raw) {
    const msg = JSON.parse(raw);
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        else p.resolvePromise(msg.result);
      }
      return;
    }
    switch (msg.method) {
      case "Target.attachedToTarget": {
        const { sessionId, targetInfo } = msg.params;
        if (process.env.CDP_DEBUG) {
          console.log(`[cdp-mock] attach 事件: ${targetInfo.type} ${targetInfo.url.slice(0, 60)}`);
        }
        const isExt = targetInfo.url.includes(extId);
        const isWeb = ["service_worker", "background_page", "page", "iframe", "webview"].includes(targetInfo.type);
        if (!isExt || !isWeb) return;
        send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, sessionId)
          .then(() => console.log(`[cdp-mock] 已挂载 ${targetInfo.type} ${targetInfo.url.slice(0, 60)}`))
          .catch((e) => console.error(`[cdp-mock] Fetch.enable 失败(${targetInfo.type}):`, e.message));
        return;
      }
      case "Fetch.requestPaused":
        void handlePaused(msg.params, (m, p) => send(m, p, msg.sessionId)).catch((e) =>
          console.error("[cdp-mock] handler error:", e.message),
        );
        return;
    }
  }

  async function handlePaused(params, sendFn) {
    const url = params.request.url;
    for (const route of routes) {
      if (!route.match(url)) continue;
      const ctx = {
        params,
        // body 传文本(内部转 base64);二进制内容传 bodyBase64
        fulfill: ({ status = 200, headers = {}, body, bodyBase64 } = {}) =>
          sendFn("Fetch.fulfillRequest", {
            requestId: params.requestId,
            responseCode: status,
            responseHeaders: Object.entries(headers).map(([name, value]) => ({ name, value })),
            ...(bodyBase64 !== undefined
              ? { body: bodyBase64 }
              : body !== undefined
                ? { body: b64(body) }
                : {}),
          }),
        pass: () => sendFn("Fetch.continueRequest", { requestId: params.requestId }),
        // 网络层失败注入(TCP 断连/DNS 失败形态):请求根本拿不到响应,
        // 客户端走 fetch reject 路径(区别于 fulfill 的 HTTP 状态码)
        failNetwork: () =>
          sendFn("Fetch.failRequest", {
            requestId: params.requestId,
            errorReason: "Failed", // i18n-ok CDP 协议常量(Fetch.failRequest 枚举值),非 UI 文案
          }),
        delay: (ms) => new Promise((r) => setTimeout(r, ms)),
      };
      try {
        await route.handle(ctx);
      } catch (e) {
        // 典型场景:delay 期间发起方 abort(取消测试),fulfill 落在已废弃的请求上
        console.error(`[cdp-mock] route error (${url.slice(0, 80)}):`, e.message);
        await ctx.pass().catch(() => {});
      }
      return;
    }
    await sendFn("Fetch.continueRequest", { requestId: params.requestId }).catch(() => {});
  }

  /** Playwright 路由适配:把 route.request() 包成与 CDP ctx 同形的对象,
   *  复用同一条路由表。tab 页面的导航请求走这里(deterministic)。 */
  async function handlePwRoute(route) {
    const req = route.request();
    const url = req.url();
    if (process.env.CDP_DEBUG) console.log(`[cdp-mock] pw request: ${req.method()} ${url.slice(0, 100)}`);
    for (const entry of routes) {
      if (!entry.match(url)) continue;
      const ctx = {
        params: {
          request: {
            url,
            method: req.method(),
            headers: req.headers(),
            postData: req.postData() ?? "",
          },
        },
        fulfill: ({ status = 200, headers = {}, body, bodyBase64 } = {}) =>
          route.fulfill({
            status,
            headers,
            ...(bodyBase64 !== undefined
              ? { body: Buffer.from(bodyBase64, "base64") }
              : body !== undefined
                ? { body }
                : {}),
          }),
        pass: () => route.continue(),
        delay: (ms) => new Promise((r) => setTimeout(r, ms)),
      };
      try {
        await entry.handle(ctx);
      } catch (e) {
        // 典型场景:delay 期间发起方 abort,fulfill/continue 落在已废弃的请求上
        console.error(`[cdp-mock] pw route error (${url.slice(0, 80)}):`, e.message);
        await ctx.pass().catch(() => {});
      }
      return;
    }
    await route.continue().catch(() => {});
  }

  /**
   * offscreen document(browser 级 autoAttach 不覆盖它)走 Playwright 通道:
   * Playwright 把它暴露为 backgroundPage,可直接 newCDPSession。
   */
  async function attachPlaywrightPage(page) {
    if (!page.url().includes(extId)) return;
    try {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
      cdp.on("Fetch.requestPaused", (params) =>
        void handlePaused(params, (m, p) => cdp.send(m, p)).catch((e) =>
          console.error("[cdp-mock] handler error:", e.message),
        ),
      );
      console.log(`[cdp-mock] 已挂载(Playwright) ${page.url().slice(0, 60)}`);
    } catch (e) {
      console.error(`[cdp-mock] Playwright 挂载失败 ${page.url().slice(0, 60)}:`, e.message);
    }
  }

  await send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });
  // 页面请求(搜索 tab / 面板页,含未来创建的页面)走 Playwright 路由:
  // context.route 对后建页面同样生效且无 attach 竞态——tab 搜索的首航请求
  // 由此确定性拦截。SW / offscreen 的 organic fetch Playwright 拦不到
  // (见头注释),仍由上面的 CDP Fetch 会话负责。只挂 http(s),
  // chrome-extension:// 资源不受影响。
  await browser.route(/^https?:/, (route) => {
    void handlePwRoute(route).catch((e) =>
      console.error("[cdp-mock] pw route error:", e.message),
    );
  });
  // offscreen(document)的 Playwright 通道:初始化枚举 + 新建监听
  for (const bp of browser.backgroundPages()) void attachPlaywrightPage(bp);
  browser.on("backgroundpage", (bp) => void attachPlaywrightPage(bp));
  console.log("✅ CDP Fetch 拦截已就绪(autoAttach SW + Playwright 挂载 offscreen)");

  return {
    browser,
    extId,
    /** 原始 browser 级 CDP 命令(Target.getTargets/closeTarget 等场景用) */
    cdpSend: send,
    mock: {
      setRoutes: (r) => {
        routes.length = 0;
        routes.push(...r);
      },
    },
  };
}

/** 注入测试配置(假 Key + 指定 baseUrl);sidepanel 页面上执行 */
export async function injectTestConfig(page, baseUrl = "https://api.test.example.com/v1") {
  await page.evaluate(
    (url) =>
      chrome.storage.local.set({
        apiKey: "sk-test",
        model: "gpt-test",
        baseUrl: url,
        models: [{ id: "gpt-test" }],
      }),
    baseUrl,
  );
}

/** 读取扩展环形日志(log:bg / log:panel / log:off),只取 since 之后的条目 */
export async function readLogs(page, since) {
  const bag = await page.evaluate(() => chrome.storage.local.get(null));
  const out = [];
  for (const key of ["log:bg", "log:panel", "log:off"]) {
    for (const e of bag[key] ?? []) {
      if (e?.t >= since) out.push(e);
    }
  }
  out.sort((a, b) => a.t - b.t || a.seq - b.seq);
  return out;
}

/**
 * 读取「当前 run」的日志:以最后一次 [bg/agent] run started 为界。
 * 断言一律基于 run 窗口而不是 since 时间戳 —— run 之间可能只隔几百毫秒,
 * 按时间戳切窗会把上一个 run 的完成日志错算进下一个 run。
 */
export async function readRunLogs(page) {
  const all = await readLogs(page, 0);
  const starts = all.filter((e) => e.ctx === "bg" && e.tag === "agent" && e.msg === "run started");
  const last = starts[starts.length - 1];
  if (!last) return [];
  return all.filter((e) => e.t >= last.t);
}

/** 轮询等待「当前 run」的日志满足条件,返回当前 run 的全部日志;超时抛错并转储 */
export async function waitForRunLog(page, predicate, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runLogs = await readRunLogs(page);
    const hits = runLogs.filter(predicate);
    if (hits.length > 0) return runLogs;
    await new Promise((r) => setTimeout(r, 300));
  }
  const runLogs = await readRunLogs(page);
  throw new Error(
    `等待日志超时: ${label}\n当前 run 日志:\n` +
      runLogs.map((e) => `  [${e.ctx}/${e.tag}] ${e.msg} ${(e.data ?? "").slice(0, 120)}`).join("\n"),
  );
}

/** 发一条用户消息并等本轮 run 结束(发送按钮恢复 = idle) */
export async function ask(sidepanel, text) {
  const since = Date.now() - 500;
  const input = sidepanel.locator(`textarea[aria-label="${zh.chat.askInput}"]`);
  await input.waitFor({ timeout: 5000 });
  await input.fill(text);
  const sendBtn = sidepanel.locator(`button[aria-label="${zh.chat.send}"]`);
  await sendBtn.click();
  // 两段式 idle 判定,不能直接等 send visible:点击瞬间它就是 visible,
  // 会赶在按钮翻转成 stop 之前通过。先等 send 消失(翻转发生);极快跑完
  // 的 run 可能被 React 渲染批次吞掉翻转,超时吞掉即可,下面的可见等待照常通过
  await sendBtn.waitFor({ state: "hidden", timeout: 10000 }).catch(() => {});
  await sendBtn.waitFor({ state: "visible", timeout: 60000 });
  return since;
}

/** SSE 编码一组 OpenAI 兼容流式帧 */
export const sse = (...frames) =>
  `${frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("")}data: [DONE]\n\n`;

/** 给页面切深浅色(直接改 data-theme,不走设置页) */
export async function setTheme(page, theme) {
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);
}

/**
 * 直写 IndexedDB 种长期记忆(rows: [text, pinned] 元组数组),含建库/建
 * memories store;先清后种,空数组即清空(视觉/边缘态探针共用)。
 */
export async function seedMemories(page, rows) {
  await page.evaluate((list) => {
    const now = Date.now();
    return new Promise((resolvePromise, reject) => {
      const rq = indexedDB.open("tars");
      rq.onupgradeneeded = () => {
        const db = rq.result;
        for (const n of ["sessions", "memories"])
          if (!db.objectStoreNames.contains(n))
            db.createObjectStore(n, { keyPath: "id" });
        if (!db.objectStoreNames.contains("messages"))
          db.createObjectStore("messages", { keyPath: ["sessionId", "seq"] });
      };
      rq.onsuccess = () => {
        const db = rq.result;
        const tx = db.transaction("memories", "readwrite");
        const s = tx.objectStore("memories");
        s.clear();
        list.forEach(([text, pinned], i) => {
          s.put({
            id: `m-${i}`,
            text,
            createdAt: now - (i + 1) * 3600e3,
            updatedAt: now - (i + 1) * 3600e3,
            pinned,
            source: i % 4 === 0 ? "user" : "model",
          });
        });
        tx.oncomplete = () => {
          db.close();
          resolvePromise();
        };
        tx.onerror = () => reject(tx.error);
      };
      rq.onerror = () => reject(rq.error);
    });
  }, rows);
}

/**
 * 直写 IndexedDB 种历史会话(rows: {id,title,at,user?,assistant?}),
 * 每条会话写一问一答两条消息(user 缺省用 title);视觉/布局探针共用。
 */
export async function seedSessions(page, rows) {
  await page.evaluate((list) => {
    return new Promise((resolve, reject) => {
      const rq = indexedDB.open("tars");
      rq.onupgradeneeded = () => {
        const db = rq.result;
        db.createObjectStore("sessions", { keyPath: "id" });
        db.createObjectStore("messages", { keyPath: ["sessionId", "seq"] });
      };
      rq.onsuccess = () => {
        const db = rq.result;
        const tx = db.transaction(["sessions", "messages"], "readwrite");
        const sStore = tx.objectStore("sessions");
        const mStore = tx.objectStore("messages");
        for (const r of list) {
          sStore.put({
            id: r.id,
            title: r.title,
            createdAt: r.at,
            updatedAt: r.at,
            msgCount: 2,
          });
          mStore.put({
            sessionId: r.id,
            seq: 0,
            msg: { role: "user", content: r.user ?? r.title },
          });
          mStore.put({
            sessionId: r.id,
            seq: 1,
            msg: { role: "assistant", content: r.assistant ?? "好的,已完成。" },
          });
        }
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      rq.onerror = () => reject(rq.error);
    });
  }, rows);
}

/**
 * 断言助手工厂:check(ok,label,detail) 累积 failures,套件末尾统一判退出码。
 * 各 verify-* 的近逐字重复实现收敛于此(2026-09 评审 T10)。
 * 未统一:verify-persist/verify-vision 的 check(name,cond) 参数序相反。
 */
export function makeChecker() {
  const failures = [];
  const check = (ok, label, detail = "") => {
    console.log(ok ? "✅" : "❌", label, ok ? "" : `\n   ${detail}`);
    if (!ok) failures.push(label);
    return ok;
  };
  check.failures = failures;
  return check;
}

/**
 * 裸 port 发消息并等本轮 run 结束(不经 UI;多场景聚合的套件共用)。
 * autoConfirm:自动应答写操作确认门(2026-09 起记忆工具也过门)——
 * 走 UI 断言确认卡交互的套件不要开,走「门后链路」的套件开它穿过。
 */
export function runAskViaPort(page, sessionId, text, { autoConfirm = false } = {}) {
  return page.evaluate(
    ({ sessionId, text, autoConfirm }) =>
      new Promise((resolve, reject) => {
        const port = chrome.runtime.connect({ name: "agent-port" });
        const timer = setTimeout(() => reject(new Error("run 超时")), 60000);
        port.onMessage.addListener((msg) => {
          if (autoConfirm && msg.type === "agent_confirm_request") {
            port.postMessage({
              type: "confirm_response",
              requestId: msg.requestId,
              approved: true,
            });
            return;
          }
          if (msg.type === "agent_done" || msg.type === "agent_error") {
            clearTimeout(timer);
            port.disconnect();
            resolve(msg);
          }
        });
        port.postMessage({ type: "user_message", payload: { text, sessionId } });
      }),
    { sessionId, text, autoConfirm },
  );
}

/** 读 tars 库某 store 全部行(断言落库用);store 不存在会抛,种子先行 */
export function idbGetAll(page, store) {
  return page.evaluate(
    (store) =>
      new Promise((done, fail) => {
        const req = indexedDB.open("tars");
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(store, "readonly");
          const q = tx.objectStore(store).getAll();
          q.onsuccess = () => {
            db.close();
            done(q.result);
          };
          q.onerror = () => fail(q.error);
        };
        req.onerror = () => fail(req.error);
      }),
    store,
  );
}

/** 读 tars 库某 store 单行(按键) */
export function idbGet(page, store, key) {
  return page.evaluate(
    ({ store, key }) =>
      new Promise((done, fail) => {
        const req = indexedDB.open("tars");
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(store, "readonly");
          const q = tx.objectStore(store).get(key);
          q.onsuccess = () => {
            db.close();
            done(q.result);
          };
          q.onerror = () => fail(q.error);
        };
        req.onerror = () => fail(req.error);
      }),
    { store, key },
  );
}

/** LLM 端点 SSE 应答:一条纯文本回答 + 指定 finish_reason(默认 stop) */
export const answerSSE = (ctx, text, { finish = "stop" } = {}) =>
  ctx.fulfill({
    headers: { "Content-Type": "text/event-stream" },
    body: sse(
      { choices: [{ delta: { content: text } }] },
      { choices: [{ delta: {}, finish_reason: finish }] },
    ),
  });

/** LLM 端点 SSE 应答:一次工具调用(随机 call id)+ tool_calls 收尾 */
export const toolCallSSE = (ctx, name, args) =>
  ctx.fulfill({
    headers: { "Content-Type": "text/event-stream" },
    body: sse(
      {
        choices: [
          {
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  id: `call_${Math.random().toString(36).slice(2, 8)}`,
                  type: "function",
                  function: { name, arguments: JSON.stringify(args) },
                },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ),
  });
