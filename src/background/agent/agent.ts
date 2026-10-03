import {
  MSG,
  type AgentEvent,
  type UserMessagePayload,
} from "../../shared/messages";
import type { ChatResult, InternalMsg, MessageImage } from "../provider";
import { errText } from "../../shared/errors";
import { createLogger } from "../../shared/logger";
import { persistFailure, persistNewMessages } from "./persistence";
import { createCallChat } from "./chatCall";
import { createDispatchToolCall } from "./toolDispatch";
import { assemblePrompt, resolveRunConfig } from "./runSetup";
import { runTurns } from "./loop";
import { needsConfirmation, type ConfirmGate } from "./confirmations";
import {
  clearToolExecutionContext,
  type ToolExecutionContext,
} from "../tools/toolContext";
const log = createLogger({ ctx: "bg" });

/** 一个 run 的可变状态:整个 run 只此一份,抽函数时以引用传递。
 *  经同一引用读写它的模块:persistence / imageProjection / loop 以本类型为
 *  第一参数,chatCall 以第二参数收;toolDispatch 刻意不收 loop —— 它不读写
 *  run 可变状态,只拿确认白名单的引用(见 toolDispatch.ts 头注)。
 *  ⚠️ messages 与三个落盘锚点(savedUpTo/persistedSeqs/persistedInCtx)**必须同生共死**——
 *  它们错位会覆写库里的行(2026-09 事故:失败轮 error 行被同会话追问写没)。
 *  ⚠️ emergency 是「发送投影」而非落盘状态:只影响请求投影的输入。 */
