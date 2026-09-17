// 验证长期记忆(存取/注入/管理/轻提示)
// 用法: pnpm build && node tests/verify-memory.mjs
//
// 用 CDP Fetch 拦截 LLM 端点 + 直写 IndexedDB,断言:
//   T0. db "tars" 已升到 v3 且 memories store 存在(老库升级幂等建 store)
//   T1. 总开关关:请求不含 memory_* 工具、无 <user-memory> 注入
//   T2. 显式保存:模型调 memory_save → 落库;下一轮请求注入 <user-memory>
//   T3. 置顶优先 + 预算裁剪:超预算时 pinned 保留、最旧条目被裁
//   T4. memory_delete:子串命中删行;无匹配回错误文案给模型
//   T7. 精确重复保存去重(duplicate,不新增行)
//   T9. 混合格式:卡片 save(key/tag 落库)→ 同 key upsert 覆盖不新增 →
//       标点差异规范化去重 → replaceOf 替换 → 混合注入两段式(段头/key: text)
//   T6. 虚拟注入:记忆块不写入会话消息历史
//   T5. 记忆页 UI:设置页摘要入口 → 记忆整页,添加/行内编辑/置顶/两段确认删除/
//       溢出菜单两段确认清空(Esc 只关菜单) 走 MEM_* 消息落 IDB
//   T8. 轻提示:保存后面板渲染「已写入 1 条记忆」,点击直通记忆管理页
//
// run 驱动两种方式:裸 port(不经 UI,断言 wire/库)+ 面板 UI(T8)。

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  launchWithCdp,
  ask,
  waitForRunLog,
  sse,
} from "./lib-cdp-mock.mjs";
import { zh, en } from "./lib-i18n.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(__dirname, "..", "dist");
const USER_DATA_DIR = `/tmp/verify-memory-${Date.now()}`;

const SAVE_TEXT = "用户偏好简洁的中文回答";
const REPLACE_TEXT = "用户现居上海(2026-09 起)";

// ---- LLM mock 状态:按 mode 决定模型行为 ----
const llm = { mode: "normal" }; // normal | save | save-dup | delete | delete-miss | save-card...
let lastAgentBody = null;
/** replaceOf 的目标条目 id(T9 种入后设置) */
let replaceTargetId = null;

