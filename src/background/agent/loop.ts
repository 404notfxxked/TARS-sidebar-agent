// ReAct 主循环:请求 → 推理观测回写 → 工具批次(并行执行/顺序回填/截图
// 附件/结果预算)→ turn 收口落盘;或最终回答收束;步数耗尽走 nudge 收尾,
// 定稿(尾部落盘 + 实测基线 + AGENT_DONE)。可变状态只经 loop 读写。

import { MSG } from "../../shared/messages";
import { SYSTEM_NOTE_PREFIX } from "./compaction";
import { saveCtx } from "../sessions/sessionHistory";
import { errText } from "../../shared/errors";
import { getTool } from "../tools/tools";
import {
  markReasoningObserved,
} from "../../shared/configStore";
import { stripScreenshot, takeScreenshot } from "../../shared/toolTypes";
import { createLogger } from "../../shared/logger";
import { enforceToolResultBudget } from "./tokenBudget";
import { needsConfirmation } from "./confirmations";
import { partitionToolBatches } from "./toolBatch";
import { redactToolArgsForLog } from "./toolLog";
import { stringifyResult } from "./format";
import { persistNewMessages } from "./persistence";
import type { CallChat } from "./chatCall";
import type { DispatchToolCall } from "./toolDispatch";
import type { RunCfg } from "./runSetup";
import type { AgentPort, RunLoopState } from "./agent";

const log = createLogger({ ctx: "bg" });

const MAX_TURNS = 10;

/** 截图附件随工具结果注入的 user 消息文本。必须以 SYSTEM_NOTE_PREFIX 开头:
 *  compaction 的整轮切分靠这个前缀识别「附件延续,不是新的一轮」 */
const SCREENSHOT_NOTE = `${SYSTEM_NOTE_PREFIX} the page screenshot for the previous tool result is attached to this message. Mark numbers on the image match the marks table in that result; use those selectors to act.]`;

// 步数耗尽后的收尾指令:只随最后一次「无工具」请求发送,不写入持久化历史。
// 目的:让模型向用户交代进展与剩余步骤,而不是被无声砍断在工具调用中间。
const WRAP_UP_NUDGE = `<system-note>本轮可用的推理步数已用完,工具调用已停用。请直接向用户说明:目前完成了什么、还剩什么没做。不要调用工具。用户发送「继续」后,你可以从当前进度接着做。</system-note>`;

/** 主循环的运行期依赖:只读配置与两个工厂产物(它们闭包了 provider/白名单)。 */
export interface TurnDeps {
  cfg: RunCfg;
  port: AgentPort;
  signal?: AbortSignal;
  /** 本轮用户提问所属会话(定稿落盘/日志用;面板首问时为 undefined) */
  sessionId: string | undefined;
  fetchAllowlist: Set<string>;
  callChat: CallChat;
  dispatchToolCall: DispatchToolCall;
}

