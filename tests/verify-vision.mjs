// 验证视觉图片链路(选择图片 → 压缩 → user parts 发送 → 持久化 → 历史回放)
// 用法: pnpm build && node tests/verify-vision.mjs
//
// 场景:
//   V1 门控:模型未勾选「视觉」时贴图 → 面板提示,不产生附件
//   V2 发送:勾选后经文件选择器贴图发送 → 模型请求里 user content 是
//      parts 数组(文本 + image_url data URL)
//   V3 持久化:消息行只存图片元数据(无字节),字节在 images store
//   V4 历史回放:重启面板后从历史切回 → 气泡图片经 GET_IMAGE 取到字节
//   V5 兜底:切回无视觉模型后追问 → 请求里历史图片消息退化为纯文本(不 400)
//
// 粘贴入口与文件选择汇入同一管线(addAttachments),e2e 只驱动文件选择器;
// 粘贴的 preventDefault 逻辑依赖真实剪贴板,不在自动化范围内。

import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  launchWithCdp,
  ask,
  makeChecker,
  openPanel,
  seedProviders,
  sleep,
  sse,
} from "./lib-cdp-mock.mjs";
import { zh } from "./lib-i18n.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(__dirname, "..", "dist");
// 每次跑用全新 profile:V3/V5 的持久化断言按绝对数量计数(sessions/images 的
// 总条数),复用目录会让上一轮的数据混进本轮计数
const USER_DATA_DIR = `/tmp/verify-vision-profile-${Date.now()}`;

const check = makeChecker();