const answer = (ctx, text) =>
  ctx.fulfill({
    headers: { "Content-Type": "text/event-stream" },
    body: sse(
      { choices: [{ delta: { content: text } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ),
  });
const toolCall = (ctx, name, args) =>
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

const { browser, extId, mock } = await launchWithCdp({
  extDir: EXT_DIR,
  userDataDir: USER_DATA_DIR,
});
console.log("✅ 扩展:", extId);

mock.setRoutes([
  {
    match: (url) => url.includes("/chat/completions"),
    handle: async (ctx) => {
      const body = JSON.parse(ctx.params.request.postData ?? "{}");
      // 只认「最后一条 user 之后」的 tool 消息 = 本轮的工具往返;
      // 历史里的 tool 消息是上一个 run 持久化的,不能算
      const msgs = body.messages ?? [];
      const lastUserIdx = msgs.map((m) => m.role).lastIndexOf("user");
      const usedTool = msgs
        .slice(lastUserIdx + 1)
        .some((m) => m.role === "tool");
      lastAgentBody = body;
      switch (llm.mode) {
        case "save":
        case "save-dup":
        case "save-new":
        case "save-fresh": {
          // save-dup 与 save-new 同文本(测去重);save/save-fresh 各自独立新文本
          const content =
            llm.mode === "save-new" || llm.mode === "save-dup"
              ? "我在做 Chrome 扩展项目"
              : llm.mode === "save-fresh"
                ? "用户喜欢用列表整理信息"
                : SAVE_TEXT;
          if (!usedTool) return toolCall(ctx, "memory_save", { content });
          return answer(ctx, "好,已记住。终答:MEM_OK");
        }
        case "delete":
          if (!usedTool) return toolCall(ctx, "memory_delete", { match: "简洁" });
          return answer(ctx, "已删除。终答:MEM_OK");
        case "delete-miss":
          if (!usedTool)
            return toolCall(ctx, "memory_delete", { match: "绝不存在的词" });
          return answer(ctx, "没找到。终答:MEM_OK");
        case "save-card":
        case "save-card-2": {
          // 同 key "diet" 存两次:第二次值变了 → upsert 覆盖,不新增行
          const args =
            llm.mode === "save-card"
              ? { content: "用户不吃辣,饮食建议避开川菜", key: "diet", tag: en.memory.tagHealth }
              : { content: "用户自 2026 年起不吃辣", key: "diet", tag: en.memory.tagHealth };
          if (!usedTool) return toolCall(ctx, "memory_save", args);
          return answer(ctx, "好,已记住。终答:MEM_OK");
        }
        case "save-norm":
          // 标点差异 vs 已种子化的「用户不吃香菜」:规范化后同文 → 去重
          if (!usedTool)
            return toolCall(ctx, "memory_save", { content: "用户,不吃香菜!" });
          return answer(ctx, "好,已记住。终答:MEM_OK");
        case "save-replace":
          if (!usedTool)
            return toolCall(ctx, "memory_save", {
              content: REPLACE_TEXT,
              replaceOf: replaceTargetId,
            });
          return answer(ctx, "已更新。终答:MEM_OK");
        default:
          return answer(ctx, "终答:MEM_OK");
      }
    },
  },
]);
console.log("✅ mock 路由已注册");

// ---- 面板 + 配置 ----
const sidepanel = await browser.newPage();
await sidepanel.goto(`chrome-extension://${extId}/sidepanel.html`);
await new Promise((r) => setTimeout(r, 1000));

const failures = [];
function check(ok, label, detail = "") {
  console.log(ok ? "✅" : "❌", label, ok ? "" : `\n   ${detail}`);
  if (!ok) failures.push(label);
}
const uiText = () => sidepanel.locator("body").innerText();

/** 模型配置(新 providers schema;SW 每次 run 现读) */
await sidepanel.evaluate(() =>
  chrome.storage.local.set({
    providers: [
      {
        id: "prov-1",
        name: "TestProv",
        baseUrl: "https://api.test.example.com/v1",
        apiKey: "sk-test",
        models: [{ id: "gpt-test" }],
      },
    ],
    modelProvider: "prov-1",
    model: "gpt-test",
  }),
);

/** 记忆条目直写 IDB(memories store);可指定 id(replaceOf 断言用),返回行 id */
async function seedMemory(text, { pinned = false, ageMs = 0, id } = {}) {
  return sidepanel.evaluate(
    ({ text, pinned, at, id }) =>
      new Promise((done, fail) => {
        const req = indexedDB.open("tars");
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("memories", "readwrite");
          const rowId = id ?? crypto.randomUUID();
          tx.objectStore("memories").put({
            id: rowId,
            text,
            createdAt: at,
            updatedAt: at,
            pinned,
            source: "user",
          });
          tx.oncomplete = () => {
            db.close();
            done(rowId);
          };
          tx.onerror = () => fail(tx.error);
        };
        req.onerror = () => fail(req.error);
      }),
    { text, pinned, at: Date.now() - ageMs, id },
  );
}

/** 读全部记忆行 */
const readMemories = () =>
  sidepanel.evaluate(
    () =>
      new Promise((done, fail) => {
        const req = indexedDB.open("tars");
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("memories", "readonly");
          const q = tx.objectStore("memories").getAll();
          q.onsuccess = () => {
            db.close();
            done(q.result);
          };
          q.onerror = () => fail(q.error);
        };
        req.onerror = () => fail(req.error);
      }),
  );

/** 读单个会话行(标题回归断言用) */
const readSession = (sessionId) =>
  sidepanel.evaluate(
    (sessionId) =>
      new Promise((done, fail) => {
        const req = indexedDB.open("tars");
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("sessions", "readonly");
          const q = tx.objectStore("sessions").get(sessionId);
          q.onsuccess = () => {
            db.close();
            done(q.result);
          };
          q.onerror = () => fail(q.error);
        };
      }),
    sessionId,
  );

