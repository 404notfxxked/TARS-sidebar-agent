// sessionHistory 的投影与重答规则测试:后台注入的截图系统注记(SYSTEM_NOTE_PREFIX
// 前缀的伪 user 消息)全量落盘,但 —— 历史投影标 synthetic(面板不作真实用户
// 气泡渲染,曾因此把伪造的 user 信息当真展示)、重新生成的截断点跳过它
// (否则注记文本会被当用户问题重发)。纯 IDB 流程(fake-indexeddb),
// saveHistory → loadHistory / toChatRecords / prepareRegenerate 直测。

import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendMessages,
  clearAllRows,
  getSession,
  loadMessageRows,
} from "./sessionDb";
import {
  listSessions,
  loadHistory,
  loadTranscript,
  prepareRegenerate,
  saveHistory,
  toChatRecords,
} from "./sessionHistory";
import type { InternalMsg } from "../provider/types";
import type { ProcessItem } from "../../shared/messages";

/** 前缀即判定依据(agent.ts SCREENSHOT_NOTE 同源),正文内容无关紧要 */
const NOTE =
  "[System note: the page screenshot for the previous tool result is attached.]";

afterEach(async () => {
  await clearAllRows();
});

/** 一轮含截图的标准转写:真实提问 → 工具调用 → 注记带图 user → 最终回答 */
async function seedShotRun(sessionId: string) {
  await saveHistory(
    sessionId,
    [
      { role: "user", content: "<user-request>\n看看这个页面\n</user-request>" },
      {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "t1", name: "page_screenshot", args: {} }],
      },
      {
        role: "user",
        content: NOTE,
        images: [{ id: "img1", mime: "image/jpeg", w: 100, h: 80 }],
      },
      { role: "assistant", content: "这是总结" },
    ],
    0,
    0,
  );
}

describe("toChatRecords(历史投影)", () => {
  it("系统注记行标 synthetic,真实用户行不受影响,seq 保持稠密", async () => {
    await seedShotRun("s1");
    const records = toChatRecords(await loadHistory("s1"));
    // tool 消息与空 assistant 不投影:3 条 = 真实 user / 注记 user / 回答
    expect(records).toHaveLength(3);

    const [real, note, answer] = records;
    expect(real.role).toBe("user");
    expect(real.content).toBe("看看这个页面");
    expect(real.synthetic).toBeUndefined();

    expect(note.role).toBe("user");
    expect(note.synthetic).toBe(true);
    expect(note.content.startsWith("[System note:")).toBe(true);
    expect(note.images).toHaveLength(1);
    expect(note.seq).toBe(2);

    expect(answer.role).toBe("assistant");
    expect(answer.content).toBe("这是总结");
  });
});

describe("失败轮错误行(回放语义)", () => {
  it("投影带 error 标,prompt 转写滤除,落盘全量保留", async () => {
    await saveHistory(
      "s4",
      [
        { role: "user", content: "<user-request>\n查一下\n</user-request>" },
        { role: "assistant", content: "Error: HTTP 401 invalid api key", error: true },
      ],
      0,
      0,
    );
    const records = toChatRecords(await loadHistory("s4"));
    expect(records).toHaveLength(2);
    expect(records[1].role).toBe("assistant");
    expect(records[1].error).toBe(true);
    expect(records[1].content).toContain("401");

    // prompt 转写不含错误行;全量读取仍在
    const { prompt: transcript, rows } = await loadTranscript("s4");
    expect(transcript).toHaveLength(1);
    expect(transcript[0].role).toBe("user");
    // rows 是库行数(seq 锚点):错误行被滤掉但照样占着它的 seq
    expect(rows).toBe(2);
  });

  it("重新生成截掉错误行:还原真实提问", async () => {
    await saveHistory(
      "s5",
      [
        { role: "user", content: "<user-request>\n查一下\n</user-request>" },
        { role: "assistant", content: "Error: quota", error: true },
      ],
      0,
      0,
    );
    const payload = await prepareRegenerate("s5");
    expect(payload?.text).toBe("查一下");
    expect(await loadMessageRows("s5")).toHaveLength(0);
  });
});