export interface RunLoopState {
  messages: InternalMsg[];
  persistedSeqs: number;
  /** run 开始时「已滤错误行」的库行数:压缩基线的切分基准(消费端的
   *  history 已滤错误行,同一索引空间)。persistedSeqs 是未滤口径,
   *  含错误行的会话里它 > 已滤行数,拿去切会把实测基线整轮丢弃 */
  libraryRowsAtStart: number;
  persistedInCtx: number;
  savedUpTo: number;
  /** 本 run 注入的 <user-memory> 消息(null = 记忆关)。落盘锚点不感知它
   *  —— 紧急压缩投影要靠它把记忆块重新插回请求(见 overflow.projectEmergency) */
  memoryMsg: InternalMsg | null;
  /** 随本轮 user 消息附带的图片(分配 id 后构建一次;只读,随 loop 传递) */
  runImages: MessageImage[];
  /** 本 run 内已水合的图片字节缓存(按 id):跨轮复用,避免每轮重读 IDB */
  imageBytes: Map<string, Uint8Array>;
  /** 撞窗紧急压缩后的发送投影:摘要插在 system 后,真实消息从 afterIdx 起。
   *  不 mutate messages —— 持久化锚点(persistedInCtx/persistedSeqs)不受影响 */
  emergency: { summaryMsg: InternalMsg; afterIdx: number } | null;
  /** 正在执行的轮次(catch 里报错时要带上下文) */
  turnNo: number;
  /** 循环是否以最终回答收束;false = 步数耗尽,循环外做收尾兜底 */
  completed: boolean;
  /** 最终回答撞到 max_tokens 截断(finish_reason=length):答案完整收束但
   *  内容半截,AGENT_DONE 以 truncated 收口让面板明示,不再谎报 complete */
  truncatedByLength: boolean;
  /** 最终轮请求的实测用量:run 结束存会话行,作下次压缩触发的实测基线 */
  lastUsage?: ChatResult["usage"];
  /** 失败轮错误行落盘的抓手(try 内赋值,catch 里调用;同 turnNo 的作用域
   *  理由)。取 null = 失败发生在首保存之前,连提问都还没落盘,无处可挂 */
  persistFailure: ((text: string) => Promise<void>) | null;
}

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

  // 一个 run 的可变状态全部收进 loop(接口 RunLoopState 见上):这里只放
  // 占位初值,try 内构建出真实值后就地写回;catch/finally 拿到的也是同一引用
  const loop: RunLoopState = {
    messages: [],
    persistedSeqs: 0,
    libraryRowsAtStart: 0,
    persistedInCtx: 0,
    savedUpTo: 0,
    memoryMsg: null,
    runImages: [],
    imageBytes: new Map(),
    emergency: null,
    turnNo: 0,
    completed: false,
    truncatedByLength: false,
    lastUsage: undefined,
    persistFailure: null,
  };

  // 工具执行上下文:整 run 一个对象,提交时捕获 tabId / 会话 / 取消信号。
  // dispatchToolCall 执行前重复 set 是并发 run 下重申归属(同一对象,
  // lastOperatedTabId 的跨轮记忆不丢);清理只在 run 收口统一做 ——
  // 1.2.0 只读工具并行后,per-call finally 置 null 会让先完成的工具
  // 砸掉兄弟工具的后置读取(get_tabs 的 defaultTabId、确认门的 tabId 解析)
  const toolCtx: ToolExecutionContext = {
    tabId: payload.tabId,
    sessionId: payload.sessionId ?? "",
    signal,
  };

  try {
    const cfg = await resolveRunConfig(payload, port);
    if (!cfg) return; // 前置校验失败:已发 AGENT_ERROR,整轮终止
    const fetchAllowlist = await assemblePrompt(cfg, loop, payload, signal);
    // 失败轮错误行的挂载点在这里赋值(首保存之前):此前失败 = 连提问都还没
    // 落盘,无处可挂 —— 赋值时机本身承担这个语义,不要挪
    loop.persistFailure = (text) => persistFailure(loop, payload.sessionId, text);

    // 首保存即落用户提问:第一轮请求挂起期间关面板/杀 SW,问题也不丢
    await persistNewMessages(loop, payload.sessionId);

    // 工具分发:注册表里的工具统一在这里执行。
    // 执行上下文在「真正执行前」重申归属:确认等待是跨 await 窗口,并发 run
    // 可能在窗口内覆盖全局单槽,确认返回后才 set 会砸不中 —— 所以 set 紧贴
    // execute(工具对 ctx 的读取都发生在自己执行体的同步开头,窗口内读不到别人的)。
    // 执行后不清理:并行批次下兄弟工具可能仍在读全局 ctx,清理由 run 收口的
    // finally 统一做
    // 共享确认门闭包:批次屏障(loop)与 dispatch 的门判定必须同源(契约点 1)
    // —— 在这里建一次,两处以同一实例消费,不许各自展开成 needsConfirmation(...)
    const confirmGate: ConfirmGate = (name, args) =>
      needsConfirmation(name, args, cfg.confirmLevel, fetchAllowlist);
    const dispatchToolCall = createDispatchToolCall(
      confirmGate,
      toolCtx,
      port,
      signal,
      fetchAllowlist,
    );

    const callChat = createCallChat(cfg, loop, port, signal);

    await runTurns(loop, {
      cfg,
      port,
      signal,
      sessionId: payload.sessionId,
      confirmGate,
      callChat,
      dispatchToolCall,
    });
  } catch (err) {
    // 用户取消 → 静默结束,不算错误(wrapPort 也会拒绝再发事件)
    if (signal?.aborted) {
      log.info("agent", "aborted by user — exiting silently", {
        sessionId: payload.sessionId,
        turn: loop.turnNo,
      });
      return;
    }
    const message = errText(err);
    log.error("agent", message, {
      sessionId: payload.sessionId,
      turn: loop.turnNo,
      stack: err instanceof Error ? err.stack : undefined,
    });
    // 失败轮落错误行:回放里这次提问不至于悬空(实况有错误气泡,回放原本
    // 只剩提问)。用户取消例外 —— 上面的 abort 分支已静默返回
    if (loop.persistFailure) await loop.persistFailure(message);
    port.postMessage({ type: MSG.AGENT_ERROR, error: message });
  } finally {
    // run 收口清理工具上下文:仅当全局仍是本 run 的对象(并发 run 下
    // 已被后来者覆盖时不越权清别人的)
    clearToolExecutionContext(toolCtx);
  }
}
