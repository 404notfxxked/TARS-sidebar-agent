// 图表视觉留档(非断言型,shot-m3 同族:截图人看 + 少量健康检查):
// 复杂 mermaid 在窄面板的成图/横滚、放大查看器(缩放后)、echarts 统计图
// 成图与快照查看器(data: URL 新标签页出口)、坏源码回退态、深浅两主题、
// 窄面板 ResizeObserver 跟随。等待一律事件驱动(waitFor/locator.waitFor),
// 不进固定等待基线。
// 用法: pnpm build && node tests/shot-diagram.mjs

import { mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { launchWithCdp, setTheme, answerSSE } from "./lib-cdp-mock.mjs";
import { zh } from "./lib-i18n.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(__dirname, "..", "dist");
const USER_DATA_DIR = "/tmp/probe-diagram-profile";
const OUT_DIR = "/tmp/tars-m3";

mkdirSync(OUT_DIR, { recursive: true });

const ok = (cond, label) => {
  if (!cond) throw new Error(`❌ ${label}`);
  console.log(`  ✅ ${label}`);
};

/** 复杂架构图(宽、含 subgraph——查看器塌 0×0 的真实复现形态) */
const GOOD_MD = [
  "整体架构如下:",
  "",
  "```mermaid",
  "flowchart LR",
  "  subgraph Client",
  "    UI[界面组件] --> ST[状态管理]",
  "    ST --> API_CL[API 客户端]",
  "  end",
  "  subgraph Gateway",
  "    LB[负载均衡] --> AUTH[鉴权]",
  "    AUTH --> RATE[限流]",
  "  end",
  "  subgraph Services",
  "    SVC_A[订单服务] --> DB_A[(订单库)]",
  "    SVC_B[商品服务] --> DB_B[(商品库)]",
  "    SVC_C[搜索服务] --> ES[(索引)]",
  "  end",
  "  subgraph Observe",
  "    LOG[日志收集] --> MET[指标聚合]",
  "    MET --> ALERT[告警]",
  "  end",
  "  API_CL --> LB",
  "  RATE --> SVC_A",
  "  RATE --> SVC_B",
  "  RATE --> SVC_C",
  "  SVC_A --> LOG",
  "  SVC_C --> MET",
  "```",
  "",
  "各链路量级如下:",
  "",
  "```echarts",
  '{"legend":{},"xAxis":{"type":"category","data":["Q1","Q2","Q3","Q4"]},"yAxis":{},"series":[{"name":"订单","type":"bar","data":[120,200,150,80]},{"name":"渠道","type":"bar","data":[90,140,110,60]},{"name":"直销","type":"bar","data":[70,110,160,130]}]}',
  "```",
  "",
  "网关统一收口,观测面挂在服务侧。",
].join("\n");

/** 坏源码(flowchart 拼错)→ 回退源码态 + 静置后失败注记 */
const BROKEN_MD = ["```mermaid", "flowchat TD", "  A --> B", "```"].join("\n");

let scriptNo = 0;
const { browser, extId, mock } = await launchWithCdp({
  extDir: EXT_DIR,
  userDataDir: USER_DATA_DIR,
});
console.log("✅ 扩展:", extId);

mock.setRoutes([
  {
    match: (url) => /api\.test\.example\.com/.test(url),
    handle: async (ctx) => {
      scriptNo += 1;
      return answerSSE(ctx, scriptNo === 1 ? GOOD_MD : BROKEN_MD);
    },
  },
]);

const page = await browser.newPage({ deviceScaleFactor: 2 });
await page.setViewportSize({ width: 420, height: 740 });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") pageErrors.push(`console: ${m.text()}`);
});
await page.goto(`chrome-extension://${extId}/sidepanel.html`);
await page.evaluate(() =>
  chrome.storage.local.set({
    apiKey: "sk-test",
    model: "deepseek-chat",
    baseUrl: "https://api.test.example.com/v1",
    theme: "light",
  }),
);
await page.reload();

const input = page.locator(`textarea[aria-label="${zh.chat.askInput}"]`);
const send = page.locator(`button[aria-label="${zh.chat.send}"]`);
const shot = (name) => page.screenshot({ path: `${OUT_DIR}/diagram-${name}.png` });

/** 等 echarts 柱体真正画上:setOption 后有 ~1s 入场动画,canvas 底色已变
 *  不代表柱已画;取中部一行像素找「不透明且有色度」的着色(深底与网格线
 *  都是无/低色度,彩色柱远超阈值) */
