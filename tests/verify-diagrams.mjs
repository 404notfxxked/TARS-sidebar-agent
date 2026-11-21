// 验证图表源码自检回路(D1):最终回答含坏 mermaid → SW 经 offscreen
// diagram_validate 校验出坏块 → 系统注记 user 消息回喂 → 模型第二段重发
// 修正块 → 终态 `.diagram-body svg` 成图;历史投影含两轮 assistant(坏块
// 轮 + 修复轮),回喂的注记行在库(synthetic 投影)。
// D2(tars-img 内嵌引用):先种 images store 字节,回答含 https 外链 +
// 两个相邻 tars-img 引用 → 外链一律不渲染(隐私边界),引用成单个横滑行
// 且图片真解码,点击进放大查看器。
// 用法: pnpm build && node tests/run.mjs diagrams
//   网络受限环境: VERIFY_PROXY=http://127.0.0.1:8118 (mock 全在 CDP 层,一般不需要)

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { answerSSE, ask, idbGetAll, launchWithCdp, loadHistoryViaPort, makeChecker, openPanel, seedProviders, waitForRunLog } from "./lib-cdp-mock.mjs";
import { zh } from "./lib-i18n.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(__dirname, "..", "dist");
const USER_DATA_DIR = `/tmp/verify-diagrams-${Date.now()}`;

// 坏源码:flowchart 拼错(未知图型,mermaid suppressErrors 下 parse 返回 false)
const BROKEN_MD = ["```mermaid", "flowchat TD", "  A --> B", "```"].join("\n");
const FIXED_MD = ["```mermaid", "flowchart TD", "  A --> B", "```"].join("\n");
// D2:第一段纯文本(先建会话,给种子图行挂 sessionId);第二段含一条
// https 外链引用(应被隐私边界拦下)+ 两个相邻 tars-img 引用(成横滑行)
const PREP_MD = "好的,图已备好。";
const IMG_MD = [
  "![远景照片](https://example.com/a.png)",
  "",
  "![一张入库图](tars-img:seed-1)",
  "![另一张入库图](tars-img:seed-2)",
].join("\n");

// 1×1 PNG(最小编码,与 verify-vision 同源):种子图字节必须真能解码
const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// ---- LLM mock:D1 两段式(坏 mermaid→修复)+ D2 两段式(建会话→图引用) ----
const llm = { calls: 0, bodies: [] };

const { browser, extId, mock } = await launchWithCdp({
  extDir: EXT_DIR,
  userDataDir: USER_DATA_DIR,
  proxy: process.env.VERIFY_PROXY,
});
console.log("✅ 扩展:", extId);

mock.setRoutes([
  {
    match: (url) => url.includes("/chat/completions"),
    handle: async (ctx) => {
      const body = JSON.parse(ctx.params.request.postData ?? "{}");
      llm.calls += 1;
      llm.bodies.push(body);
      return answerSSE(
        ctx,
        llm.calls === 1
          ? BROKEN_MD
          : llm.calls === 2
            ? FIXED_MD
            : llm.calls === 3
              ? PREP_MD
              : IMG_MD,
      );
    },
  },
]);
console.log("✅ mock 路由已注册");

// ---- 面板 + 配置 ----
const sidepanel = await openPanel(browser, extId);
await seedProviders(sidepanel, [{ id: "gpt-test" }]);

const check = makeChecker();