// 1×1 PNG(最小编码):压缩管线要真能解码/重编码,1px 即可
const PNG_PATH = join(tmpdir(), "verify-vision-1px.png");
writeFileSync(
  PNG_PATH,
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

const { browser, extId, mock } = await launchWithCdp({
  extDir: EXT_DIR,
  userDataDir: USER_DATA_DIR,
});

/** 最近一次 LLM 请求体(CDP handler 在 Node 侧执行,直接读变量) */
let lastRequest = null;
mock.setRoutes([
  {
    match: (url) => url.includes("/chat/completions"),
    handle: async (ctx) => {
      lastRequest = JSON.parse(ctx.params.request.postData ?? "{}");
      await ctx.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body: sse(
          { choices: [{ delta: { content: "收到" } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ),
      });
    },
  },
]);

const setModels = (page, vision) =>
  seedProviders(page, [{ id: "gpt-v", ...(vision ? { vision: true } : {}) }]);

/** 等面板真的采用目标视觉档(事件式,替代「赌 storage 变更已传播」的固定 sleep)。
 *  信号:附件钮的 aria-label 恒定,而 title 随 visionOk 翻转(ComposerBar.tsx:242)
 *  —— 面板内存里的配置只有收到 storage 变更事件后才更新,而贴图准入门控读它;
 *  赌输时下一行 setInputFiles 会被门控吞掉(预览永不出现)。
 *  ⚠️ 它**不是** T18 那条 vision V5 flake 的修复:改后 flake 仍复现(11 次里 1 次),
 *  且失败那次本函数已通过 —— 说明提交瞬间面板确实是非视觉档,根因仍未定论。 */
const waitForVision = (page, vision) =>
  page
    .locator(
      `button[aria-label="${zh.chat.addImage}"][title="${
        vision ? zh.chat.addImage : zh.chat.visionOffTitle
      }"]`,
    )
    .waitFor({ timeout: 5000 });

const sidepanel = await openPanel(browser, extId, {
  configure: (p) => setModels(p, false), // V1:先不给 vision
});

// ---- V1 门控 ----
console.log("\nV1 无视觉模型的贴图门控");
{
  const input = sidepanel.locator('input[type="file"]');
  await input.setInputFiles(PNG_PATH);
  const hint = await sidepanel
    .getByText(zh.settings.vision)
    .first()
    .waitFor({ timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  check(hint, "贴图被拦截且给出提示");
  const previews = await sidepanel
    .locator(`img[alt^="${zh.chat.pendingImageAlt.split("{")[0]}"]`)
    .count();
  check(previews === 0, "没有产生附件预览",  `previews=${previews}`);
}

// ---- V2 贴图发送 ----
console.log("\nV2 视觉模型贴图发送(wire 形状)");
await setModels(sidepanel, true);
await sleep(400); // storage 事件 → modelList 更新
{
  const input = sidepanel.locator('input[type="file"]');
  await input.setInputFiles(PNG_PATH);
  await sidepanel
    .locator(`img[alt^="${zh.chat.pendingImageAlt.split("{")[0]}"]`)
    .first()
    .waitFor({ timeout: 5000 });
  const previews = await sidepanel
    .locator(`img[alt^="${zh.chat.pendingImageAlt.split("{")[0]}"]`)
    .count();
  check(previews === 1, "附件预览出现(压缩管线成功)",  `previews=${previews}`);
}
await ask(sidepanel, "这张图是什么");
{
  const userMsg = lastRequest?.messages?.filter((m) => m.role === "user").at(-1);
  const isParts = Array.isArray(userMsg?.content);
  check(isParts, "user content 是 parts 数组",  JSON.stringify(userMsg?.content).slice(0, 120));
  const imgPart = isParts
    ? userMsg.content.find((p) => p.type === "image_url")
    : null;
  check(
    !!imgPart && /^data:image\/(webp|jpeg);base64,/.test(imgPart.image_url.url),
    "包含 image_url part 且为 webp/jpeg data URL",
    imgPart?.image_url?.url?.slice(0, 40),
  );
  check(
    isParts && userMsg.content[0].type === "text" && userMsg.content[0].text.includes("这张图是什么"), "文本 part 在图片之前", 
  );
  check(await sidepanel.getByText("收到").first().isVisible().catch(() => false), "模型有回复");
  // 本地回显气泡的图片必须真能解码:预览 objectURL 交棒给气泡缓存后,待发
  // 清单的清理不能把它撤掉(先撤销、后新建 <img> 的加载必失败,2026-09 审计)
  {
    const bubble = sidepanel
      .locator(`img[alt^="${zh.chat.imageAlt.split("{")[0]}"]`)
      .first();
    await bubble.waitFor({ timeout: 8000 }).catch(() => {});
    let decoded = false;
    for (let i = 0; i < 20 && !decoded; i++) {
      decoded = await bubble
        .evaluate((el) => (el instanceof HTMLImageElement ? el.naturalWidth > 0 : false))
        .catch(() => false);
      if (!decoded) await sleep(100);
    }
    const src = await bubble.getAttribute("src").catch(() => null);
    check(
      decoded, "发送后气泡图片立即解码(预览 URL 未被回收)", 
      `src=${String(src).slice(0, 24)}`, 
    );
  }
}

// ---- V3 持久化 ----
console.log("\nV3 图片持久化(消息行存引用,字节进 images store)");
{
  const snap = await sidepanel.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const rq = indexedDB.open("tars");
        rq.onsuccess = () => {
          const db = rq.result;
          const tx = db.transaction(["sessions", "messages", "images"]);
          const s = tx.objectStore("sessions").getAll();
          const m = tx.objectStore("messages").getAll();
          // 字节长度在库内算好再返回(Uint8Array 无法直接过 evaluate 序列化)
          const i = tx.objectStore("images").getAll();
          tx.oncomplete = () => {
            db.close();
            resolve({
              sessions: s.result,
              messages: m.result,
              images: i.result.map((r) => ({ ...r, byteLen: r.bytes?.length ?? -1 })),
            });
          };
          tx.onerror = () => reject(tx.error);
        };
        rq.onerror = () => reject(rq.error);
      }),
  );
  check(snap.sessions.length === 1 && snap.messages.length === 2, "1 会话 2 消息", 
    `s=${snap.sessions.length} m=${snap.messages.length}`);
  const userMsg = snap.messages.map((r) => r.msg).find((m) => m.role === "user");
  check(
    userMsg?.images?.length === 1 && userMsg.images[0].bytes === undefined &&
      typeof userMsg.images[0].id === "string", "消息行图片只有元数据无字节", 
    JSON.stringify(userMsg?.images), 
  );
  check(
    snap.images.length === 1 && snap.images[0].byteLen > 0, "images store 有字节", 
    `n=${snap.images.length} len=${snap.images[0]?.byteLen}`, 
  );
}

// ---- V5 兜底(先于 V4 做发的第二次请求) ----
// 子场景:视觉开着时贴了图 → 发送前切到非视觉模型。预期:面板提示、
// 图片照常入库、请求里所有图片消息退化纯文本并带系统注
console.log("\nV5 切回无视觉模型后追问(请求侧图片退化)");
await setModels(sidepanel, true);
await waitForVision(sidepanel, true);
await sidepanel.locator('input[type="file"]').setInputFiles(PNG_PATH);
await sidepanel
  .locator(`img[alt^="${zh.chat.pendingImageAlt.split("{")[0]}"]`)
  .first()
  .waitFor({ timeout: 5000 });
await setModels(sidepanel, false);
await waitForVision(sidepanel, false);
// 提示在发送瞬间亮起、3s 后熄灭;ask() 在「状态翻转被 React 批次吞掉」时
// 会等满 10s 才返回(见 ask 内注),到那时提示早已熄灭 —— 本条检查必须
// 手动驱动:点击后立刻轮询捕获,再等 run 收口做请求侧断言
{
  const input = sidepanel.locator(`textarea[aria-label="${zh.chat.askInput}"]`);
  await input.fill("再问一次");
  // T18 预定诊断落地(2026-09-26,接台账「下次复现时做」):点击前挂页内
  // 采样器,按字典文本记录提示 <p> 的出现/消失时刻;下方 check 失败时 dump
  // ——「亮过而 waitFor 没抓到」= 抓取/可见性时机问题;「全程没亮」= 提交
  // 瞬间 pendingImages/visionOk 取值问题,两者修法完全不同。采样器只记录
  // 不等待,控制流仍由 waitFor 驱动(硬规则 3)
  await sidepanel.evaluate((needle) => {
    window.__hintSamples = [];
    window.__hintProbe = setInterval(() => {
      const el = [...document.querySelectorAll("p")].find((p) =>
        p.textContent?.includes(needle),
      );
      window.__hintSamples.push({
        t: Date.now(),
        text: el?.textContent ?? null,
      });
    }, 100);
  }, zh.chat.visionModelFallback);
  await sidepanel.locator(`button[aria-label="${zh.chat.send}"]`).click();
  // 前置条件(面板处于非视觉档)已由 waitForVision 保证;下面的 waitFor 只负责
  // 抓这个 ~3s 的瞬时窗口(框架内部轮询,不手写循环)。断言不删:用户被明确
  // 告知图片不会发送,有产品价值。
  // ⚠️ T18 首条(vision V5 偶发红):已排除两种假设 —— ①手写轮询采样不足
  // (改 waitFor 后仍红);②提交瞬间面板 visionOk 陈旧(waitForVision 已通过
  // 的那次照样红)。失败签名固定:本行红,紧随的三条请求侧断言恒绿。
  // 失败时的现场诊断见上方采样器
  const fallbackHint = sidepanel.getByText(zh.chat.visionModelFallback).first();
  await fallbackHint.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  const hintSeen = (await fallbackHint.count()) > 0;
  const samples = await sidepanel.evaluate(() => {
    clearInterval(window.__hintProbe);
    return window.__hintSamples.filter((s) => s.text);
  });
  if (!hintSeen) {
    if (samples.length === 0) {
      console.log(
        "  🩺 T18 诊断:提示全程未亮 → flashHint 未触发,查提交瞬间 pendingImages/visionOk 取值",
      );
    } else {
      console.log(
        `  🩺 T18 诊断:提示亮过 ${samples.length} 次采样(${new Date(samples[0].t).toISOString()} 起)→ waitFor 未捕获,查抓取/可见性时机`,
      );
    }
  }
  check(hintSeen, "发送时面板提示图片不会发送");
  // 等 run 真正开始(发送钮翻转为停止)再等收口(翻回发送),请求侧断言
  // 才读到本轮的 lastRequest —— 翻转被吞时按 ask() 同款语义吞掉超时
  await sidepanel
    .locator(`button[aria-label="${zh.chat.send}"]`)
    .waitFor({ state: "hidden", timeout: 10000 })
    .catch(() => {});
  await sidepanel
    .locator(`button[aria-label="${zh.chat.send}"]`)
    .waitFor({ state: "visible", timeout: 60000 });
}
{
  const users = lastRequest?.messages?.filter((m) => m.role === "user") ?? [];
  const allString = users.length > 0 && users.every((m) => typeof m.content === "string");
  check(allString, "所有 user 消息都是纯文本(图片被请求侧投影剥离)", 
    JSON.stringify(users.map((m) => Array.isArray(m.content) ? "parts" : "string")));
  check(
    users.filter((m) => m.content.includes("当前模型不支持视觉识别")).length === 2, "被剥离的图片消息带系统注(模型可知情回答)", 
  );
  const imgCount = await sidepanel.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const rq = indexedDB.open("tars");
        rq.onsuccess = () => {
          const db = rq.result;
          const tx = db.transaction("images");
          const c = tx.objectStore("images").count();
          tx.oncomplete = () => {
            db.close();
            resolve(c.result);
          };
          tx.onerror = () => reject(tx.error);
        };
        rq.onerror = () => reject(rq.error);
      }),
  );
  check(imgCount === 2, "非视觉期间发送的图片仍入库(切回后可引用)",  `n=${imgCount}`);
}