describe("思考内容全量落盘、prompt 不剥离(展示元数据)", () => {
  it("全量落盘:loadHistory 保留 reasoning_content", async () => {
    await saveHistory(
      "s7",
      [
        { role: "user", content: "<user-request>\n问\n</user-request>" },
        {
          role: "assistant",
          content: "答",
          reasoning_content: "思考过程……",
          model: "m1",
        },
      ],
      0,
      0,
    );
    const rows = await loadHistory("s7");
    const a = rows[1] as Extract<InternalMsg, { role: "assistant" }>;
    expect(a.reasoning_content).toBe("思考过程……");
    expect(a.model).toBe("m1");
  });

  it("投影:assistant 行的思考聚合进 processItems 供回放过程卡", async () => {
    await saveHistory(
      "s9",
      [
        { role: "user", content: "<user-request>\n问\n</user-request>" },
        { role: "assistant", content: "答", reasoning_content: "思考" }, // i18n-ok:自播种 reasoning 内容,非 UI 断言
      ],
      0,
      0,
    );
    const records = toChatRecords(await loadHistory("s9"));
    expect(records[1].processItems).toEqual([{ kind: "reasoning", text: "思考" }]); // i18n-ok:断言种子往返不变形,非 UI 断言
    // prompt 转写不剥:DeepSeek 要求带 tools 时历轮 reasoning 都回传,
    // 最终回答行的思考同样要留着(缺失即 400,2026-09 修正)
    const { prompt: transcript } = await loadTranscript("s9");
    expect(
      transcript.some((m) => m.role === "assistant" && m.reasoning_content),
    ).toBe(true);
  });

  it("loadTranscript:工具行与回答行都保留 reasoning_content(DeepSeek 要求带 tools 时历轮回传)", async () => {
    await saveHistory(
      "s8",
      [
        { role: "user", content: "<user-request>\n问\n</user-request>" },
        {
          role: "assistant",
          content: null,
          toolCalls: [{ id: "t", name: "web_search", args: {} }],
          reasoning_content: "想……",
          model: "m1",
        },
        { role: "assistant", content: "答", reasoning_content: "答前的思考" },
        { role: "assistant", content: "Error: quota", error: true },
      ],
      0,
      0,
    );
    const { prompt: transcript } = await loadTranscript("s8");
    // 错误行滤除;工具行带 toolCalls/model 且 reasoning_content 原样保留,
    // 回答行不再被剥(此前「无 toolCalls 即剥」是组合任务 400 的一条独立根因)
    expect(transcript).toHaveLength(3);
    const toolRow = transcript[1] as Extract<InternalMsg, { role: "assistant" }>;
    expect(toolRow.toolCalls).toHaveLength(1);
    expect(toolRow.model).toBe("m1");
    expect(toolRow.reasoning_content).toBe("想……");
    const answerRow = transcript[2] as Extract<InternalMsg, { role: "assistant" }>;
    expect(answerRow.content).toBe("答");
    expect(answerRow.reasoning_content).toBe("答前的思考");
  });

  it("投影:多轮 run 的思考/工具聚合进收尾回答的 processItems,顺序正确", async () => {
    await saveHistory(
      "s10",
      [
        { role: "user", content: "<user-request>\n问\n</user-request>" },
        {
          role: "assistant",
          content: null,
          toolCalls: [{ id: "t1", name: "web_search", args: {} }],
          reasoning_content: "第一轮思考",
        },
        { role: "tool", toolCallId: "t1", content: "{}" },
        { role: "assistant", content: "答", reasoning_content: "最终思考" },
      ],
      0,
      0,
    );
    const records = toChatRecords(await loadHistory("s10"));
    // 中间轮不再单独投影:数据全部进收尾回答的 processItems
    expect(records).toHaveLength(2);
    expect(records[1].content).toBe("答");
    expect(records[1].processOnly).toBeUndefined();
    expect(records[1].processItems).toEqual([
      { kind: "reasoning", text: "第一轮思考" },
      { kind: "tool", id: "t1", name: "web_search", args: {}, result: "{}", error: false },
      { kind: "reasoning", text: "最终思考" },
    ]);
    // prompt 转写:工具行与回答行的思考都保留(DeepSeek 带 tools 时历轮回传)
    const { prompt: transcript } = await loadTranscript("s10");
    const aRows = transcript.filter(
      (m): m is Extract<InternalMsg, { role: "assistant" }> => m.role === "assistant",
    );
    expect(aRows[0]?.reasoning_content).toBe("第一轮思考");
    expect(aRows[1]?.reasoning_content).toBe("最终思考");
  });

  it("投影:服务端工具轮的多 text/thinking 块按 wire 原序分段,不并成一条", async () => {
    // 智谱(GLM)在 anthropic-messages 上的服务端搜索形态(2026-09 诊断导出实测):
    // 一轮里是 thinking|text|text|text 重复三轮(诊断日志的块形状),即 4 个思考块
    // 与 9 个文本块交替 —— 每轮「服务端工具块载体 + 模型自己的两段叙述文案」。
    // 适配器把同类块分别拼成 content / reasoning_content(段边界丢失),段序只留在
    // wireBlocks 里。实况按段渲染是分开的,回放必须还原同一批段;且同类相邻块在
    // 实况续写同一段(text delta 会续写当前文本段),所以相邻文本块并成一行
    await saveHistory(
      "s16",
      [
        { role: "user", content: "<user-request>\n查一下\n</user-request>" },
        {
          role: "assistant",
          content: "输入1输出1输入2输出2", // i18n-ok:自播种 wire 块文本,非 UI 断言
          reasoning_content: "想1想2想3", // i18n-ok:同上
          wireBlocks: [
            { type: "thinking", thinking: "想1" }, // i18n-ok:同上
            {
              type: "server_tool_use",
              id: "s1",
              name: "web_search_prime",
              input: { search_query: "q1" },
            },
            { type: "text", text: "输入1" }, // i18n-ok:同上
            { type: "text", text: "输出1" }, // i18n-ok:同上
            { type: "thinking", thinking: "想2" }, // i18n-ok:同上
            {
              type: "server_tool_use",
              id: "s2",
              name: "web_search_prime",
              input: { search_query: "q2" },
            },
            { type: "text", text: "输入2" }, // i18n-ok:同上
            { type: "text", text: "输出2" }, // i18n-ok:同上
            { type: "thinking", thinking: "想3" }, // i18n-ok:同上
          ],
          toolCalls: [{ id: "t1", name: "page_read", args: {} }],
        },
        { role: "tool", toolCallId: "t1", content: "obs" },
        { role: "assistant", content: "答" },
      ],
      0,
      0,
    );
    const items = toChatRecords(await loadHistory("s16"))[1].processItems ?? [];
    expect(items).toEqual([
      { kind: "reasoning", text: "想1" }, // i18n-ok:同上
      { kind: "text", text: "输入1输出1" }, // i18n-ok:同上
      { kind: "reasoning", text: "想2" }, // i18n-ok:同上
      { kind: "text", text: "输入2输出2" }, // i18n-ok:同上
      { kind: "reasoning", text: "想3" }, // i18n-ok:同上
      {
        kind: "tool",
        id: "t1",
        name: "page_read",
        args: {},
        result: "obs",
        error: false,
      },
    ]);
    // 服务端工具块在实况没有对应段(适配器不为它们发事件):回放同样不成行,
    // 也不断开相邻同类段
    expect(items.some((it) => it.kind === "tool" && it.name === "web_search_prime")).toBe(
      false,
    );
  });

  it("投影:纯 toolCalls 的工具轮也进收尾回答的过程卡", async () => {
    await saveHistory(
      "s11",
      [
        { role: "user", content: "<user-request>\n问\n</user-request>" },
        {
          role: "assistant",
          content: null,
          toolCalls: [{ id: "t1", name: "web_search", args: {} }],
        },
        { role: "tool", toolCallId: "t1", content: "{}" },
        { role: "assistant", content: "答" },
      ],
      0,
      0,
    );
    const records = toChatRecords(await loadHistory("s11"));
    expect(records).toHaveLength(2);
    expect(records[1].processItems).toEqual([
      { kind: "tool", id: "t1", name: "web_search", args: {}, result: "{}", error: false },
    ]);
  });

  it("投影:无收尾记录的 run(取消/被杀)由 processOnly 载体行成卡", async () => {
    await saveHistory(
      "s13",
      [
        { role: "user", content: "<user-request>\n问\n</user-request>" },
        {
          role: "assistant",
          content: null,
          toolCalls: [{ id: "t1", name: "get_tabs", args: {} }],
          reasoning_content: "想想",
        },
        { role: "tool", toolCallId: "t1", content: "{}" },
      ],
      0,
      0,
    );
    const records = toChatRecords(await loadHistory("s13"));
    expect(records).toHaveLength(2);
    expect(records[1].processOnly).toBe(true);
    expect(records[1].content).toBe("");
    expect(records[1].processItems).toEqual([
      { kind: "reasoning", text: "想想" },
      { kind: "tool", id: "t1", name: "get_tabs", args: {}, result: "{}", error: false },
    ]);
    // 列表条数不计载体行
    const sessions = await listSessions();
    expect(sessions.find((x) => x.id === "s13")?.msgCount).toBe(1);
  });

  it("投影:失败轮前的过程聚合进错误行(回放「过程卡 + 错误气泡」)", async () => {
    await saveHistory(
      "s14",
      [
        { role: "user", content: "<user-request>\n问\n</user-request>" },
        {
          role: "assistant",
          content: null,
          toolCalls: [{ id: "t1", name: "web_search", args: {} }],
        },
        { role: "tool", toolCallId: "t1", content: "Error: quota" },
        { role: "assistant", content: "Error: HTTP 500", error: true },
      ],
      0,
      0,
    );
    const records = toChatRecords(await loadHistory("s14"));
    expect(records).toHaveLength(2);
    expect(records[1].error).toBe(true);
    expect(records[1].processItems).toEqual([
      {
        kind: "tool",
        id: "t1",
        name: "web_search",
        args: {},
        result: "Error: quota",
        error: true,
      },
    ]);
  });

  it("投影:超长工具结果截断并标注体量,库里仍全量", async () => {
    const big = "x".repeat(13_000);
    await saveHistory(
      "s15",
      [
        { role: "user", content: "<user-request>\n问\n</user-request>" },
        {
          role: "assistant",
          content: null,
          toolCalls: [{ id: "t1", name: "page_read", args: {} }],
        },
        { role: "tool", toolCallId: "t1", content: big },
        { role: "assistant", content: "答" },
      ],
      0,
      0,
    );
    const items = toChatRecords(await loadHistory("s15"))[1].processItems ?? [];
    const toolItem = items[0] as Extract<ProcessItem, { kind: "tool" }>;
    expect(toolItem.result?.length).toBeLessThan(13_000);
    expect(toolItem.result).toContain("回放截断");
    const rows = await loadHistory("s15");
    expect(
      (rows[2] as Extract<InternalMsg, { role: "tool" }>).content,
    ).toHaveLength(13_000);
  });
});