/** 读某会话消息行(虚拟注入断言用) */
const readRows = (sessionId) =>
  sidepanel.evaluate(
    (sessionId) =>
      new Promise((done, fail) => {
        const req = indexedDB.open("tars");
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("messages", "readonly");
          const q = tx
            .objectStore("messages")
            .index("bySession")
            .getAll(IDBKeyRange.only(sessionId));
          q.onsuccess = () => {
            db.close();
            done(q.result);
          };
          q.onerror = () => fail(q.error);
        };
      }),
    sessionId,
  );

/** 裸 port 驱动一次 run(不经 UI):发 USER_MESSAGE,等 agent_done/error */
const runAsk = (sessionId, text) =>
  sidepanel.evaluate(
    ({ sessionId, text }) =>
      new Promise((resolve, reject) => {
        const port = chrome.runtime.connect({ name: "agent-port" });
        const timer = setTimeout(() => reject(new Error("run 超时")), 60000);
        port.onMessage.addListener((msg) => {
          if (msg.type === "agent_done" || msg.type === "agent_error") {
            clearTimeout(timer);
            port.disconnect();
            resolve(msg);
          }
        });
        port.postMessage({ type: "user_message", payload: { text, sessionId } });
      }),
    { sessionId, text },
  );

const setMemoryFlag = (on) =>
  sidepanel.evaluate((on) => chrome.storage.local.set({ memory: on }), on);

// ---- T0. DB 版本与 memories store ----
console.log("\n===== T0. db v3 + memories store 存在 =====");
{
  const info = await sidepanel.evaluate(
    () =>
      new Promise((done, fail) => {
        const req = indexedDB.open("tars");
        req.onsuccess = () => {
          const db = req.result;
          done({
            version: db.version,
            hasMemories: db.objectStoreNames.contains("memories"),
          });
          db.close();
        };
        req.onerror = () => fail(req.error);
      }),
  );
  check(info.version >= 3, "T0-1 db 版本 ≥ 3", `version=${info.version}`);
  check(info.hasMemories, "T0-2 memories store 存在(v2 老库升级幂等补建)");
}

// ---- T1. 总开关关 ----
console.log("\n===== T1. 总开关关:无 memory_* 工具、无注入 =====");
await setMemoryFlag(false);
{
  await runAsk("s-t1", "开关关闭时的提问");
  const names = (lastAgentBody.tools ?? []).map((t) => t.function?.name);
  check(
    !names.includes("memory_save") && !names.includes("memory_delete"),
    "T1-1 请求不含 memory_* 工具",
    JSON.stringify(names),
  );
  check(
    !JSON.stringify(lastAgentBody.messages).includes("user-memory"),
    "T1-2 请求不含 <user-memory> 注入",
  );
}

// ---- T2. 显式保存 + 注入 ----
console.log("\n===== T2. memory_save 落库 + 下轮注入 =====");
await setMemoryFlag(true);
{
  llm.mode = "save";
  await runAsk("s-t2", "记住我喜欢简洁回答");
  const rows = await readMemories();
  check(
    rows.some((r) => r.text === SAVE_TEXT && r.source === "model"),
    "T2-1 工具写入落库(source=model)",
    JSON.stringify(rows.map((r) => r.text)),
  );
  check(rows.length === 1, "T2-2 恰好一条(无重复)", `count=${rows.length}`);

  llm.mode = "normal";
  await runAsk("s-t2", "继续聊聊");
  const msgs = lastAgentBody.messages;
  check(
    msgs.length > 1 && msgs[1].role === "user" && msgs[1].content.includes("<user-memory>"),
    "T2-3 记忆块插在 system 之后(下标 1)",
    JSON.stringify(msgs.slice(0, 3).map((m) => m.role)),
  );
  check(
    msgs[1].content.includes(SAVE_TEXT),
    "T2-4 注入内容命中刚保存的文本",
    msgs[1].content,
  );
  check(
    msgs[1].content.includes("Consider it only when relevant"),
    "T2-5 注入块带使用纪律头部(防硬关联)",
  );
}

// ---- T6. 虚拟注入:记忆不进会话历史 ----
console.log("\n===== T6. 虚拟注入:消息历史无记忆块 =====");
{
  const rows = await readRows("s-t2");
  const inHistory = rows.some((r) =>
    JSON.stringify(r.msg).includes("user-memory"),
  );
  check(!inHistory, "T6-1 会话历史行不含 <user-memory>(发送时投影)");
}

