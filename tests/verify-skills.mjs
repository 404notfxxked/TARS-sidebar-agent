// 验证技能系统(安装 / 菜单 / 调用注入 / 透传 / 停用 / 总开关 / 回放投影 / 编辑删除)
// 用法: pnpm build && node tests/verify-skills.mjs
//
// 用 CDP Fetch 拦截 LLM 端点 + 面板 UI 驱动,断言:
//   T0. db "tars" 已升到 v4 且 skills store 存在
//   T1. 技能页 UI:粘贴无效文本报错;粘贴 SKILL.md → 落库(skills store)且列表渲染
//   T2. / 菜单:输入 / 触发联想 → 过滤 → 键盘回填 token;发送后 wire 请求含
//       <skill> 正文块,且块在 </context> 与 <user-request> 之间;user-request 保留 token 原文
//   T3. 未知 token:无 <skill> 块,原文透传(宽容,不报错)
//   T4. 停用:菜单不再出现该技能;调用原样透传
//   T5. 总开关关(skills=false):调用透传
//   T6. 历史回放投影:LOAD_HISTORY 的 user 记录不含 <skill> 块(库全量,显示只留原话)
//   T7. 编辑:行展开取回重组原文(frontmatter 还原),改名保存落库
//   T8. 两段确认删除落库

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { bodyText, idbGetAll, injectTestConfig, launchWithCdp, loadHistoryViaPort, makeChecker, openPanel, runAskViaPort, sleep, sse, waitForRunLog } from "./lib-cdp-mock.mjs";
import { zh } from "./lib-i18n.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(__dirname, "..", "dist");
const USER_DATA_DIR = `/tmp/verify-skills-${Date.now()}`;

const SKILL_V1 = [
  "---",
  "name: test-skill",
  "description: Test skill for e2e verification",
  "---",
  "",
  "STEP-MARK: follow this instruction block.",
  "1. Do the thing",
].join("\n");
const SKILL_V2 = [
  "---",
  "name: renamed-skill",
  "description: Renamed test skill",
  "---",
  "",
  "STEP-MARK v2: renamed body.",
].join("\n");

// 块标量回归:humanizer 同款多行 description(`description: |`),
// 曾因解析器不识块标量而把 description 存成字面 "|"
const SKILL_BLOCK_DESC = [
  "---",
  "name: block-desc",
  "description: |",
  "  Line one of a literal block description.",
  "  Line two mentions: colons and \"quotes\".",
  "---",
  "",
  "Block-desc body.",
].join("\n");

let lastAgentBody = null;

const { browser, extId, mock } = await launchWithCdp({
  extDir: EXT_DIR,
  userDataDir: USER_DATA_DIR,
});
console.log("✅ 扩展:", extId);

mock.setRoutes([
  {
    match: (url) => url.includes("/chat/completions"),
    handle: async (ctx) => {
      lastAgentBody = JSON.parse(ctx.params.request.postData ?? "{}");
      return ctx.fulfill({
        headers: { "Content-Type": "text/event-stream" },
        body: sse(
          { choices: [{ delta: { content: "终答:SKILL_OK" } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ),
      });
    },
  },
]);
console.log("✅ mock 路由已注册");

const sidepanel = await openPanel(browser, extId);

const check = makeChecker();
const chatInput = () => sidepanel.locator(`textarea[aria-label="${zh.chat.askInput}"]`);

await injectTestConfig(sidepanel);

/** 直写/读取 skills store(断言落库用) */
const readSkills = () => idbGetAll(sidepanel, "skills");

/** 裸 port 跑一次 run(不经 UI) */
const runAsk = (sessionId, text) => runAskViaPort(sidepanel, sessionId, text);

/** 裸 port 拉历史投影(LOAD_HISTORY → ChatRecord[]) */
const loadHistory = (sessionId) => loadHistoryViaPort(sidepanel, sessionId);

/** mock 记录的请求里最后一条 user 消息 */
const lastUserMsg = () => {
  const msgs = lastAgentBody?.messages ?? [];
  return [...msgs].reverse().find((m) => m.role === "user");
};

/** 设置页 → 技能整页;返回聊天(Esc 两次:技能页 → 设置 → 聊天) */
async function openSkillPage() {
  await sidepanel.locator(`button[aria-label="${zh.chat.openSettings}"]`).click();
  await sidepanel.locator(`h2:has-text("${zh.settings.title}")`).waitFor({ timeout: 5000 });
  await sidepanel.locator(`button[aria-label="${zh.skills.manage}"]`).click();
  await sidepanel.locator(`h2:has-text("${zh.skills.title}")`).waitFor({ timeout: 5000 });
}
async function backToChat() {
  await sidepanel.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 300));
  await sidepanel.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 300));
}

