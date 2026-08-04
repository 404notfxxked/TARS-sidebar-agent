// Agent Loop —— ReAct 循环(推理 → 行动 → 观察,直到给出最终答案)
// 运行在 service worker。只认识内部契约(provider/types),不认识任何 provider。

import { MSG, type AgentEvent, type UserMessagePayload } from "../shared/messages";
import { getTool, toProviderToolSchemas } from "./tools";
import { getChatProvider, type InternalMsg } from "./provider";
import { loadConfig } from "../shared/configStore";

const MAX_TURNS = 10;

const SYSTEM_PROMPT = `你是「随读」，一个跑在浏览器侧栏里的文档答疑助手。
用户边阅读网页边向你提问。规则：
1. 需要页面信息时，先用工具读取当前页面，不要凭空猜测。
2. 回答用中文，简洁、准确；能指出信息来源（页面原文 / 工具返回 / 自身知识）。
3. 每一步只做必要的事：需要信息就调工具，能回答了就直接回答。`;

export interface AgentPort {
  postMessage: (event: AgentEvent) => void;
}

export async function runAgentLoop(
  payload: UserMessagePayload,
  port: AgentPort,
  signal?: AbortSignal, // 取消信号:index.ts 在 CANCEL_RUN / 端口断开时 abort
): Promise<void> {
  // 先告诉前端「开始执行了」,让它先有反馈(配置读取和网络请求在后)
  port.postMessage({
    type: MSG.AGENT_STARTED,
    sessionId: payload.sessionId ?? "",
  });

  try {
    // 从 storage 读配置 → 按配置构建对应的 provider 适配器
    const config = await loadConfig();
    if (!config.apiKey) {
      port.postMessage({
        type: MSG.AGENT_ERROR,
        error: "请先在设置里配置 API Key",
      });
      return;
    }

    const provider = getChatProvider(config);
    const tools = toProviderToolSchemas();

    const messages: InternalMsg[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: payload.text },
    ];

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      // 告诉前端开始思考了,前端可以展示「思考中…」
      port.postMessage({ type: MSG.AGENT_THINKING, turn });

      const result = await provider.chat({
        messages,
        tools,
        onDelta: (delta) =>
          // 流式把输出推给前端
          port.postMessage({ type: MSG.AGENT_MESSAGE, delta }),
        signal,
      });

      // 模型要调用工具 → 执行并回填观察结果,进入下一轮
      if (result.toolCalls.length > 0) {
        messages.push({
          role: "assistant",
          content: result.content || null,
          toolCalls: result.toolCalls,
        });

        for (const tc of result.toolCalls) {
          port.postMessage({ type: MSG.AGENT_TOOL_CALL, name: tc.name, args: tc.args });

          // 工具失败不中断整个 agent:把错误文本作为观察结果回填,
          // 让模型看到失败原因后换工具 / 换参数 / 直接回答
          let toolResult: unknown;
          try {
            toolResult = await dispatchToolCall(tc.name, tc.args);
          } catch (err) {
            toolResult = `Error: ${err instanceof Error ? err.message : String(err)}`;
          }

          port.postMessage({ type: MSG.AGENT_TOOL_RESULT, name: tc.name, result: toolResult });
          messages.push({
            role: "tool",
            toolCallId: tc.id,
            content: stringifyResult(toolResult),
          });
        }
        continue;
      }

      // 没有工具调用 → 这就是最终回答
      break;
    }

    port.postMessage({ type: MSG.AGENT_DONE });
  } catch (err) {
    // 用户取消 → 静默结束,不算错误(wrapPort 也会拒绝再发事件)
    if (signal?.aborted) return;
    const message = err instanceof Error ? err.message : String(err);
    port.postMessage({ type: MSG.AGENT_ERROR, error: message });
  }
}

/** 工具分发:所有工具都在注册表里(content 工具也注册成 execute 调 content script) */
async function dispatchToolCall(name: string, args: unknown): Promise<unknown> {
  const tool = getTool(name);
  if (!tool) throw new Error(`unknown tool: ${name}`);
  return await tool.execute(args);
}

/** 工具结果转成可回填的字符串(LLM 收到的 observation) */
function stringifyResult(r: unknown): string {
  if (typeof r === "string") return r;
  try {
    return JSON.stringify(r);
  } catch {
    return String(r);
  }
}
