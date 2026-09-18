// 验证 page_screenshot 视觉通道与 scroll_page(2026-09-16 P2 截图轮)
// 用法: pnpm build && node tests/verify-screenshot.mjs
//
// 场景:
//   SS1 主链路:视觉模型 + mock LLM 脚本驱动 find_elements → scroll_page →
//      page_screenshot,断言 —— 工具消息的 marks 表/page 几何;截图附件经
//      「紧随带图 user 消息」注入(wire 出现 image_url data:image/jpeg);
//      图片字节落 images store;mock 页面为真实 Chromium 渲染(headful)
//   SS2 门控:非视觉模型 → wire 的 tools 列表不含 page_screenshot
//   SS3 滚动落点:scroll_page 返回几何(scroll_y>0/at_bottom=false),与
//      find_elements/screenshot 的 page 字段联动
//
// 注意:本套件需要 headful 环境(xvfb-run),captureVisibleTab 在无头下不可用。

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  launchWithCdp,
  ask,
  sse,
} from "./lib-cdp-mock.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(__dirname, "..", "dist");
const USER_DATA_DIR = `/tmp/verify-screenshot-profile-${Date.now()}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.error(`  ❌ ${name} ${detail}`);
  }
}

// 目标页:顶部/中部/底部三个按钮(给 SoM 编号)。中部按钮的位置要让
// scroll 2 个视口后正好落在第二个截图的视口里(viewport 900)
const SHOT_HTML = `<html><head><meta charset="utf-8"></head>
<body style="margin:0;font-family:sans-serif">
  <div style="height:80px;padding:8px">
    <button>顶部按钮 Top Button</button>
    <a href="#">顶部链接 Link</a>
  </div>
  <div style="height:1900px">占位 1</div>
  <div style="padding:8px"><button>中部按钮 Mid Button</button></div>
  <div style="height:2400px">占位 2</div>
  <div style="padding:8px"><button>底部按钮 Bottom Button</button></div>
  <div style="height:200px">end</div>
</body></html>`;

const { browser, extId, mock } = await launchWithCdp({
  extDir: EXT_DIR,
  userDataDir: USER_DATA_DIR,
});
console.log("✅ 扩展:", extId);

let lastRequest = null;
/** 当前场景的工具调用脚本(按已完成调用数推进) */
let chain = [];

mock.setRoutes([
  {
    match: (url) => url.includes("mock.test/shot"),
    handle: async (ctx) =>
      ctx.fulfill({
        status: 200,
        headers: { "Content-Type": "text/html" },
        body: SHOT_HTML,
      }),
  },
  {
    // 诱饵页:纯饱和蓝。SS4 用它做「用户正看着的页」——若截图误抓活动 tab,
    // 采到的像素就是蓝色,回归一测便知
    match: (url) => url.includes("mock.test/decoy"),
    handle: async (ctx) =>
      ctx.fulfill({
        status: 200,
        headers: { "Content-Type": "text/html" },
        body: `<html><head><meta charset="utf-8"></head><body style="margin:0;background:#0000ff;height:3000px"></body></html>`,
      }),
  },
  {
    match: (url) => url.includes("/chat/completions"),
    handle: async (ctx) => {
      const body = JSON.parse(ctx.params.request.postData ?? "{}");
      lastRequest = body;
      // 注意:截图附件会以 user 消息注入在 run 中段,不能用
      // 「最后一条 user 之后」做窗口 —— 那会把计数清零导致 chain 重发。
      // 全局数 assistant 的 tool_calls:每轮恰好 +1
      const done = (body.messages ?? [])
        .flatMap((m) => (m.role === "assistant" ? m.tool_calls ?? [] : []))
        .length;
      const fulfill = (sseBody) =>
        ctx.fulfill({
          headers: { "Content-Type": "text/event-stream" },
          body: sseBody,
        });
      if (done >= chain.length) {
        return fulfill(
          sse(
            { choices: [{ delta: { content: "SHOT_OK" } }] },
            { choices: [{ delta: {}, finish_reason: "stop" }] },
          ),
        );
      }
      const next = chain[done];
      return fulfill(
        sse(
          { choices: [{ delta: { tool_calls: [{ index: 0, id: `call-${done}-${Date.now()}`, function: { name: next.name, arguments: JSON.stringify(next.args) } }] } }] },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        ),
      );
    },
  },
]);

const setModels = (page, vision) =>
  page.evaluate((vision) => {
    const bag = {
      providers: [
        {
          id: "p0",
          name: "test",
          baseUrl: "https://api.test.example.com/v1",
          apiKey: "sk-test",
          models: [{ id: "gpt-v", ...(vision ? { vision: true } : {}) }],
        },
      ],
      modelProvider: "p0",
      model: "gpt-v",
    };
    return chrome.storage.local.set(bag);
  }, vision);

const sidepanel = await browser.newPage();
await sidepanel.goto(`chrome-extension://${extId}/sidepanel.html`);
await setModels(sidepanel, true);
await sleep(400);