// ---- T0. DB 版本与 skills store ----
console.log("\n===== T0. db v4 + skills store =====");
{
  const info = await sidepanel.evaluate(
    () =>
      new Promise((done, fail) => {
        const req = indexedDB.open("tars");
        req.onsuccess = () => {
          const db = req.result;
          done({
            version: db.version,
            hasSkills: db.objectStoreNames.contains("skills"),
          });
          db.close();
        };
        req.onerror = () => fail(req.error);
      }),
  );
  check(info.version >= 4, "T0-1 db 版本 ≥ 4", `version=${info.version}`);
  check(info.hasSkills, "T0-2 skills store 存在(v3 老库升级幂等补建)");
}

// ---- T1. 技能页 UI:无效报错 + 有效安装落库 ----
console.log("\n===== T1. 技能页:安装(粘贴)=====");
{
  await openSkillPage();
  await sidepanel.getByRole("button", { name: zh.skills.add }).click();
  const editor = sidepanel.locator(`textarea[aria-label="${zh.skills.add}"]`);
  await editor.waitFor({ timeout: 5000 });

  // 无效文本 → 错误就地展示,不落库
  await editor.fill("这不是一个 SKILL.md");
  await sidepanel.getByRole("button", { name: zh.skills.save, exact: true }).click();
  await sidepanel.locator(".field-hint.text-error").waitFor({ timeout: 5000 });
  check(
    (await bodyText(sidepanel)).includes("frontmatter"),
    "T1-1 无效文本保存报错(缺 frontmatter)",
  );
  check((await readSkills()).length === 0, "T1-2 无效文本未落库");

  // 有效 SKILL.md → 列表出现 + 落库
  await editor.fill(SKILL_V1);
  await sidepanel.getByRole("button", { name: zh.skills.save, exact: true }).click();
  await sidepanel.locator("li").filter({ hasText: "/test-skill" }).waitFor({ timeout: 5000 });
  const rows = await readSkills();
  check(
    rows.length === 1 &&
      rows[0].name === "test-skill" &&
      rows[0].body.includes("STEP-MARK") &&
      rows[0].enabled === true,
    "T1-3 SKILL.md 解析落库(含正文,默认启用)",
    JSON.stringify(rows.map((r) => r.name)),
  );

  // 块标量多行 description(humanizer 同款):保存后保留换行,不退化为 "|"
  await sidepanel.getByRole("button", { name: zh.skills.add }).click();
  await editor.fill(SKILL_BLOCK_DESC);
  await sidepanel.getByRole("button", { name: zh.skills.save, exact: true }).click();
  await sidepanel.locator("li").filter({ hasText: "/block-desc" }).waitFor({ timeout: 5000 });
  const blockRow = (await readSkills()).find((r) => r.name === "block-desc");
  check(
    !!blockRow &&
      blockRow.description.includes("\n") &&
      blockRow.description.includes("Line two mentions"),
    "T1-4 块标量多行 description 完整保存",
    JSON.stringify(blockRow?.description),
  );
  await backToChat();
}

// ---- T2. / 菜单 + 调用注入 ----
console.log("\n===== T2. / 菜单与 <skill> 注入 =====");
{
  await chatInput().fill("/");
  await sidepanel.locator('[role="option"]').first().waitFor({ timeout: 5000 });
  check(
    (await sidepanel.locator('[role="option"]').count()) > 0,
    "T2-1 输入 / 弹出联想菜单",
  );

  // 屏幕内断言:浮层曾因锚点缺 relative 挂到面板根、被 top: -N 顶出视口,
  // DOM 可见性断言照样绿(假阳性)——选项 bounding box 必须真落在视口里
  {
    const box = await sidepanel.locator('[role="option"]').first().boundingBox();
    const vp = sidepanel.viewportSize();
    check(
      !!box &&
        box.y >= 0 &&
        box.y + box.height <= vp.height &&
        box.x >= 0 &&
        box.x + box.width <= vp.width,
      "T2-1b 菜单选项渲染在视口内(锚点正确)",
      JSON.stringify({ box, viewport: vp }),
    );
  }

  await chatInput().fill("/test");
  check(
    (await sidepanel.locator('[role="option"]').count()) === 1,
    "T2-2 按名称过滤命中",
  );
  await chatInput().fill("/zzz");
  await sidepanel.locator(".skill-pop-note").waitFor({ timeout: 3000 });
  check(
    (await bodyText(sidepanel)).includes(zh.skills.menuNoMatch.replace("{query}", "zzz")),
    "T2-3 无匹配提示",
  );

  // 键盘选中:回填 token + 尾随空格,菜单关闭
  await chatInput().fill("/test");
  await sidepanel.locator('[role="option"]').first().waitFor({ timeout: 5000 });
  await sidepanel.keyboard.press("Enter");
  await new Promise((r) => setTimeout(r, 200));
  const value = await chatInput().inputValue();
  check(value === "/test-skill ", "T2-4 键盘选中回填 token", value);

  // 继续补正文后发送 → wire 断言
  await chatInput().pressSequentially("按步骤执行");
  await sidepanel.keyboard.press("Enter");
  await waitForRunLog(sidepanel, (e) => e.msg === "run ended", "run ended");
  const msg = lastUserMsg();
  check(
    !!msg && msg.content.includes('<skill name="test-skill">'),
    "T2-5 wire 请求含 <skill> 块",
    msg?.content.slice(0, 200),
  );
  check(
    msg.content.includes("STEP-MARK"),
    "T2-6 <skill> 块含技能正文",
  );
  const between = msg.content.split("</context>")[1] ?? "";
  check(
    between.indexOf("<skill") < between.indexOf("<user-request>") &&
      between.includes("<skill"),
    "T2-7 块位于 </context> 与 <user-request> 之间",
  );
  check(
    msg.content.includes("/test-skill 按步骤执行"),
    "T2-8 user-request 保留 token 原文(回显一致)",
    msg.content.split("<user-request>")[1],
  );
}