describe("listSessions(列表条数口径)", () => {
  it("只数用户可见消息,tool/空 assistant/注记行不计", async () => {
    await saveHistory(
      "s6",
      [
        { role: "user", content: "<user-request>\n问\n</user-request>" },
        {
          role: "assistant",
          content: null,
          toolCalls: [{ id: "t1", name: "page_screenshot", args: {} }],
        },
        { role: "tool", toolCallId: "t1", content: "{}" },
        {
          role: "user",
          content: "[System note: attached screenshot]",
          images: [{ id: "img9", mime: "image/jpeg", w: 1, h: 1 }],
        },
        { role: "assistant", content: "答" },
      ],
      0,
      0,
    );
    const sessions = await listSessions();
    const s6 = sessions.find((x) => x.id === "s6");
    // 可见 = 提问 + 回答;tool 行 / 空 assistant / 注记伪 user 都不计
    expect(s6?.msgCount).toBe(2);
  });

  it("工具轮的中间正文不计条数;条数随追加递增、随重新生成截断扣回", async () => {
    const round1: InternalMsg[] = [
      { role: "user", content: "<user-request>\n问\n</user-request>" },
      {
        role: "assistant",
        // 工具轮带正文:回放里是过程卡内文案,不是气泡
        content: "我先看一下页面",
        toolCalls: [{ id: "t1", name: "page_read", args: {} }],
      },
      { role: "tool", toolCallId: "t1", content: "..." },
      { role: "assistant", content: "答" },
    ];
    const countOf = async () =>
      (await listSessions()).find((x) => x.id === "s7")?.msgCount;

    await saveHistory("s7", round1, 0, 0);
    expect(await countOf()).toBe(2);

    // 追加一轮(带真实提问):增量缓存 +2
    await saveHistory(
      "s7",
      [
        ...round1,
        { role: "user", content: "<user-request>\n追问\n</user-request>" },
        { role: "assistant", content: "答二" },
      ],
      4,
      4,
    );
    expect(await countOf()).toBe(4);

    // 重新生成截到「追问」:扣回该轮可见气泡
    const payload = await prepareRegenerate("s7");
    expect(payload?.text).toBe("追问");
    expect(await countOf()).toBe(2);
  });

  it("旧版本会话行(无 visibleCount 缓存):回落扫一次就回填,不再次次全量扫", async () => {
    // 直写会话行模拟旧版本数据(db 层不产展示口径缓存)
    await appendMessages(
      "s9",
      {
        id: "s9",
        title: "旧会话",
        createdAt: 1,
        updatedAt: 1,
        msgCount: 2,
      },
      [
        { role: "user", content: "<user-request>\n旧问\n</user-request>" },
        { role: "assistant", content: "旧答" },
      ],
      0,
      [],
    );

    const first = (await listSessions()).find((x) => x.id === "s9");
    expect(first?.msgCount).toBe(2); // 回落扫描的结果照常返回
    // 结果已回填:下次开列表命中缓存,不再逐会话读消息行
    expect((await getSession("s9"))?.visibleCount).toBe(2);
  });

  it("覆写路径(baseSeq 落在库区间内):条数按库重算,不因增量口径永久偏高", async () => {
    await saveHistory(
      "s11",
      [
        { role: "user", content: "<user-request>\n第一问\n</user-request>" },
        { role: "assistant", content: "第一答" },
      ],
      0,
      0,
    );
    expect((await listSessions()).find((x) => x.id === "s11")?.msgCount).toBe(2);

    // 模拟锚点回退:库里已有 2 行(msgCount=2)却从 seq 1 起写 ——
    // 覆写 seq1,新增 seq2。增量口径会算成 2+2=4,真实只有 3 条可见气泡
    await saveHistory(
      "s11",
      [
        { role: "user", content: "<user-request>\n第一问\n</user-request>" },
        { role: "user", content: "<user-request>\n第二问\n</user-request>" },
        { role: "assistant", content: "第二答" },
      ],
      1,
      1,
    );

    const rows = await loadMessageRows("s11");
    expect(rows.map((r) => r.seq)).toEqual([0, 1, 2]);
    expect((await getSession("s11"))?.visibleCount).toBe(3);
    expect((await listSessions()).find((x) => x.id === "s11")?.msgCount).toBe(3);
  });
});