// ---- V4 历史回放 ----
console.log("\nV4 面板重开后历史图片回放(GET_IMAGE 通路)");
await sidepanel.reload();
await sleep(600);
await sidepanel.locator(`button[aria-label="${zh.chat.openSessions}"]`).click();
await sleep(300);
await sidepanel.locator("li").first().click();
{
  const img = sidepanel.locator(`img[alt^="${zh.chat.imageAlt.split("{")[0]}"]`);
  await img.first().waitFor({ timeout: 8000 }).catch(() => {});
  const src = await img.first().getAttribute("src").catch(() => null);
  const decoded = await img
    .first()
    .evaluate((el) => (el instanceof HTMLImageElement ? el.naturalWidth > 0 : false))
    .catch(() => false);
  check(!!src && src.startsWith("blob:"), "气泡图片经 GET_IMAGE 取到字节(blob: URL)",  String(src).slice(0, 40));
  check(decoded, "图片真实解码成功(naturalWidth > 0)");
  const bodyText = await sidepanel.evaluate(() => document.body.innerText);
  check(!bodyText.includes("<context>") && !bodyText.includes("user-request"), "回放回显无 context 包裹");
}

console.log(`\n结果: ${check.failures.length} 条断言失败`);
await browser.close();
process.exit(check.failures.length > 0 ? 1 : 0);
