// SSE 流式解析(共享层):LLM chat 补全与 MCP streamable HTTP 响应共用同一套
// 帧解析与停滞看门狗 —— 脏形态(CRLF/多行 data/坏帧)的准绳在 chatCompletions.test.ts,
// 两处消费方必须保持同一种消化方式(此前 MCP 侧自己手写、漏了 CRLF 归一,
// 合规 CRLF 服务器的帧边界永远切不出来)。

import { createLogger } from "../../shared/logger";

const log = createLogger({ ctx: "bg" });

// 流中 inactivity watchdog:client 层超时只护到响应头,流中途断流
// (代理静默吞连接/端点挂起)会让 read() 永久悬挂。窗口取 120s ——
// 思考型模型两 delta 之间可以很久,但不会久到两分钟无任何字节
// (连心跳注释帧都算字节,正常端点撑不满这个窗口)
const STREAM_IDLE_TIMEOUT_MS = 120_000;

/**
 * 流式读取 SSE(Server-Sent Events)。
 *
 * 为什么流式:LLM 的回复是一点一点生成的,服务端把内容切成一串「事件」
 * 推送过来(每行以 `data:` 开头),客户端逐块读、边读边渲染 → 打字机效果。
 * 相比一次性等完整 JSON,流式能让用户立刻看到文字在输出。
 *
 * SSE 帧格式(每个事件之间用空行分隔):
 *   data: {"id":"...","choices":[{"delta":{"content":"你"}}]}
 *   data: {"id":"...","choices":[{"delta":{"content":"好"}}]}
 *   <空行>
 *   data: {"choices":[{"finish_reason":"stop"}]}
 *   data: [DONE]   ← 结束标记
 *
 * 注意:一次网络 read() 可能同时包含多个帧,也可能只包含半个帧,
 * 所以要用 buffer 攒着,按空行切出完整帧再解析,切剩下的留到下次。
 *
 * 兼容端点的三种脏形态都在这里消化:
 * - CRLF 行尾(规范允许 \r\n,某些代理/网关会改写):buffer 统一归一成 \n
 *   再切帧;孤立 \r 留在 buffer 里等下一个块的 \n 到齐,不会劈开帧
 * - 多行 data:(SSE 规范:一个事件可拆多行,按 \n 拼接成一整条载荷)
 * - 单帧 JSON 解析失败:跳过该帧 + warn 日志,不炸整个流 —— 流已开始,
 *   一帧脏数据没有重试的余地,丢弃远好于整轮失败
 */
/** 导出仅供单测:脏帧形态与看门狗的回归覆盖(idleTimeoutMs 注入短窗口) */
export async function* readSSE<T>(
  res: Response,
  idleTimeoutMs = STREAM_IDLE_TIMEOUT_MS,
): AsyncGenerator<T> {
  const reader = res.body!.getReader(); // 拿到响应体的可读流
  const decoder = new TextDecoder(); // 把二进制 Uint8Array 解码成字符串
  let buffer = ""; // 攒着还没凑成完整帧的残留数据
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  // 读一块字节,同时挂 120s 看门狗:窗口内没有任何字节到达(连注释
  // 心跳帧都算)即 abort。为什么不自动重试:流已开始,重放会重复
  // 已经发出去的 delta(UI 打字机与落库都接不上),只能报错交给人
  const readOrIdle = () =>
    Promise.race([
      reader.read().then((r) => {
        clearTimeout(idleTimer);
        return r;
      }),
      new Promise<never>((_, reject) => {
        idleTimer = setTimeout(
          () =>
            reject(
              new Error(
                `stream stalled: no bytes for ${idleTimeoutMs}ms (endpoint or proxy may have dropped the stream)`,
              ),
            ),
          idleTimeoutMs,
        );
      }),
    ]);

  try {
    while (true) {
      // 从流里读一段(可能很短,也可能很大);done=true 表示流结束了
      const { done, value } = await readOrIdle();
      if (done) break;
      // stream:true 表示流式解码,多字节字符跨块时会正确衔接
      buffer += decoder.decode(value, { stream: true });
      // CRLF 归一:必须在切帧前做,否则 "\r\n\r\n" 切不出 "\n\n" 帧边界。
      // 块尾孤立的 \r 先留着,下一个块的 \n 到齐后自然被这行归一吸收
      buffer = buffer.replace(/\r\n/g, "\n");

      // 按空行切出「完整帧」;最后一段可能还不完整,pop 出来留到下次
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        // 多行 data: 按规范拼成一整条载荷(事件可跨行写)
        const data = part
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (data === "[DONE]") return; // 结束标记,整个生成器到此结束
        if (!data) continue; // 纯注释/心跳帧
        let event: T;
        try {
          event = JSON.parse(data) as T;
        } catch {
          log.warn("sse", "跳过无法解析的 SSE 帧", {
            head: data.slice(0, 120),
          });
          continue;
        }
        yield event;
      }
    }
  } finally {
    clearTimeout(idleTimer);
    // 看门狗超时路径:挂起的 read() 不会自己醒,cancel 掉以释放底层连接;
    // 正常结束/[DONE] 早退路径 cancel 一个已关闭的流是无害 no-op
    reader.cancel().catch(() => {});
  }
}