// ---- T3. 未知 token 透传 ----
console.log("\n===== T3. 未知 token 透传 =====");
{
  await runAsk("s-t3", "/nope-xyz 帮我查事");
  const msg = lastUserMsg();
  check(
    !msg.content.includes("<skill"),
    "T3-1 未知名不注入 <skill> 块",
  );
  check(
    msg.content.includes("/nope-xyz 帮我查事"),
    "T3-2 原样透传不报错",
  );
}

// ---- T4. 停用:菜单不出现 + 调用透传 ----
console.log("\n===== T4. 停用技能 =====");
{
  await openSkillPage();
  const row = sidepanel.locator("li").filter({ hasText: "/test-skill" });
  await row.locator(`button[aria-label="${zh.skills.disable}"]`).click();
  await row.locator(`button[aria-label="${zh.skills.enable}"]`).waitFor({ timeout: 5000 });
  check(
    (await readSkills()).find((r) => r.name === "test-skill")?.enabled === false,
    "T4-1 停用落库(enabled=false)",
  );
  // 停用另一个启用技能,凑成「无启用技能」状态
  const rowB = sidepanel.locator("li").filter({ hasText: "/block-desc" });
  await rowB.locator(`button[aria-label="${zh.skills.disable}"]`).click();
  await rowB.locator(`button[aria-label="${zh.skills.enable}"]`).waitFor({ timeout: 5000 });
  await backToChat();

  // 菜单不再出现该技能(无启用技能 → 空态引导;清单缓存 3s TTL,先等自愈)
  await new Promise((r) => setTimeout(r, 3300));
  await chatInput().fill("/");
  await sidepanel.locator(".skill-pop-note").waitFor({ timeout: 5000 });
  check(
    (await sidepanel.locator('[role="option"]').count()) === 0 &&
      (await bodyText(sidepanel)).includes(zh.skills.menuEmpty),
    "T4-2 菜单无启用技能时展示空态引导",
  );
  await chatInput().fill("");

  await runAsk("s-t4", "/test-skill 在吗");
  check(
    !lastUserMsg().content.includes("<skill"),
    "T4-3 停用后调用原样透传",
  );

  // 重新启用 test-skill(block-desc 保持停用,留给 T8 清理)
  await openSkillPage();
  const row2 = sidepanel.locator("li").filter({ hasText: "/test-skill" });
  await row2.locator(`button[aria-label="${zh.skills.enable}"]`).click();
  await row2.locator(`button[aria-label="${zh.skills.disable}"]`).waitFor({ timeout: 5000 });
  await backToChat();
}

// ---- T5. 总开关关 ----
console.log("\n===== T5. 总开关关:调用透传 =====");
// biome-ignore lint/complexity/noUselessLoneBlockStatements: 块用于限定 await 作用域与场景注释
{
  await sidepanel.evaluate(() =>
    chrome.storage.local.set({ skills: false }),
  );
  await runAsk("s-t5", "/test-skill 开关关了");
  check(
    !lastUserMsg().content.includes("<skill"),
    "T5-1 开关关时不注入 <skill> 块",
  );
  await sidepanel.evaluate(() =>
    chrome.storage.local.set({ skills: true }),
  );
}