export async function runTurns(
  loop: RunLoopState,
  deps: TurnDeps,
): Promise<void> {
  const { cfg, port, signal, sessionId, fetchAllowlist, callChat, dispatchToolCall } = deps;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    loop.turnNo = turn + 1;
    log.debug("agent", `turn ${turn + 1}/${MAX_TURNS}`);
    port.postMessage({ type: MSG.AGENT_THINKING, turn });

    const result = await callChat();
    loop.lastUsage = result.usage;

    // 推理能力观测回写(判定第 3 层):流里真见到 reasoning_content 而条目
    // 未标记 → 置位。幂等、fire-and-forget,失败不影响本轮回答
    if (
      result.reasoning_content !== undefined &&
      cfg.modelEntry?.reasoning === undefined
    ) {
      void markReasoningObserved(cfg.cur.id, cfg.config.model).catch((e) =>
        log.warn("agent", "推理标记回写失败", {
          err: errText(e),
        }),
      );
    }

    // 模型要调用工具 → 执行并回填观察结果,进入下一轮
    if (result.toolCalls.length > 0) {
      loop.messages.push({
        role: "assistant",
        content: result.content || null,
        toolCalls: result.toolCalls,
        ...(result.reasoning_content !== undefined
          ? { reasoning_content: result.reasoning_content }
          : {}),
        // 响应侧 wire 块(Anthropic 思考/服务端工具/带附加字段的文本):随每轮
        // 请求按适配器口径回传,顺序即协议语义(见 provider/types.ts WireBlock)。
        // 只在工具轮附上;最终回答行没有 wireBlocks,跨 run 的思考连续性由
        // reasoning_content 兜底(桥接端点据此合成 unsigned 思考块)
        ...(result.wireBlocks !== undefined
          ? { wireBlocks: result.wireBlocks }
          : {}),
        model: cfg.config.model,
      });

      // 批次执行:相邻只读工具批内并行,写工具/MCP 工具自成单批串行。
      // 需过确认门的调用(含 web_fetch 的私网/白名单未命中判定)是批次屏障:
      // 确认卡在面板是单槽,同批并发派发会让先到的确认请求不可见。
      // 「调用中」事件先整批发(面板过程卡同时亮起),结果按原始顺序回填
      for (const batch of partitionToolBatches(result.toolCalls, (tc) =>
        cfg.confirmActions && needsConfirmation(tc.name, tc.args, fetchAllowlist),
      )) {
        for (const tc of batch) {
          port.postMessage({
            type: MSG.AGENT_TOOL_CALL,
            id: tc.id,
            name: tc.name,
            displayName: getTool(tc.name)?.displayName,
            args: tc.args,
          });
        }
        const settled = await Promise.all(
          batch.map(async (tc) => {
            const startedAt = Date.now();
            // 工具失败不中断整个 agent:把错误文本作为观察结果回填,
            // 让模型看到失败原因后换工具 / 换参数 / 直接回答。
            // 结果原文进日志(截断脱敏由 logger 负责),供事后排查对比。
            // 用户取消例外:不再回填,快速上抛让外层静默退出
            try {
              const raw = await dispatchToolCall(tc.name, tc.args);
              // 截图附件先剥离:字节不进日志、不进 tool 消息
              const shot = takeScreenshot(raw);
              const toolResult = shot ? stripScreenshot(raw) : raw;
              log.info("tool", `${tc.name} 完成`, {
                ms: Date.now() - startedAt,
                args: redactToolArgsForLog(tc.name, tc.args),
                result: stringifyResult(toolResult),
              });
              return { tc, toolResult, shot, ok: true };
            } catch (err) {
              if (signal?.aborted) {
                // 取消不回填观察结果(run 即将静默退出,快速上抛),
                // 但留一条工具侧证据:取消发生在哪个工具、什么参数
                log.warn("tool", `${tc.name} 失败(取消)`, {
                  ms: Date.now() - startedAt,
                  args: redactToolArgsForLog(tc.name, tc.args),
                  error: "cancelled by user",
                });
                throw err;
              }
              const errMsg = errText(err);
              log.error("tool", `${tc.name} 失败`, {
                ms: Date.now() - startedAt,
                args: redactToolArgsForLog(tc.name, tc.args),
                error: errMsg,
              });
              return { tc, toolResult: `Error: ${errMsg}`, shot: null, ok: false };
            }
          }),
        );
        for (const { tc, toolResult, shot, ok } of settled) {
          port.postMessage({
            type: MSG.AGENT_TOOL_RESULT,
            id: tc.id,
            name: tc.name,
            ok,
            result: toolResult,
          });
          loop.messages.push({
            role: "tool",
            toolCallId: tc.id,
            content: stringifyResult(toolResult),
          });
          // OpenAI 协议的 tool 消息不支持 image_url:截图紧随一条带图
          // user 消息注入。字节留在内存走本轮落盘(persistableMsg 剥字节、
          // collectImageRows 收进 images store),后续轮次按需水合 ——
          // 与用户上传图完全同一条管线
          if (shot) {
            loop.messages.push({
              role: "user",
              content: SCREENSHOT_NOTE,
              images: [
                {
                  id: crypto.randomUUID(),
                  mime: shot.mime,
                  w: shot.w,
                  h: shot.h,
                  bytes: shot.bytes,
                },
              ],
            });
          }
          // 工具结果(网页窗口/搜索列表)是 run 内增长最快的部分,超预算时
          // 把最旧的大结果替换为省略标记 —— 结构不变(tool 配对完整),只瘦身
          enforceToolResultBudget(loop.messages, cfg.toolResultBudgetChars);
        }
      }
      // 本 turn 收口:assistant(toolCalls) 与全部工具结果已成对,是合法的
      // 停止边界,立即落盘
      await persistNewMessages(loop, sessionId);
      continue;
    }

    // 没有工具调用 → 这就是最终回答,写入历史后再退出
    loop.messages.push({
      role: "assistant",
      content: result.content,
      ...(result.reasoning_content !== undefined
        ? { reasoning_content: result.reasoning_content }
        : {}),
      model: cfg.config.model,
    });
    loop.truncatedByLength = result.finishReason === "length";
    loop.completed = true;
    break;
  }

  // 步数耗尽且没得到最终回答(最后一轮仍是工具调用)→ 强制一次「无工具」收尾。
  // 收尾指令只进这一次请求、不持久化;产出的 assistant 总结会写入历史,
  // 历史因此以 assistant 结尾 —— 下一条 user 消息直接接上,不会留下
  // tool 消息悬在历史末尾的非法结构(严格端点会拒收)。
  if (!loop.completed) {
    log.warn("agent", `max turns (${MAX_TURNS}) reached — wrapping up`, {
      sessionId,
    });
    port.postMessage({ type: MSG.AGENT_THINKING, turn: MAX_TURNS - 1 });
    // 收尾轮禁用工具(nudge 只随本次请求发送,不进持久化历史)
    const wrap = await callChat(
      [{ role: "user", content: WRAP_UP_NUDGE }],
      false,
    );
    loop.lastUsage = wrap.usage;
    loop.messages.push({
      role: "assistant",
      content: wrap.content,
      ...(wrap.reasoning_content !== undefined
        ? { reasoning_content: wrap.reasoning_content }
        : {}),
      model: cfg.config.model,
    });
  }

  // 本轮结束:把尚未落盘的尾部消息(最终回答 / 收尾总结)追加进持久化历史。
  // 前面每个 turn 收口已增量保存过,这里通常只剩最后一条 assistant
  // 只追加旧历史之后的新增部分:中途发生的溢出裁剪改掉了老消息的内容,
  // 不写回 —— 库里保持全量历史,每轮 prompt 在内存里重新裁
  if (sessionId) {
    await persistNewMessages(loop, sessionId);
    // 实测基线:最终轮请求的 prompt tokens + 当时的消息条数。下次 run 用
    // 它叠加新增部分算压缩触发基线,比纯估算准;失败不影响本次回答。
    // 撞窗紧急压缩发生过的轮次例外:promptTokens 是「摘要 + 尾部投影」的
    // 实测,而 msgs 记的是全量条数,两个口径对不上会让下次基线系统性低估
    // —— 宁可弃测回落纯估算,也不落一个错基线
    if (loop.lastUsage && !loop.emergency) {
      try {
        await saveCtx(sessionId, {
          promptTokens: loop.lastUsage.promptTokens,
          msgs: loop.messages.length - 1,
        });
      } catch (err) {
        log.warn("agent", "save ctx baseline failed", {
          error: errText(err),
        });
      }
    }
  }

  port.postMessage({
    type: MSG.AGENT_DONE,
    reason: loop.completed
      ? loop.truncatedByLength
        ? "truncated"
        : "complete"
      : "max-turns",
  });
}