// 目标页:CDP mock 出的 http(s) 页面(flavor 静态 <all_urls> 授权,权限门通过;
// content script 静态注册,marks/滚动可直接调用)
const target = await browser.newPage();
await target.goto("https://mock.test/shot", { waitUntil: "load" });
await sleep(400);
const targetTabId = await sidepanel.evaluate(
  () =>
    new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) =>
        resolve(tabs[0]?.id ?? -1),
      );
    }),
);
check("目标页已打开且拿到 tabId", targetTabId > 0, `tabId=${targetTabId}`);

const toolMessagesOf = (body) => {
  const messages = body?.messages ?? [];
  // 原始提问 = 最后一条「非系统注记」的 user 消息;工具消息全部在其后。
  // 注意 wire 投影后注记消息的 content 是 parts 数组(文本 + image_url),
  // 要从首个 text part 识别前缀
  const isNote = (m) => {
    if (m.role !== "user") return false;
    if (typeof m.content === "string") return m.content.startsWith("[System note:");
    const first = Array.isArray(m.content) ? m.content[0] : null;
    return first?.type === "text" && String(first.text).startsWith("[System note:");
  };
  let lastRealUser = -1;
  messages.forEach((m, i) => {
    if (m.role === "user" && !isNote(m)) lastRealUser = i;
  });
  return messages.slice(lastRealUser + 1).filter((m) => m.role === "tool");
};

// ---- SS1 主链路 ----
console.log("\nSS1 视觉通道主链路(观察→滚动→截图→带图注入)");
chain = [
  { name: "find_elements", args: { tabId: targetTabId, limit: 10 } },
  { name: "scroll_page", args: { tabId: targetTabId, direction: "down", pages: 2 } },
  { name: "page_screenshot", args: { tabId: targetTabId } },
];
await ask(sidepanel, "看看这个页面长什么样");
{
  check(
    "wire 的 tools 列表含 page_screenshot 与 scroll_page",
    (lastRequest?.tools ?? []).some((t) => t.function?.name === "page_screenshot") &&
      (lastRequest?.tools ?? []).some((t) => t.function?.name === "scroll_page"),
  );
  const tools = toolMessagesOf(lastRequest);
  check("三个工具按脚本顺序执行", tools.length === 3, `n=${tools.length}`);

  const find = JSON.parse(tools[0]?.content ?? "{}");
  check(
    "find_elements 返回页面几何(scroll_y=0,未滚动)",
    find.page?.scroll_y === 0 && find.page?.scroll_height > 3000 && find.page?.at_bottom === false,
    JSON.stringify(find.page),
  );

  const scrolled = JSON.parse(tools[1]?.content ?? "{}");
  check(
    "scroll_page 落点几何(scroll_y>0,at_bottom=false)",
    scrolled.scroll_y > 0 && scrolled.at_bottom === false,
    JSON.stringify(scrolled),
  );

  const shot = JSON.parse(tools[2]?.content ?? "{}");
  check(
    "screenshot 工具消息带 marks 表(n/tag/selector/label)",
    Array.isArray(shot.marks) && shot.marks.length >= 1 &&
      shot.marks.every((m) => m.n >= 1 && typeof m.selector === "string" && typeof m.tag === "string"),
    JSON.stringify(shot.marks)?.slice(0, 120),
  );
  check(
    "screenshot 带捕获尺寸与页面几何(scroll_y>0)",
    shot.viewport?.w > 0 && shot.viewport?.h > 0 && shot.page?.scroll_y > 0,
    JSON.stringify({ viewport: shot.viewport, page: shot.page }),
  );

  // 注入的带图 user 消息:wire 侧应为 parts(文本注记 + image_url)
  const messages = lastRequest?.messages ?? [];
  // projectForRequest 把带图 user 消息投影成 parts;找含 image_url 的最后一条 user
  const users = messages.filter((m) => m.role === "user");
  const partsUser = users.find((m) => Array.isArray(m.content));
  const imgPart = Array.isArray(partsUser?.content)
    ? partsUser.content.find((p) => p.type === "image_url")
    : null;
  check(
    "截图附件注入为带图 user 消息(image_url data:image/jpeg)",
    !!partsUser && !!imgPart && /^data:image\/jpeg;base64,/.test(imgPart.image_url.url),
    partsUser ? String(imgPart?.image_url?.url).slice(0, 40) : "无 parts user",
  );
  check(
    "附件注记文本在图片之前且说明 marks 对应关系",
    Array.isArray(partsUser?.content) &&
      partsUser.content[0]?.type === "text" &&
      partsUser.content[0].text.includes("System note") &&
      partsUser.content[0].text.includes("marks"),
  );
  check(
    "截图真实非空(data URL 超 10KB,排除 1px 空图)",
    (imgPart?.image_url?.url?.length ?? 0) > 10_000,
    `len=${imgPart?.image_url?.url?.length ?? 0}`,
  );

  // 落库:消息行只有元数据,字节进 images store
  const snap = await sidepanel.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const rq = indexedDB.open("tars");
        rq.onsuccess = () => {
          const db = rq.result;
          const tx = db.transaction(["messages", "images"]);
          const m = tx.objectStore("messages").getAll();
          const i = tx.objectStore("images").getAll();
          tx.oncomplete = () => {
            db.close();
            resolve({
              messages: m.result,
              images: i.result.map((r) => ({ ...r, byteLen: r.bytes?.length ?? -1 })),
            });
          };
          tx.onerror = () => reject(tx.error);
        };
        rq.onerror = () => reject(rq.error);
      }),
  );
  const shotUserMsg = snap.messages
    .map((r) => r.msg)
    .find((m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith("[System note:"));
  check(
    "落库消息行只有图片元数据无字节",
    shotUserMsg?.images?.length === 1 && shotUserMsg.images[0].bytes === undefined,
    JSON.stringify(shotUserMsg?.images)?.slice(0, 100),
  );
  check(
    "images store 有截图字节(jpeg)",
    snap.images.length === 1 && snap.images[0].byteLen > 10_000 && snap.images[0].mime === "image/jpeg",
    `n=${snap.images.length} len=${snap.images[0]?.byteLen}`,
  );
}