// ---- T6. 历史回放投影 ----
console.log("\n===== T6. 历史回放:<skill> 块不进显示层 =====");
{
  // 已知会话里裸 port 跑一次带技能调用的 run(T2 的 UI run 会话 id 随机)
  await runAsk("s-t6", "/test-skill 回放测试");
  const records = await loadHistory("s-t6");
  const userRec = records.find((r) => r.role === "user");
  check(
    !!userRec && userRec.content.includes("回放测试"),
    "T6-1 历史中存在该 user 记录",
    JSON.stringify(records.map((r) => r.content.slice(0, 60))),
  );
  check(
    !!userRec &&
      !userRec.content.includes("<skill") &&
      !userRec.content.includes("<context>"),
    "T6-2 投影不含 <skill> 块与 <context>(只留用户原话)",
    userRec?.content,
  );
  // 落盘仍是全量:消息行里带 <skill> 块(追问时上下文可用)
  const rawHasBlock = await sidepanel.evaluate(
    () =>
      new Promise((done, fail) => {
        const req = indexedDB.open("tars");
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("messages", "readonly");
          const q = tx
            .objectStore("messages")
            .index("bySession")
            .getAll(IDBKeyRange.only("s-t6"));
          q.onsuccess = () => {
            db.close();
            // 结构化读取(JSON.stringify 会转义引号,字符串搜索会漏)
            const hit = q.result.some(
              (row) =>
                typeof row.msg?.content === "string" &&
                row.msg.content.includes('<skill name="test-skill">'),
            );
            done(hit);
          };
          q.onerror = () => fail(q.error);
        };
        req.onerror = () => fail(req.error);
      }),
  );
  check(rawHasBlock, "T6-3 消息库全量保留 <skill> 块(显示层投影才剥离)");
}

// ---- T7. 编辑:重组原文回填 + 改名保存 ----
console.log("\n===== T7. 编辑技能 =====");
{
  await openSkillPage();
  check(
    (await sidepanel.locator(`button[aria-label="${zh.skills.backToSettings}"]`).count()) === 1,
    "T7-0 设置页进入,返回钮为「返回设置」",
  );
  const row = sidepanel.locator("li").filter({ hasText: "/test-skill" });
  // 编辑入口是行尾悬停显形的铅笔钮(整行文本不再承载点击)
  await row.locator(`button[aria-label="${zh.skills.edit}"]`).click();
  const editor = sidepanel.locator(`textarea[aria-label="${zh.skills.edit}"]`);
  await editor.waitFor({ timeout: 5000 });
  // textarea 挂载即通过 waitFor,但值经 SKILL_RAW 异步回填(~百 ms 量级,
  // 机器忙时更长):必须轮询等非空,同步读值是与回包竞速的 flake
  let raw = "";
  for (let i = 0; i < 30 && raw.length === 0; i++) {
    raw = await editor.inputValue();
    if (raw.length === 0) await sleep(100);
  }
  check(
    raw.startsWith("---") && raw.includes("name: test-skill") && raw.includes("STEP-MARK"),
    "T7-1 展开取回重组原文(frontmatter + 正文)",
    raw.slice(0, 120),
  );
  await editor.fill(SKILL_V2);
  await sidepanel.getByRole("button", { name: zh.skills.save, exact: true }).click();
  await sidepanel.locator("li").filter({ hasText: "/renamed-skill" }).waitFor({ timeout: 5000 });
  const rows = await readSkills();
  const renamed = rows.find((r) => r.name === "renamed-skill");
  check(
    rows.length === 2 && !!renamed && renamed.body.includes("v2"),
    "T7-2 改名保存落库(不新增行)",
    JSON.stringify(rows.map((r) => r.name)),
  );
}

// ---- T8. 两段确认删除 ----
console.log("\n===== T8. 删除技能 =====");
{
  const row = sidepanel.locator("li").filter({ hasText: "/renamed-skill" });
  await row.locator(`button[aria-label="${zh.skills.deleteOne}"]`).click();
  await row.locator(`button[aria-label="${zh.common.confirmDelete}"]`).click();
  await row.waitFor({ state: "detached", timeout: 5000 });
  const rowB = sidepanel.locator("li").filter({ hasText: "/block-desc" });
  await rowB.locator(`button[aria-label="${zh.skills.deleteOne}"]`).click();
  await rowB.locator(`button[aria-label="${zh.common.confirmDelete}"]`).click();
  await rowB.waitFor({ state: "detached", timeout: 5000 });
  check((await readSkills()).length === 0, "T8-1 两段确认删除落库");

  // 收尾:回聊天页,留干净状态
  await backToChat();
  await chatInput().waitFor({ state: "visible", timeout: 5000 });
  check(await chatInput().isVisible(), "T8-2 收尾回到聊天视图");
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
