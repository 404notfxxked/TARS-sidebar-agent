// 交互工具验证脚本(真实浏览器)
// 用法:node tests/verify-interact.mjs(独立 harness,不加载扩展)
// 用 esbuild 把 src/content/interact.ts 编译成 IIFE 注入 Playwright chromium,
// 对含按钮/输入框/select/checkbox/contenteditable 的测试页跑断言。
// 覆盖:normalizeRole/findInteractive/clickElement(事件序列+遮挡)/
//       fillElement(各类型)/dispatchEnter(keyCode)
// 全部 PASS → 退出码 0;任一失败 → 打印失败并退出码 1。

import { build } from "esbuild";
import { chromium } from "playwright";

let passCount = 0;
let failCount = 0;

function assert(name, cond, detail = "") {
  if (cond) {
    passCount++;
    console.log(`  ✅ ${name}`);
  } else {
    failCount++;
    console.log(`  ❌ ${name} ${detail}`);
  }
}

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
  assert("textbox → input", norm1 === "input", `(got ${norm1})`);
  assert("link 原样保留", norm2 === "link", `(got ${norm2})`);
  assert("未知角色 → null", norm3 === null, `(got ${norm3})`);

  // 闭集逐值直行守卫:role 参数 schema enum 的 9 个值必须全部可归一——
  // 报错文案/结果字段/schema enum 都用这套词,别名表漏直行就会出现
  // 「报错说支持 input、传 input 却被拒」的自相矛盾(2026-09-17 真机踩中)
  const CLOSED_SET = [
    "button", "link", "input", "checkbox", "radio",
    "switch", "select", "textarea", "contenteditable",
  ];
  const normClosed = await page.evaluate(
    (roles) => roles.map((r) => window.__interact.normalizeRole(r)),
    CLOSED_SET,
  );
  const broken = CLOSED_SET.filter((r, i) => normClosed[i] !== r);
  assert(
    "闭集 9 值逐一直行(报错文案承诺=校验现实)",
    broken.length === 0,
    `(不直行:${broken.join(",")})`,
  );

  console.log("\n── findInteractive ──");
  const all = await page.evaluate(() => window.__interact.findInteractive(document, {}));
  assert("默认查找含按钮/链接/输入/select/textarea/checkbox", all.count >= 6, `(count=${all.count})`);
  assert("跳过 display:none 内元素", !all.elements.some((e) => e.label === "看不见"), "hidden 元素不应出现在结果");
  const byRole = await page.evaluate(() => window.__interact.findInteractive(document, { role: "input" }));
  assert("role=input 过滤", byRole.elements.every((e) => e.role === "input"), `(count=${byRole.count})`);
  const byText = await page.evaluate(() => window.__interact.findInteractive(document, { text: "行按钮" }));
  assert("text 过滤命中 2 个", byText.count === 2, `(count=${byText.count})`);
  const limited = await page.evaluate(() => window.__interact.findInteractive(document, { limit: 2 }));
  assert("limit 截断", limited.returned === 2 && limited.truncated === true, `(got ${limited.returned})`);

  console.log("\n── clickElement(事件序列 + 遮挡) ──");
  await page.evaluate(() => window.__interact.clickElement(document.querySelector("#btn-a")));
  const evs = await getEvents();
  for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    assert(`click 序列含 ${t}`, evs.includes(t));
  }
  assert("mousedown 在 pointerup 之前", evs.indexOf("mousedown") < evs.indexOf("pointerup"));

  const coverErr = await page.evaluate(() => {
    try {
      window.__interact.clickElement(document.querySelector("#covered-btn"));
      return null;
    } catch (e) {
      return e.message;
    }
  });
  assert("被遮挡元素抛错(不硬点)", coverErr?.includes("遮挡"), `(got ${coverErr})`);

  console.log("\n── fillElement ──");
  await page.evaluate(() => window.__interact.fillElement(document.querySelector("#inp"), "hello"));
  const inpVal = await page.evaluate(() => document.querySelector("#inp").value);
  assert("input 值写入", inpVal === "hello", `(got ${inpVal})`);
  const inpEvs = await getEvents();
  assert("input 事件触发", inpEvs.includes("input"));
  assert("change 事件触发", inpEvs.includes("change"));

  await page.evaluate(() => window.__interact.fillElement(document.querySelector("#sel"), "选项乙"));
  const selVal = await page.evaluate(() => document.querySelector("#sel").value);
  assert("select 按文字选 option", selVal === "b", `(got ${selVal})`);
  assert("select change 触发", (await getEvents()).includes("sel-change"));

  await page.evaluate(() => window.__interact.fillElement(document.querySelector("#ce"), "富文本"));
  const ceText = await page.evaluate(() => document.querySelector("#ce").textContent);
  assert("contenteditable 写入", ceText === "富文本", `(got ${JSON.stringify(ceText)})`);
  assert("contenteditable input 事件", (await getEvents()).includes("ce-input"));

  const badFill = await page.evaluate(() => {
    try {
      window.__interact.fillElement(document.querySelector("#btn-a"), "x");
      return null;
    } catch (e) {
      return e.message;
    }
  });
  assert("对 button fill 抛错(不是输入控件)", badFill?.includes("不是可输入控件"), `(got ${badFill})`);

  console.log("\n── dispatchEnter(keyCode) ──");
  await page.evaluate(() => window.__interact.dispatchEnter(document.querySelector("#inp")));
  assert("Enter keydown 触发", (await getEvents()).includes("keydown"));
  assert("keyCode 补全为 13", (await page.evaluate(() => window.__keyCode)) === 13, `(got ${await page.evaluate(() => window.__keyCode)})`);

  await browser.close();

  console.log(`\n结果:${passCount} 通过,${failCount} 失败`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("验证脚本运行失败:", err);
  process.exit(1);
});