// ---- T3. 置顶优先 + 预算裁剪 ----
console.log("\n===== T3. 预算裁剪:pinned 优先、最旧被裁 =====");
{
  // 1 条置顶 + 30 条长文本(每条 ~110 token,合计远超 600 预算);
  // updatedAt 按序递减:MEM-0 最新,MEM-29 最旧
  await seedMemory("置顶条目 PIN-MARK(必须保留)", { pinned: true, ageMs: 0 });
  for (let i = 0; i < 30; i++) {
    await seedMemory(`普通条目 MEM-${i} ${"项".repeat(90)}`, {
      ageMs: (i + 1) * 1000,
    });
  }
  await runAsk("s-t3", "预算测试提问");
  const block = lastAgentBody.messages.find((m) =>
    m.content?.includes("<user-memory>"),
  )?.content;
  check(!!block, "T3-1 存在注入块");
  check(block.includes("PIN-MARK"), "T3-2 置顶条目保留");
  check(block.includes("MEM-0"), "T3-3 最新的普通条目保留");
  check(!block.includes("MEM-29"), "T3-4 最旧的普通条目被裁剪");
  const lines = block.split("\n").filter((l) => l.startsWith("・"));
  check(lines.length < 31, "T3-5 注入条数被预算收敛", `lines=${lines.length}`);
  check(
    block.includes("(+") && block.includes("not shown"),
    "T3-6 裁剪时注入块尾带库存尾注(防模型失明重复保存)",
  );
}

// ---- T4. memory_delete ----
console.log("\n===== T4. 删除:子串命中 + 无匹配报错 =====");
{
  llm.mode = "delete";
  await runAsk("s-t4", "忘掉关于简洁的偏好");
  const after = await readMemories();
  check(
    !after.some((r) => r.text === SAVE_TEXT),
    "T4-1 命中条目已从库中删除",
    JSON.stringify(after.map((r) => r.text)),
  );

  llm.mode = "delete-miss";
  const before = (await readMemories()).length;
  await runAsk("s-t4", "忘掉绝不存在的词");
  const errRows = await readMemories();
  check(errRows.length === before, "T4-2 无匹配时库不变");
  // 工具抛错会作为 tool 结果回给模型:mock 第二轮直接终答,run 正常结束
  // (错误文案在后台日志,轮询断言之)
  try {
    await waitForRunLog(
      sidepanel,
      (e) =>
        e.tag === "memory" &&
        e.msg.includes("按匹配删除") &&
        (e.data ?? "").includes('"count":0'),
      "无匹配删除日志",
      8000,
    );
    check(true, "T4-3 无匹配时记录 count=0 日志");
  } catch (err) {
    console.log("DEBUG 日志转储:\n", err.message);
    check(false, "T4-3 无匹配时记录 count=0 日志", "日志未找到");
  }
}

// ---- T7. 精确重复保存去重 ----
console.log("\n===== T7. 重复保存去重 =====");
{
  // 先存一条新文本,再原样重存:第二次应走去重(刷新原条目,不新增行)
  llm.mode = "save-new";
  await runAsk("s-t7", "记住我在做 Chrome 扩展");
  const afterFirst = await readMemories();
  llm.mode = "save-dup";
  await runAsk("s-t7", "再记一遍我在做 Chrome 扩展");
  const afterDup = await readMemories();
  check(
    afterDup.length === afterFirst.length &&
      afterDup.filter((r) => r.text === "我在做 Chrome 扩展项目").length === 1,
    "T7-1 精确重复未新增行",
    `first=${afterFirst.length} dup=${afterDup.length}`,
  );

  // 标题回归:s-t7 首次落盘时记忆已存在,prompt 里带 <user-memory> 伪消息 ——
  // 标题必须取真实首条用户消息,而不是注入块(曾因此产出 "<user-memory>…" 标题)
  const s7 = await readSession("s-t7");
  check(
    !!s7?.title && !s7.title.includes("user-memory"),
    "T7-2 会话标题不受记忆注入污染",
    s7?.title,
  );
}