// ---- SS2 门控 ----
console.log("\nSS2 非视觉模型的工具门控");
await setModels(sidepanel, false);
await sleep(400);
chain = [];
await ask(sidepanel, "换个问法");
{
  const names = (lastRequest?.tools ?? []).map((t) => t.function?.name);
  check(
    "wire 的 tools 不含 page_screenshot",
    !names.includes("page_screenshot"),
    names.join(","),
  );
  check(
    "非视觉门控不影响其它工具(page_read/scroll_page 仍在)",
    names.includes("page_read") && names.includes("scroll_page"),
  );
}

// ---- SS4 目标对齐:目标 ≠ 活动 tab,必须截目标页且截完恢复 ----
console.log("\nSS4 截图目标对齐(激活目标 → 截图 → 恢复活动)");
{
  // 打开诱饵页(新开 tab 即成为活动 tab),用户此刻「看着」蓝色页
  const decoy = await browser.newPage();
  await decoy.goto("https://mock.test/decoy", { waitUntil: "load" });
  await sleep(400);
  const decoyTabId = await sidepanel.evaluate(
    () =>
      new Promise((resolve) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) =>
          resolve(tabs[0]?.id ?? -1),
        );
      }),
  );
  check(
    "诱饵页是当前活动 tab(且不同于截图目标)",
    decoyTabId > 0 && decoyTabId !== targetTabId,
    `decoy=${decoyTabId} target=${targetTabId}`,
  );

  // mock 的调用推进按「全会话累计 assistant tool_calls」计数(SS1 已消耗 3 次),
  // SS4 的脚本要补齐占位才会轮到截图这一拍
  chain = [
    { name: "get_tabs", args: {} },
    { name: "get_tabs", args: {} },
    { name: "get_tabs", args: {} },
    { name: "page_screenshot", args: { tabId: targetTabId } },
  ];
  await ask(sidepanel, "截一下刚才那个页面");

  // 活动 tab 应恢复为诱饵页(截图不该把用户的浏览位置留在目标页)
  const activeNow = await sidepanel.evaluate(
    () =>
      new Promise((resolve) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) =>
          resolve(tabs[0]?.id ?? -1),
        );
      }),
  );
  check("截图后活动 tab 恢复为用户所在页", activeNow === decoyTabId, `active=${activeNow}`);

  // 像素断言:逐张检查 images store 的截图中心像素,任何一张都不该是诱饵蓝
  // (回归前误抓活动 tab → 必有纯蓝帧)。IDB getAll 按主键序返回、与写入
  // 顺序无关,因此全量检查而不是只看「最后一张」
  const pixels = await sidepanel.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const rq = indexedDB.open("tars");
        rq.onsuccess = () => {
          const db = rq.result;
          const tx = db.transaction("images", "readonly");
          const q = tx.objectStore("images").getAll();
          q.onsuccess = async () => {
            db.close();
            try {
              const out = [];
              for (const row of q.result) {
                const blob = new Blob([row.bytes], { type: "image/jpeg" });
                const bmp = await createImageBitmap(blob);
                const canvas = new OffscreenCanvas(1, 1);
                const c2d = canvas.getContext("2d");
                c2d.drawImage(
                  bmp,
                  Math.floor(bmp.width / 2),
                  Math.floor(bmp.height / 2),
                  1,
                  1,
                  0,
                  0,
                  1,
                  1,
                );
                const d = c2d.getImageData(0, 0, 1, 1).data;
                out.push({ r: d[0], g: d[1], b: d[2] });
                bmp.close();
              }
              resolve(out);
            } catch (e) {
              reject(e);
            }
          };
          q.onerror = () => reject(q.error);
        };
        rq.onerror = () => reject(rq.error);
      }),
  );
  const isDecoyBlue = (p) => p.b > 180 && p.r < 120 && p.g < 120;
  check(
    "截图像素来自目标页(无诱饵蓝帧)",
    pixels.length >= 2 && pixels.every((p) => !isDecoyBlue(p)),
    JSON.stringify(pixels),
  );
  await decoy.close();
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
await browser.close();
process.exit(failed > 0 ? 1 : 0);