describe("损坏行保序(数组下标 = seq 的地基)", () => {
  it("损坏行替换为 error 占位行,不跳位、不回灌 prompt", async () => {
    await saveHistory(
      "s8",
      [
        { role: "user", content: "<user-request>\n问\n</user-request>" },
        { role: "assistant", content: "答" },
      ],
      0,
      0,
    );
    // 直写一条坏行(模拟存储损坏),再走正常读取路径
    const session = (await getSession("s8"))!;
    await appendMessages("s8", { ...session, msgCount: 3 }, [null], 2, []);

    const rows = await loadHistory("s8");
    expect(rows).toHaveLength(3); // 占位保序,不跳位
    expect((rows[2] as { error?: true }).error).toBe(true);
    // prompt 转写滤除占位行(错误文本不回灌),回放投影保留错误语义
    expect((await loadTranscript("s8")).prompt).toHaveLength(2);
    // 占位行同样占 seq:行数口径必须按库算,否则追加写会从错的 seq 起
    expect((await loadTranscript("s8")).rows).toBe(3);
    expect(
      toChatRecords(rows).some((r) => r.role === "assistant" && r.error === true),
    ).toBe(true);
  });
});

describe("prepareRegenerate(重新生成的截断点)", () => {
  it("跳过系统注记行:还原真实提问,注记与其后的回答被截掉", async () => {
    await seedShotRun("s2");
    const payload = await prepareRegenerate("s2");
    // 重答负载是真实提问原文(解包裹),不是注记文本
    expect(payload?.text).toBe("看看这个页面");
    // 截断含真实 user 行本身(重跑会重新落盘);注记与回答一并删除
    const rows = await loadMessageRows("s2");
    expect(rows).toHaveLength(0);
  });

  it("全部是真实消息时行为不变:截到末条 user", async () => {
    await saveHistory(
      "s3",
      [
        { role: "user", content: "<user-request>\n第一问\n</user-request>" },
        { role: "assistant", content: "答一" },
        { role: "user", content: "<user-request>\n第二问\n</user-request>" },
        { role: "assistant", content: "答二" },
      ],
      0,
      0,
    );
    const payload = await prepareRegenerate("s3");
    expect(payload?.text).toBe("第二问");
    const rows = await loadMessageRows("s3");
    expect(rows).toHaveLength(2); // 前两轮保留
  });
});