const waitBars = () =>
  page.waitForFunction(
    () => {
      const c = document.querySelector(".diagram-echarts-body canvas");
      const ctx = c?.getContext("2d");
      if (!c || !ctx) return false;
      const d = ctx.getImageData(
        0,
        Math.round(c.height * 0.5),
        Math.round(c.width),
        1,
      ).data;
      for (let i = 0; i < d.length; i += 4) {
        const span = Math.max(d[i], d[i + 1], d[i + 2]) -
          Math.min(d[i], d[i + 1], d[i + 2]);
        if (d[i + 3] > 0 && span > 60) return true;
      }
      return false;
    },
    undefined,
    { timeout: 15000 },
  );

// ① 复杂图成图(浅色)
await input.fill("画一张读取链路的流程图");
await send.click();
await page.locator(".diagram-body svg").first().waitFor({ timeout: 20000 });
await send.waitFor({ state: "visible", timeout: 30000 });
await shot("1-flow-light");
ok(true, "复杂流程图成图(浅色)");

// ①b echarts 统计图成图:canvas 在场且有形,柱体动画结束后留档
await page
  .locator(".diagram-echarts-body canvas")
  .first()
  .waitFor({ timeout: 20000 });
await waitBars();
const cbox = await page.evaluate(() => {
  const r = document
    .querySelector(".diagram-echarts-body canvas")
    ?.getBoundingClientRect();
  return r ? { w: Math.round(r.width), h: Math.round(r.height) } : null;
});
ok(cbox !== null && cbox.w > 0, `echarts canvas 有形(${cbox?.w}×${cbox?.h})`);
await shot("1b-echarts-light");

// ①c echarts 快照查看器与 data: URL 新标签页出口(Chrome 拦 data: 顶层
// 导航,须先转 objectURL——MediaViewer 侧适配)
await page.locator("figure:has(.diagram-echarts-body) .diagram-btn").click();
await page.locator('[role="dialog"]').waitFor({ timeout: 5000 });
const isnap = await page.evaluate(() => {
  const img = document.querySelector(".media-stage img");
  const r = img?.getBoundingClientRect();
  return {
    head: img instanceof HTMLImageElement ? img.src.slice(0, 14) : null,
    w: r ? Math.round(r.width) : 0,
  };
});
ok(
  isnap.head === "data:image/png" && isnap.w > 0,
  `查看器是 echarts 快照(${isnap.head} 开头,宽 ${isnap.w})`,
);
await shot("1c-echarts-viewer");
const eTabPromise = page.context().waitForEvent("page", { timeout: 10000 });
await page
  .locator(`button[aria-label="${zh.chat.media.openTab}"]`)
  .first()
  .click();
const eTab = await eTabPromise;
await eTab.locator("img").first().waitFor({ timeout: 10000 });
const eTabImg = await eTab.evaluate(() => {
  const img = document.querySelector("img");
  return { complete: img?.complete ?? false, natural: img?.naturalWidth ?? 0 };
});
ok(
  eTabImg.complete && eTabImg.natural > 0,
  `data: URL 经 objectURL 开新标签页成图(naturalWidth=${eTabImg.natural})`,
);
await eTab.close();
await page.keyboard.press("Escape");
await page.locator('[role="dialog"]').waitFor({ state: "hidden", timeout: 5000 });
ok(true, "Esc 关闭 echarts 查看器");

// ② 放大查看器:点击 → svg 必须有形(0×0 = 塌缩回归)→ 缩放 → 截图 → Esc 关
await page.locator(".diagram-btn").first().click();
await page.locator('[role="dialog"]').waitFor({ timeout: 5000 });
const vrect = await page.evaluate(() => {
  const r = document.querySelector(".media-svg-host svg")?.getBoundingClientRect();
  return r ? { w: Math.round(r.width), h: Math.round(r.height) } : null;
});
ok(vrect !== null && vrect.w > 0 && vrect.h > 0, `查看器 svg 有形(${vrect?.w}×${vrect?.h})`);
await shot("2-viewer-open");

// ②b 新标签页出口:必须是能渲染的 HTML 文档(裸 SVG 会因 htmlLabels 的
// 未闭合标签被 XML 解析拒收——真实事故回归)
const newPagePromise = page.context().waitForEvent("page", { timeout: 10000 });
await page
  .locator(`button[aria-label="${zh.chat.media.openTab}"]`)
  .first()
  .click();
const tab = await newPagePromise;
await tab.locator("body svg").first().waitFor({ timeout: 10000 });
const tabOk = await tab.evaluate(() => ({
  xmlErr: document.body?.innerText?.includes("error on line") ?? false,
  title: document.title,
}));
ok(!tabOk.xmlErr, `新标签页渲染图表(无 XML 报错,title=${tabOk.title})`);
await tab.close();

// ②c 保存到本地:真点下载钮,收 Playwright download 事件
const dlPromise = page.waitForEvent("download", { timeout: 10000 });
await page
  .locator(`button[aria-label="${zh.chat.media.save}"]`)
  .first()
  .click();