// ---- T9. 混合格式:卡片 upsert / 规范化去重 / replaceOf / 两段式注入 ----
console.log("\n===== T9. 混合格式:卡片 / replaceOf / 两段式 =====");
{
  // T9-1/2 卡片落库带 key+tag
  llm.mode = "save-card";
  await runAsk("s-t9", "记住我的饮食禁忌");
  let rows = await readMemories();
  const cardRow = rows.find((r) => r.key === "diet");
  check(!!cardRow, "T9-1 卡片落库(带 key)", JSON.stringify(rows.map((r) => r.text)));
  check(cardRow?.tag === en.memory.tagHealth, "T9-2 tag 落库", cardRow?.tag);

  // T9-3/4 同 key 再存(值变了)→ upsert 覆盖,不新增行
  llm.mode = "save-card-2";
  const beforeCount = (await readMemories()).length;
  await runAsk("s-t9", "我的饮食禁忌变了");
  rows = await readMemories();
  const dietRows = rows.filter((r) => r.key === "diet");
  check(
    dietRows.length === 1 && dietRows[0].text === "用户自 2026 年起不吃辣",
    "T9-3 同 key upsert 覆盖旧值",
    JSON.stringify(dietRows.map((r) => r.text)),
  );
  check(
    rows.length === beforeCount,
    "T9-4 upsert 未新增行",
    `before=${beforeCount} after=${rows.length}`,
  );

  // T9-5 规范化去重:标点差异不算新条目
  await seedMemory("用户不吃香菜");
  llm.mode = "save-norm";
  const c5 = (await readMemories()).length;
  await runAsk("s-t9", "记住我不吃香菜");
  rows = await readMemories();
  check(
    rows.length === c5 &&
      rows.filter((r) => r.text.includes("不吃香菜")).length === 1,
    "T9-5 标点差异按同文去重",
    JSON.stringify(rows.filter((r) => r.text.includes("香菜")).map((r) => r.text)),
  );

  // T9-6 replaceOf:替换目标条目文本,行数不变
  replaceTargetId = await seedMemory("旧的城市信息", { id: "fixed-replace-id" });
  llm.mode = "save-replace";
  await runAsk("s-t9", "我的城市变了");
  rows = await readMemories();
  const replaced = rows.find((r) => r.id === "fixed-replace-id");
  check(
    replaced?.text === REPLACE_TEXT,
    "T9-6 replaceOf 覆盖目标条目文本",
    replaced?.text,
  );

  // T9-7/8 混合注入:卡片在前简条在后带段头,卡片行渲染 key: text
  llm.mode = "normal";
  await runAsk("s-t9", "聊聊今天的天气");
  const block = lastAgentBody.messages.find((m) =>
    m.content?.includes("<user-memory>"),
  )?.content;
  check(
    !!block && block.includes("[profile]") && block.includes("[notes]"),
    "T9-7 混合注入带两段段头",
    block?.slice(0, 200),
  );
  check(
    block.includes("diet: 用户自 2026 年起不吃辣"),
    "T9-8 卡片行渲染为 key: text",
    block?.split("\n").filter((l) => l.includes("diet")).join(" | "),
  );
}