console.log("\n===== D1. 坏 mermaid → 回喂 → 修复成图 =====");
{
  await ask(sidepanel, "画个流程图");

  check(llm.calls === 2, `D1-1 两段式:恰好两次模型调用(${llm.calls})`);

  // run 日志出现回喂记录,note 子串([System note: 前缀)进日志 data
  const runLogs = await waitForRunLog(
    sidepanel,
    (e) => e.msg.includes("diagram lint") && (e.data ?? "").includes("[System note:"),
    "diagram lint 回喂日志",
  );
  check(
    runLogs.some((e) => e.msg.includes("feeding fix note back")),
    "D1-2 run 日志含回喂修复指令记录",
  );

  // 修复机制直接证据:第二次请求的 messages 里带上了系统注记(英文修复 note)
  const secondBody = JSON.stringify(llm.bodies[1] ?? {});
  check(
    secondBody.includes("[System note:") && secondBody.includes("Resend ONLY"),
    "D1-3 第二次请求带上了修复 note(只重发指示)",
    secondBody.slice(0, 160),
  );

  // 终态:修正块渲染成图(svg 在场且非零几何 —— 防 DOM 在而视觉不在)
  const svg = sidepanel.locator(".diagram-body svg").first();
  await svg.waitFor({ timeout: 20000 });
  const box = await svg.boundingBox();
  check(
    !!box && box.width > 0 && box.height > 0,
    `D1-4 修复轮 mermaid 成图(${box?.width}×${box?.height})`,
    JSON.stringify(box),
  );

  // 历史投影:两轮 assistant(坏块轮 + 修复轮)+ 回喂注记行(synthetic)
  const sessions = await idbGetAll(sidepanel, "sessions");
  const session = sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
  const history = await loadHistoryViaPort(sidepanel, session.id);
  const assistantRows = history.filter((m) => m.role === "assistant");
  check(
    assistantRows.length === 2,
    `D1-5 历史投影含两轮 assistant(${assistantRows.length})`,
    JSON.stringify(history.map((m) => m.role)),
  );
  check(
    assistantRows[0]?.content?.includes("flowchat TD") === true,
    "D1-6 坏块轮原文保留(虚拟上下文:落盘全量)",
    String(assistantRows[0]?.content).slice(0, 80),
  );
  check(
    assistantRows[1]?.content?.includes("flowchart TD") === true,
    "D1-7 修复轮为修正后的源码",
    String(assistantRows[1]?.content).slice(0, 80),
  );
  const noteRow = history.find(
    (m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith("[System note:"),
  );
  check(
    !!noteRow && noteRow.synthetic === true,
    "D1-8 回喂注记行在投影且标 synthetic(不作真实用户气泡)",
    JSON.stringify(noteRow)?.slice(0, 120),
  );
}

// ---- D2. tars-img 内嵌引用:先种图 → 回答引用 → 横滑行 + 隐私边界 ----
console.log("\n===== D2. tars-img 引用渲染(横滑成组 + 外链拦截)=====");
{
  // 第一问纯文本,只为让会话真实存在(种子图行要挂 sessionId)
  await ask(sidepanel, "准备一下");

  const sessions = await idbGetAll(sidepanel, "sessions");
  const session = sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
  check(!!session, "D2-0 会话已建立", JSON.stringify(sessions.length));

  // 先种图后回答:GET_IMAGE 取不到字节会立即按「失效」收场,顺序不能反。
  // 字节以 base64 过 evaluate,页内解码成 Uint8Array(与 ImageRow 原形一致)
  await sidepanel.evaluate(({ ids, sessionId, b64 }) => {
    return new Promise((resolvePromise, rejectPromise) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const rq = indexedDB.open("tars");
      rq.onsuccess = () => {
        const db = rq.result;
        const tx = db.transaction("images", "readwrite");
        const store = tx.objectStore("images");
        for (const id of ids)
          store.put({ sessionId, id, mime: "image/png", w: 320, h: 240, bytes });
        tx.oncomplete = () => {
          db.close();
          resolvePromise();
        };
        tx.onerror = () => rejectPromise(tx.error);
      };
      rq.onerror = () => rejectPromise(rq.error);
    });
  }, { ids: ["seed-1", "seed-2"], sessionId: session.id, b64: PNG_1PX });

  await ask(sidepanel, "把那两张图贴出来");

  // 隐私边界:https 外链引用不得渲染成 <img>(面板不向第三方图床发请求)
  const remoteImgs = await sidepanel.locator('img[src^="https://"]').count();
  check(remoteImgs === 0, "D2-1 https 外链引用不渲染(隐私边界)", `n=${remoteImgs}`);

  // 相邻两个引用 → 单个横滑行,两张图都在
  const gallery = sidepanel.locator(".media-gallery");
  await gallery.waitFor({ timeout: 15000 });
  const galleryCount = await gallery.count();
  const galleryImgs = await gallery.locator("img").count();
  check(
    galleryCount === 1 && galleryImgs === 2,
    `D2-2 相邻引用成单个横滑行(${galleryCount} 行 / ${galleryImgs} 图)`,
  );

  // 字节真到位:blob URL 且两张都解码(naturalWidth > 0,rAF 轮询等加载)
  const decoded = await sidepanel
    .waitForFunction(
      () => {
        const imgs = [...document.querySelectorAll(".media-gallery img")];
        return (
          imgs.length === 2 &&
          imgs.every(
            (im) =>
              im instanceof HTMLImageElement &&
              im.src.startsWith("blob:") &&
              im.naturalWidth > 0,
          )
        );
      },
      { timeout: 8000 },
    )
    .then(() => true)
    .catch(() => false);
  check(decoded, "D2-3 图片经 GET_IMAGE 取到字节并真实解码");

  // 点击进放大查看器(普通左键;查看器经 portal 挂 body,以角色对话框定位)
  await gallery.locator("img").first().click();
  const viewer = sidepanel.locator(
    `[role="dialog"][aria-label="${zh.chat.media.viewer}"]`,
  );
  await viewer.waitFor({ timeout: 5000 });
  check(await viewer.isVisible(), "D2-4 点击图片进入放大查看器");
  await sidepanel
    .locator(`button[aria-label="${zh.chat.media.close}"]`)
    .click();
  await viewer.waitFor({ state: "hidden", timeout: 5000 });
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