const dl = await dlPromise;
ok(/\.svg$/.test(dl.suggestedFilename() ?? ""), `保存到本地(${dl.suggestedFilename()})`);

// ②d 底部缩放胶囊:步进 −25%、百分数读数、点百分数复位
await page
  .locator(`button[aria-label="${zh.chat.media.zoomOut}"]`)
  .first()
  .click();
await page.waitForFunction(
  () => document.querySelector(".media-stage")?.style.transform.includes("scale(0.75)"),
  { timeout: 5000 },
);
ok(true, "胶囊步进缩放 −25%");
await page.getByTitle(zh.chat.media.reset).click();
await page.waitForFunction(
  () => document.querySelector(".media-stage")?.style.transform.includes("scale(1)"),
  { timeout: 5000 },
);
ok(true, "点百分数复位");
await page.mouse.move(210, 400);
for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -160);
const tf = await page.evaluate(
  () => document.querySelector(".media-stage")?.style.transform ?? "",
);
ok(/scale\(1\.\d+\)/.test(tf) && !tf.includes("scale(1)"), `滚轮缩放生效 (${tf})`);
await shot("3-viewer-zoomed");
await page.keyboard.press("Escape");
await page.locator('[role="dialog"]').waitFor({ state: "hidden", timeout: 5000 });
ok(true, "Esc 关闭查看器");

// ③ 坏源码回退:源码可见 + 静置后注记(注记有 800ms 静置门槛,轮询等它出现)
await input.fill("再画一张有语法错误的");
await send.click();
await send.waitFor({ state: "visible", timeout: 30000 });
await page.locator(".diagram-note").first().waitFor({ timeout: 5000 });
await shot("4-fallback-note");
ok(true, "坏源码回退源码态并出注记");

// ④ 深色主题:同一图重渲成暗色(等 innerHTML 变化,证明真的重渲了)
const before = await page.evaluate(
  () => document.querySelector(".diagram-body")?.innerHTML ?? "",
);
await setTheme(page, "dark");
await page.waitForFunction(
  (prev) => document.querySelector(".diagram-body")?.innerHTML !== prev,
  before,
  { timeout: 10000 },
);
await page.locator(".diagram-body svg").first().waitFor({ timeout: 10000 });
// echarts 同步换暗色主题:等 canvas 背景像素变实(浅色默认透明底,dark 主题整幅铺底色)
await page.waitForFunction(
  () => {
    const ctx = document
      .querySelector(".diagram-echarts-body canvas")
      ?.getContext("2d");
    if (!ctx) return false;
    return ctx.getImageData(0, 0, 1, 1).data[3] > 0;
  },
  undefined,
  { timeout: 10000 },
);
ok(true, "echarts 深色主题重渲(canvas 底色变实)");
await waitBars();
await shot("5-flow-dark");
ok(true, "深色主题重渲");

// ④b 深色主题下的查看器:底色跟随主题(深 surface),浅色线图对深底
await page.locator(".diagram-btn").first().click();
await page.locator('[role="dialog"]').waitFor({ timeout: 5000 });
const vrectDark = await page.evaluate(() => {
  const r = document.querySelector(".media-svg-host svg")?.getBoundingClientRect();
  return r ? { w: Math.round(r.width), h: Math.round(r.height) } : null;
});
ok(
  vrectDark !== null && vrectDark.w > 0 && vrectDark.h > 0,
  `深色查看器 svg 有形(${vrectDark?.w}×${vrectDark?.h})`,
);
await shot("5b-viewer-dark");
await page.keyboard.press("Escape");
await page.locator('[role="dialog"]').waitFor({ state: "hidden", timeout: 5000 });

// ⑤ 最窄面板(300px):宽图不撑破、横滚在;echarts 随容器 resize
// (ResizeObserver → resize 链路的实机证据)
const wideW = await page.evaluate(() => {
  const r = document
    .querySelector(".diagram-echarts-body canvas")
    ?.getBoundingClientRect();
  return r ? Math.round(r.width) : 0;
});
await page.setViewportSize({ width: 300, height: 740 });
await page.waitForFunction(
  (prev) => {
    const r = document
      .querySelector(".diagram-echarts-body canvas")
      ?.getBoundingClientRect();
    return r !== undefined && prev > 0 && r.width > 0 && r.width < prev - 20;
  },
  wideW,
  { timeout: 5000 },
);
ok(true, `echarts 随容器 resize(${wideW}px → 300px 面板内收窄)`);
await page.locator(".diagram-figure").first().waitFor({ timeout: 5000 });
await shot("6-narrow-300");
ok(true, "300px 窄面板");

await browser.close();

if (pageErrors.length > 0) {
  console.error(`❌ 页面错误:\n${pageErrors.join("\n")}`);
  process.exit(1);
}
console.log(`\n📸 截图已存 ${OUT_DIR}/diagram-*.png,全链路无 console error`);