// ---- T5. 记忆页 UI CRUD(设置页 → 摘要入口行 → 记忆整页) ----
console.log("\n===== T5. 记忆页:添加/编辑/置顶/删除 =====");
{
  await sidepanel.locator(`button[aria-label="${zh.chat.openSettings}"]`).click();
  await sidepanel.locator(`h2:has-text("${zh.settings.title}")`).waitFor({ timeout: 5000 });
  await sidepanel.locator(`button[aria-label="${zh.memory.settingsManage}"]`).click();
  await sidepanel.locator(`h2:has-text("${zh.memory.entryTitle}")`).waitFor({ timeout: 5000 });
  await sidepanel.locator("#memory-new-input").waitFor({ state: "visible", timeout: 5000 });

  // 添加
  await sidepanel.locator("#memory-new-input").fill("用户在减脂期,饮食建议注意热量");
  await sidepanel.getByRole("button", { name: zh.memory.addBtn, exact: true }).click();
  const row = sidepanel.locator("li").filter({ hasText: "减脂期" });
  await row.waitFor({ timeout: 5000 });
  let rows = await readMemories();
  check(
    rows.some((r) => r.text.includes("减脂期") && r.source === "user"),
    "T5-1 添加落库(source=user)",
  );

  // 行内编辑:点文本 → input → 改 → 回车提交
  await row.locator("button").first().click();
  const editInput = sidepanel.locator("ul li input");
  await editInput.waitFor({ timeout: 3000 });
  await editInput.fill("用户在减脂期,饮食建议注意热量与蛋白质");
  await editInput.press("Enter");
  await sidepanel
    .locator("li")
    .filter({ hasText: "蛋白质" })
    .waitFor({ timeout: 5000 });
  rows = await readMemories();
  check(
    rows.some((r) => r.text.includes("蛋白质")) &&
      !rows.some((r) => r.text.includes("热量与") && !r.text.includes("蛋白质")),
    "T5-2 行内编辑落库",
  );

  // 置顶
  const pinRow = sidepanel.locator("li").filter({ hasText: "蛋白质" });
  await pinRow.locator(`button[aria-label="${zh.memory.pin}"]`).click();
  await sidepanel
    .locator("li")
    .filter({ hasText: "蛋白质" })
    .locator(`button[aria-label="${zh.memory.unpin}"]`)
    .waitFor({ timeout: 5000 });
  rows = await readMemories();
  check(
    rows.find((r) => r.text.includes("蛋白质"))?.pinned === true,
    "T5-3 置顶落库",
  );

  // 两段确认删除
  const delRow = sidepanel.locator("li").filter({ hasText: "蛋白质" });
  await delRow.locator(`button[aria-label="${zh.memory.deleteOne}"]`).click();
  await delRow.locator(`button[aria-label="${zh.common.confirmDelete}"]`).click();
  await sidepanel
    .locator("li")
    .filter({ hasText: "蛋白质" })
    .waitFor({ state: "detached", timeout: 5000 });
  rows = await readMemories();
  check(
    !rows.some((r) => r.text.includes("蛋白质")),
    "T5-4 两段确认删除落库",
  );

  // 溢出菜单两段确认清空全部:Esc 只关菜单不关页;菜单收起即复位确认态
  await sidepanel.locator(`button[aria-label="${zh.memory.pageMenu}"]`).click();
  await sidepanel.locator('[role="menuitem"]').waitFor({ timeout: 3000 });
  await sidepanel.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 200));
  check(
    (await sidepanel.locator('[role="menuitem"]').count()) === 0 &&
      (await sidepanel.locator(`h2:has-text("${zh.memory.entryTitle}")`).count()) === 1,
    "T5-5 菜单打开时 Esc 只关菜单不关页",
  );
  await sidepanel.locator(`button[aria-label="${zh.memory.pageMenu}"]`).click();
  await sidepanel.locator('[role="menuitem"]').click();
  check(
    (await sidepanel.locator('[role="menuitem"]').textContent())?.includes(
      zh.memory.confirmClearAll,
    ) === true,
    "T5-6 清空首点进入确认态",
  );
  await sidepanel.locator('[role="menuitem"]').click();
  await sidepanel.getByText(zh.memory.empty).waitFor({ timeout: 5000 });
  rows = await readMemories();
  check(rows.length === 0, "T5-7 清空全部落库", `count=${rows.length}`);

  await sidepanel.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 300));
}

// ---- T8. 轻提示(面板 UI 驱动) ----
console.log("\n===== T8. 回复尾轻提示 =====");
{
  llm.mode = "save-fresh";
  await ask(sidepanel, "记住我喜欢用列表整理信息");
  await waitForRunLog(sidepanel, (e) => e.msg === "run ended", "run ended");
  const text = await uiText();
  check(
    text.includes(zh.chat.memorySavedLabel.replace("{n}", "1")),
    "T8-1 保存后渲染轻提示(整条键值填参)",
    text.slice(-200),
  );

  // 点击轻提示 → 直通记忆管理页
  await sidepanel.locator('button[aria-label*="已写入"]').click();
  await sidepanel.locator(`h2:has-text("${zh.memory.entryTitle}")`).waitFor({ timeout: 5000 });
  check(true, "T8-2 点击轻提示直通记忆管理页");
}

// ---- 汇总 ----
console.log("\n========================================");
if (failures.length > 0) {
  console.log("❌ VERDICT: FAIL —", failures.join("; "));
  await browser.close();
  process.exit(1);
}
console.log("✅ VERDICT: PASS");
await browser.close();
process.exit(0);
