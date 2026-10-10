// 交互工具验证脚本(真实浏览器)
// 用法:node tests/verify-interact.mjs(独立 harness,不加载扩展)
// 用 esbuild 把 src/content/interact.ts 编译成 IIFE 注入 Playwright chromium,
// 对含按钮/输入框/select/checkbox/contenteditable 的测试页跑断言。
// 覆盖:normalizeRole/findInteractive/clickElement(事件序列+遮挡)/
//       fillElement(各类型)/dispatchEnter(keyCode)
// 全部 PASS → 退出码 0;任一失败 → 打印失败并退出码 1。

import { build } from "esbuild";
import { chromium } from "playwright";
// 只借断言助手(harness 仍不加载扩展:makeChecker 是纯函数,无副作用)
import { makeChecker } from "./lib-cdp-mock.mjs";

const check = makeChecker();

async function main() {
  // 1. 编译 interact.ts → IIFE,暴露到 window.__interact
  const { outputFiles } = await build({
    entryPoints: ["src/content/interact.ts"],
    bundle: true,
    format: "iife",
    globalName: "__interact",
    write: false,
    minify: false,
    logLevel: "error",
  });
  const bundleCode = outputFiles[0].text;

  const browser = await chromium.launch();
  const page = await browser.newPage();

  // 2. 测试页:含各种交互元素 + 一个 hidden 元素 + 一个被遮挡元素
  await page.setContent(`<!doctype html>
    <html><body>
      <style>
        /* overlay 只盖右上角,不挡左侧流内元素(#btn-a 等) */
        #overlay { position: absolute; top: 0; right: 0; width: 80px; height: 80px; background: #000; z-index: 10; }
        #covered { position: absolute; top: 10px; right: 10px; z-index: 1; }
      </style>
      <button id="btn-a">提交</button>
      <div><button class="row">行按钮一</button><button class="row">行按钮二</button></div>
      <a href="https://example.com" id="link">链接文字</a>
      <input id="inp" placeholder="搜索关键词" />
      <input id="chk" type="checkbox" checked />
      <select id="sel"><option value="a">选项甲</option><option value="b">选项乙</option></select>
      <textarea id="area"></textarea>
      <div id="ce" contenteditable="true"></div>
      <div id="hidden" style="display:none"><button>看不见</button></div>
      <div id="vhidden"><button id="vh-btn" style="visibility:hidden">自身隐藏</button></div>
      <div id="vparent" style="visibility:hidden">
        <button id="vchild-btn" style="visibility:visible">覆盖可见</button>
      </div>
      <div id="covered"><button id="covered-btn">被盖住的按钮</button></div>
      <div id="overlay"></div>
      <script>${bundleCode}</script>
      <script>
        window.__events = [];
        const log = (t) => window.__events.push(t);
        for (const t of ["pointerdown","mousedown","pointerup","mouseup","click"]) {
          document.getElementById("btn-a").addEventListener(t, () => log(t));
        }
        document.getElementById("inp").addEventListener("input", () => log("input"));
        document.getElementById("inp").addEventListener("change", () => log("change"));
        document.getElementById("inp").addEventListener("keydown", (e) => {
          window.__keyCode = e.keyCode;
          log("keydown");
        });
        document.getElementById("sel").addEventListener("change", () => log("sel-change"));
        document.getElementById("ce").addEventListener("input", () => log("ce-input"));
      </script>
    </body></html>
  `);

  const getEvents = () => page.evaluate(() => window.__events);

  // 现导出面:normalizeRole / findInteractive / clickElement / fillElement /
  // dispatchEnter。早期版本的 buildSelector/getRole/getLabel/getState/
  // getVisibility 已收为模块私有,不再从 bundle 暴露,对应断言随重构移除。

  console.log("\n── normalizeRole ──");
  const norm1 = await page.evaluate(() => window.__interact.normalizeRole("textbox"));
  const norm2 = await page.evaluate(() => window.__interact.normalizeRole("link"));
  const norm3 = await page.evaluate(() => window.__interact.normalizeRole("no-such-role"));
  check(norm1 === "input", "textbox → input",  `(got ${norm1})`);
  check(norm2 === "link", "link 原样保留",  `(got ${norm2})`);
  check(norm3 === null, "未知角色 → null",  `(got ${norm3})`);

  // 闭集逐值直行守卫:role 参数 schema enum 的 9 个值必须全部可归一——
  // 报错文案/结果字段/schema enum 都用这套词,别名表漏直行就会出现
  // 「报错说支持 input、传 input 却被拒」的自相矛盾(2026-09-17 真机踩中)
  // 真源 = page_interact 注册 schema 的 role enum(tools.ts)+ content/observe.ts
  // 的词表;.mjs 不能直 import TS 源,此处镜像——enum 改动时必须同步本清单
  const CLOSED_SET = [
    "button", "link", "input", "checkbox", "radio",
    "switch", "select", "textarea", "contenteditable",
  ];
  const normClosed = await page.evaluate(
    (roles) => roles.map((r) => window.__interact.normalizeRole(r)),
    CLOSED_SET,
  );
  const broken = CLOSED_SET.filter((r, i) => normClosed[i] !== r);
  check(
    broken.length === 0, "闭集 9 值逐一直行(报错文案承诺=校验现实)", 
    `(不直行:${broken.join(",")})`, 
  );

  console.log("\n── findInteractive ──");
  const all = await page.evaluate(() => window.__interact.findInteractive(document, {}));
  check(all.count >= 6, "默认查找含按钮/链接/输入/select/textarea/checkbox",  `(count=${all.count})`);
  check(!all.elements.some((e) => e.label === "看不见"), "跳过 display:none 内元素",  "hidden 元素不应出现在结果");
  // visibility:hidden 不脱布局(仍有渲染盒),必须在有盒路径单独判定:
  // 自身隐藏 → 如实报原因;祖先隐藏但自身显式 visible → 真的可见可点,
  // 不能因祖先链被误判丢弃(2026-09 审计:自己的误判,实测 computed=visible
  // 且 elementFromPoint 命中该子元素)
  const selfHidden = all.elements.find((e) => e.label === "自身隐藏");
  check(
    selfHidden?.visible === false && selfHidden?.hidden === "visibility-hidden", "自身 visibility:hidden 报 visibility-hidden", 
    JSON.stringify(selfHidden), 
  );
  const overrideVisible = all.elements.find((e) => e.label === "覆盖可见");
  check(
    overrideVisible?.visible === true, "祖先 hidden + 自身 visible 仍算可见(覆盖写法)", 
    JSON.stringify(overrideVisible), 
  );
  const byRole = await page.evaluate(() => window.__interact.findInteractive(document, { role: "input" }));
  check(byRole.elements.every((e) => e.role === "input"), "role=input 过滤",  `(count=${byRole.count})`);
  const byText = await page.evaluate(() => window.__interact.findInteractive(document, { text: "行按钮" }));
  check(byText.count === 2, "text 过滤命中 2 个",  `(count=${byText.count})`);
  const limited = await page.evaluate(() => window.__interact.findInteractive(document, { limit: 2 }));
  check(limited.returned === 2 && limited.truncated === true, "limit 截断",  `(got ${limited.returned})`);

  console.log("\n── clickElement(事件序列 + 遮挡) ──");
  await page.evaluate(() => window.__interact.clickElement(document.querySelector("#btn-a")));
  const evs = await getEvents();
  for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    check(evs.includes(t), `click 序列含 ${t}`);
  }
  check(evs.indexOf("mousedown") < evs.indexOf("pointerup"), "mousedown 在 pointerup 之前");

  const coverErr = await page.evaluate(() => {
    try {
      window.__interact.clickElement(document.querySelector("#covered-btn"));
      return null;
    } catch (e) {
      return e.message;
    }
  });
  check(coverErr?.includes("遮挡"), "被遮挡元素抛错(不硬点)",  `(got ${coverErr})`);

  console.log("\n── fillElement ──");
  await page.evaluate(() => window.__interact.fillElement(document.querySelector("#inp"), "hello"));
  const inpVal = await page.evaluate(() => document.querySelector("#inp").value);
  check(inpVal === "hello", "input 值写入",  `(got ${inpVal})`);
  const inpEvs = await getEvents();
  check(inpEvs.includes("input"), "input 事件触发");
  check(inpEvs.includes("change"), "change 事件触发");

  await page.evaluate(() => window.__interact.fillElement(document.querySelector("#sel"), "选项乙"));
  const selVal = await page.evaluate(() => document.querySelector("#sel").value);
  check(selVal === "b", "select 按文字选 option",  `(got ${selVal})`);
  check((await getEvents()).includes("sel-change"), "select change 触发");

  await page.evaluate(() => window.__interact.fillElement(document.querySelector("#ce"), "富文本"));
  const ceText = await page.evaluate(() => document.querySelector("#ce").textContent);
  check(ceText === "富文本", "contenteditable 写入",  `(got ${JSON.stringify(ceText)})`);
  check((await getEvents()).includes("ce-input"), "contenteditable input 事件");

  const badFill = await page.evaluate(() => {
    try {
      window.__interact.fillElement(document.querySelector("#btn-a"), "x");
      return null;
    } catch (e) {
      return e.message;
    }
  });
  check(badFill?.includes("不是可输入控件"), "对 button fill 抛错(不是输入控件)",  `(got ${badFill})`);

  console.log("\n── dispatchEnter(keyCode) ──");
  await page.evaluate(() => window.__interact.dispatchEnter(document.querySelector("#inp")));
  check((await getEvents()).includes("keydown"), "Enter keydown 触发");
  check((await page.evaluate(() => window.__keyCode)) === 13, "keyCode 补全为 13",  `(got ${await page.evaluate(() => window.__keyCode)})`);

  await browser.close();

  console.log(`\n结果:${check.failures.length} 条断言失败`);
  process.exit(check.failures.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("验证脚本运行失败:", err);
  process.exit(1);
});
