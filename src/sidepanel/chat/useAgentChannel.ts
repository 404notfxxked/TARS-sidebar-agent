// 面板 ⇄ SW 的 agent 通道:port 连接、事件分发、会话与消息状态、本轮执行流。
// 从 ChatView 拆出的状态层 —— ChatView 只留接线与布局(渲染 + 输入区),
// 所有「消息怎么来、会话怎么切、run 怎么收口」的机制都在这个 hook 里。
// delta 顺序有保证:后台 readSSE 按序处理事件,port 单通道 FIFO 送达。
// 事件监听器只注册一次,闭包停留在首帧 —— run.* 操作内部走 ref 读最新状态,
// setState 一律函数式或稳定 setter,首帧闭包因此安全。

import { useEffect, useRef, useState } from "react";
import {
  MSG,
  PORT_NAME,
  type AgentEvent,
  type CompactionMark,
  type ImageMeta,
  type ProcessItem,
} from "../../shared/messages";
import { getActiveTabId } from "../../shared/contentTools";
import { createLogger } from "../../shared/logger";
import {
  failPendingImages,
  resolveImageData,
  setImageSender,
  type PendingImage,
} from "./images";
import { useRunSegments } from "./useRunSegments";

// 面板侧只记时间线锚点(port 断开/取消/提交),事件细节以后台日志为准
const log = createLogger({ ctx: "panel" });

export interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  /** 所属会话:多会话各自隔离,同屏只渲染 currentSession 的消息 */
  sessionId: string;
  /** 随消息发送的图片(元数据;字节经 GET_IMAGE/IMAGE_DATA 单独取) */
  images?: ImageMeta[];
  /** 后台报错:以 ErrorBubble 呈现,不走 markdown */
  error?: boolean;
  /** 系统运行提示(如步数耗尽/连接中断):以 NoticeBubble 呈现 */
  notice?: boolean;
  /** 提示语种类(NoticeBubble 按此取文案;缺省 = 步数耗尽) */
  noticeKind?: "max-turns" | "disconnected" | "truncated";
  /** 后台注入的伪 user 消息(截图附件注记):只展示图片,不作用户气泡 */
  synthetic?: true;
  /** 纯过程行(历史回放带,与 ChatRecord 同步):该 run 没有收尾记录
   *  (取消/SW 被杀),过程卡独立成卡、无气泡 */
  processOnly?: true;
  /** 该 run 的过程数据(历史回放带):渲染为过程卡,与实况过程卡同构 */
  processItems?: ProcessItem[];
  /** 该消息在库里的 seq(仅历史回放有;压缩分隔条据此定位) */
  seq?: number;
}

export type AgentStatus = "idle" | "thinking" | "streaming";

export type ConfirmRequest = Extract<
  AgentEvent,
  { type: typeof MSG.AGENT_CONFIRM_REQUEST }
>;

/** 用户消息的提交参数:文本 + 本次提问的页面上下文 + 待发图片附件。
 *  附件借 PendingImage 形状(元数据 + 预览 url + wire 用 base64) */
export interface SubmitArgs {
  sessionId: string;
  tabId?: number;
  text: string;
  images?: PendingImage[];
}

/**
 * agent 通道 hook。resumeSessionId/onResumeDone:历史列表选中的会话由
 * App 转交,消费完回调置空(空串也是有效选择 = 新对话)。
 */
export function useAgentChannel({
  resumeSessionId,
  onResumeDone,
}: {
  resumeSessionId: string | null;
  onResumeDone: () => void;
}) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  // 当前会话的压缩点(存在 = 更早的历史已压成摘要,列表里渲染分隔条)
  const [compaction, setCompaction] = useState<CompactionMark | null>(null);
  /** 本轮已写入的记忆条数(memory_save 成功且非重复时累计);回复尾轻提示用 */
  const [memorySaved, setMemorySaved] = useState(0);
  const [status, setStatus] = useState<AgentStatus>("idle");
  /** 待答复的写操作确认请求:非空 = 输入区上方弹确认卡(拒绝/超时由后台兜底) */
  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null);
  const [currentSession, setCurrentSession] = useState("");
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const sessionRef = useRef("");
  // 最近一次已加载历史的会话,防重复请求
  const lastLoadedSessionRef = useRef("");
  // status 的 ref 镜像:port 监听器只注册一次,断连处理等闭包读不到最新 state
  const statusRef = useRef<AgentStatus>("idle");
  const updateStatus = (s: AgentStatus) => {
    statusRef.current = s;
    setStatus(s);
  };
  // ---- 断连重同步:run 期间 port 断过 = 后台被杀过,本地视图可能停在
  // 截断处,而库里有完整落盘(每轮收口即存)。下次 connect()(用户的下一
  // 个动作必然触发)时带 resync 拉库,空闲且期间无本地动作才按库替换。
  // actionSeq 本地动作计数:断连时刻快照基线,回包时比对 —— 断连后发生过
  // 提交/重答等本地动作 → 本地更新鲜,迟到的重同步响应作废。
  // 快照必须在断连时采,不能在发送 resync 时采:触发 connect 的那个动作
  // (提交/重答)本身就是本地变更,发送时采快照会把它算进基线,守卫恒通过
  // resyncSessionRef:断连时的会话。期间切过会话则整个 resync 作废
  // (新会话的历史由 openSession 正常拉取,不需要也不该按旧会话对账)
  const resyncPendingRef = useRef(false);
  const actionSeqRef = useRef(0);
  const resyncSeqRef = useRef(-1);
  const resyncSessionRef = useRef("");

  // ---- 本轮执行流:状态机(hook)+ 归档出口(文本段 → messages) ----
  const run = useRunSegments((texts) => {
    const sid = sessionRef.current;
    setMessages((ms) => [
      ...ms,
      ...texts.map((s) => ({
        role: "assistant" as const,
        content: s,
        sessionId: sid,
      })),
    ]);
  });

  // ---- port 事件的 case 正文(拆自 connect 的 switch,语义逐字不变)。
  //  监听器只注册一次、闭包停留在首帧:这些函数访问的 setter 均稳定、
  //  可变状态一律经 ref(与拆分前的内联 case 同一约束,见文件头注) ----
  const applyStarted = (evt: Extract<AgentEvent, { type: typeof MSG.AGENT_STARTED }>) => {
    sessionRef.current = evt.sessionId;
    updateStatus("thinking");
    setMemorySaved(0); // 新一轮,轻提示重新累计
    run.onStarted();
  };

  const applyThinking = () => {
    run.onThinking();
    updateStatus("thinking");
  };

  const applyReasoning = (evt: Extract<AgentEvent, { type: typeof MSG.AGENT_REASONING }>) => {
    run.onReasoningDelta(evt.delta);
  };

  const applyMessage = (evt: Extract<AgentEvent, { type: typeof MSG.AGENT_MESSAGE }>) => {
    updateStatus("streaming");
    run.onMessageDelta(evt.delta);
  };

  const applyToolCall = (evt: Extract<AgentEvent, { type: typeof MSG.AGENT_TOOL_CALL }>) => {
    run.onToolCall(evt);
    updateStatus("thinking");
  };

  const applyConfirmRequest = (
    evt: Extract<AgentEvent, { type: typeof MSG.AGENT_CONFIRM_REQUEST }>,
  ) => {
    setConfirmReq(evt);
  };

  const applyToolResult = (evt: Extract<AgentEvent, { type: typeof MSG.AGENT_TOOL_RESULT }>) => {
    run.onToolResult(evt);
    // 记忆落库轻提示:成功的非重复保存累计,回复尾渲染「已写入 N 条」
    if (evt.name === "memory_save" && evt.ok) {
      const r = evt.result as { duplicate?: boolean } | null;
      if (!r?.duplicate) setMemorySaved((n) => n + 1);
    }
  };

  // AGENT_DONE:正常收口;步数耗尽/输出截断再补一条系统级提示
  const applyDone = (evt: Extract<AgentEvent, { type: typeof MSG.AGENT_DONE }>) => {
    run.onSettled();
    updateStatus("idle");
    setConfirmReq(null); // 确认卡随 run 收口清掉(超时拒绝后台已兜底)
    // 步数耗尽:模型已按收尾指令交代进展,这里再补一条系统级提示;
    // 输出截断:回答半截收束,同样明示
    if (evt.reason === "max-turns" || evt.reason === "truncated") {
      const kind = evt.reason;
      setMessages((ms) => [
        ...ms,
        {
          role: "assistant",
          content: "",
          sessionId: sessionRef.current,
          notice: true,
          noticeKind: kind,
        },
      ]);
    }
  };

  /** AGENT_ERROR:错误详情由后台日志记录,面板只负责呈现(独立错误样式,不走 markdown) */
  const applyError = (evt: Extract<AgentEvent, { type: typeof MSG.AGENT_ERROR }>) => {
    run.onSettled();
    updateStatus("idle");
    setConfirmReq(null);
    setMessages((ms) => [
      ...ms,
      {
        role: "assistant",
        content: evt.error,
        sessionId: sessionRef.current,
        error: true,
      },
    ]);
  };

  /** HISTORY:断连重同步对账 + 常规历史回填(两条路径,见各自注释) */
  const applyHistory = (evt: Extract<AgentEvent, { type: typeof MSG.HISTORY }>) => {
    // 断连重同步:run 期间后台被杀过 → 按库替换本地视图(库是全量
    // 真相,本地可能停在截断处)。请求发出后发生过任何本地动作
    // (提交/重答/切会话)→ 本地更新鲜,迟到的响应作废;
    // 响应会话 != 当前会话(请求后切走过)同样作废。
    // 内容无差异(断连时本来就空闲收尾)→ 不换不打扰
    if (evt.resync) {
      if (
        evt.sessionId !== sessionRef.current ||
        resyncSeqRef.current !== actionSeqRef.current
      ) {
        return;
      }
      const sid = sessionRef.current;
      setMessages((ms) => {
        const sig = (arr: ChatMsg[]) =>
          JSON.stringify(
            arr.map((m) => [m.role, m.content, m.images?.length ?? 0]),
          );
        const local = ms.filter((m) => m.sessionId === sid);
        const localContent = local.filter(
          (m) => m.noticeKind !== "disconnected",
        );
        const incoming = evt.messages.map((m) => ({
          ...m,
          sessionId: sid,
        }));
        const notice: ChatMsg = {
          role: "assistant",
          content: "",
          sessionId: sid,
          notice: true,
          noticeKind: "disconnected",
        };
        // 内容已一致且提示气泡在场 → 无事发生,不动
        if (
          sig(localContent) === sig(incoming) &&
          local.some((m) => m.noticeKind === "disconnected")
        ) {
          return ms;
        }
        return [...incoming, notice];
      });
      setCompaction(evt.compaction ?? null);
      return;
    }
    // 后端回的历史 → 填入该会话。回包自带 sessionId:只认「响应会话 ==
    // 当前会话」的包 —— 快速切会话时先到的旧回包不能盖上新会话的 id
    // (曾因回包无 sessionId、靠「最后请求 == 当前会话」推断而串台)。
    // 本地已有该会话记录则保留本地(本地更新过/正在用),idempotent。
    if (evt.sessionId === sessionRef.current) {
      setMessages((ms) => {
        if (ms.some((m) => m.sessionId === evt.sessionId)) return ms;
        return evt.messages.map((m) => ({ ...m, sessionId: evt.sessionId }));
      });
      setCompaction(evt.compaction ?? null);
      setCurrentSession(evt.sessionId);
    }
  };

  /** IMAGE_DATA:历史图片字节回填 → 换成 objectURL 交给气泡 */
  const applyImageData = (evt: Extract<AgentEvent, { type: typeof MSG.IMAGE_DATA }>) => {
    resolveImageData(evt);
  };

  /** port 断连:清连接与在途图片请求;run 在途 = 后台被杀,落袋为安 +
   *  落「断连中」提示,并采样 resync 基线(必须在断连时刻,理由见上头注) */
  const handlePortDisconnected = () => {
    log.warn("chat", "port disconnected");
    portRef.current = null;
    // 在途图片字节请求随连接死亡:按缺失收场,不让骨架屏永久转圈
    failPendingImages();
    // run 在途时断连 = 后台被杀,事件不会再来了:落袋为安 + 明示,
    // 不让用户盯着无声截断的回答。空闲时断连(后台闲置被回收)无感
    const runWasActive = statusRef.current !== "idle";
    run.onPortDisconnected();
    updateStatus("idle");
    setConfirmReq(null);
    if (runWasActive) {
      resyncPendingRef.current = true;
      resyncSessionRef.current = sessionRef.current;
      resyncSeqRef.current = actionSeqRef.current; // 断连时刻的动作基线
      setMessages((ms) =>
        ms.some((m) => m.noticeKind === "disconnected")
          ? ms
          : [
              ...ms,
              {
                role: "assistant" as const,
                content: "",
                sessionId: sessionRef.current,
                notice: true,
                noticeKind: "disconnected" as const,
              },
            ],
      );
    }
  };

  const connect = (): chrome.runtime.Port => {
    // 复用已有连接(没断开就不新建)
    if (portRef.current) return portRef.current;

    const port = chrome.runtime.connect({ name: PORT_NAME });
    portRef.current = port;

    // 事件分发:11 个 case 的正文都在上方 apply* 函数里(逐字搬移)
    port.onMessage.addListener((evt: AgentEvent) => {
      switch (evt.type) {
        case MSG.AGENT_STARTED:
          return applyStarted(evt);
        case MSG.AGENT_THINKING:
          return applyThinking();
        case MSG.AGENT_REASONING:
          return applyReasoning(evt);
        case MSG.AGENT_MESSAGE:
          return applyMessage(evt);
        case MSG.AGENT_TOOL_CALL:
          return applyToolCall(evt);
        case MSG.AGENT_CONFIRM_REQUEST:
          return applyConfirmRequest(evt);
        case MSG.AGENT_TOOL_RESULT:
          return applyToolResult(evt);
        case MSG.AGENT_DONE:
          return applyDone(evt);
        case MSG.AGENT_ERROR:
          return applyError(evt);
        case MSG.HISTORY:
          return applyHistory(evt);
        case MSG.IMAGE_DATA:
          return applyImageData(evt);
      }
    });

    port.onDisconnect.addListener(handlePortDisconnected);

    // 重连(上个动作触发的 connect):run 期间断过连 → 静默拉库对账,
    // 把本地视图补到落盘的完整处。空闲断连无需对账;期间切过会话同样
    // 不对账(新会话有自己的拉取路径)
    if (resyncPendingRef.current) {
      resyncPendingRef.current = false;
      const sid = resyncSessionRef.current;
      if (sid && sessionRef.current === sid && statusRef.current === "idle") {
        port.postMessage({ type: MSG.LOAD_HISTORY, sessionId: sid, resync: true });
      }
    }

    return port;
  };

  /** 打开面板 = 一律新会话(历史去列表找):会话 id 在首次提交时才生成,
   *  没发过消息就不会在后台产生空会话记录 */
  const resolveContext = async (): Promise<{
    tabId: number | undefined;
    sessionId: string;
  }> => {
    const tabId = await getActiveTabId();
    if (!sessionRef.current) sessionRef.current = crypto.randomUUID();
    return { tabId: tabId ?? undefined, sessionId: sessionRef.current };
  };

  // 加载某会话历史到面板(去重:同一会话不重复请求)
  const loadSessionHistory = (sessionId: string) => {
    if (sessionId === lastLoadedSessionRef.current) return;
    lastLoadedSessionRef.current = sessionId;
    connect().postMessage({ type: MSG.LOAD_HISTORY, sessionId });
  };

  // 从历史列表切回某会话:清空本地视图后向后端拉消息。
  // 空串 = 「新对话」入口:回到空白会话态,不发 LOAD_HISTORY,游标一并重置
  const openSession = (sessionId: string) => {
    if (status !== "idle") {
      log.warn("chat", "switch session ignored, run in progress", { sessionId });
      return;
    }
    if (sessionId === sessionRef.current) return; // 已是当前会话
    log.info("chat", "open session", { sessionId });
    actionSeqRef.current += 1; // 本地动作:未决的断连重同步作废
    setMessages([]);
    setCompaction(null);
    setMemorySaved(0);
    run.newRound();
    setCurrentSession(sessionId);
    sessionRef.current = sessionId;
    if (sessionId) {
      loadSessionHistory(sessionId);
    } else {
      lastLoadedSessionRef.current = "";
    }
  };

  // 历史列表选中 → 打开;消费完立刻回调置空,保证下次选同一会话仍能触发
  // (空串也是有效选择 = 新对话,因此判 null 而非判真值)
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只随 resumeSessionId 触发,回调非稳定引用
  useEffect(() => {
    if (resumeSessionId !== null) {
      openSession(resumeSessionId);
      onResumeDone();
    }
  }, [resumeSessionId]);

  // 挂载:建 port + 注册历史图片取字节的发送通道(ChatImage 组件经模块级
  // requestImgUrl 调用)。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅挂载执行;connect 每渲染换身份,入依赖会反复断连 port,其闭包经 ref 读最新状态
  useEffect(() => {
    connect();
    setImageSender((id) => connect().postMessage({ type: MSG.GET_IMAGE, id }));
    return () => {
      portRef.current?.disconnect();
      portRef.current = null;
    };
  }, []);

  // 面板可见性上报:任务完成通知以「面板是否不可见」为是否打扰的判据。
  // 走 ref 读端口(重连后仍指向最新),监听只注册一次
  useEffect(() => {
    const report = () => {
      try {
        portRef.current?.postMessage({
          type: MSG.PANEL_VISIBILITY,
          hidden: document.visibilityState === "hidden",
        });
      } catch {
        /* 端口已断开,无需上报 */
      }
    };
    report();
    document.addEventListener("visibilitychange", report);
    return () => document.removeEventListener("visibilitychange", report);
  }, []);

  const cancel = () => {
    log.info("chat", "cancel clicked", { sessionId: sessionRef.current });
    if (!sessionRef.current) return;
    connect().postMessage({
      type: MSG.CANCEL_RUN,
      sessionId: sessionRef.current,
    });
  };

  // 重新生成:末条答案退场,同问重答。本地乐观清场(本轮答案在 runSegs,
  // 末条 user 之后的本地气泡 = 历史答案/错误/系统提示一并退场),后台负责
  // 截库(自末条 user 行含)并以原内容重跑;技能 /name 原文随库重走解析
  const regenerate = () => {
    if (status !== "idle") return;
    const sid = sessionRef.current;
    if (!sid) return;
    log.info("chat", "regenerate", { sessionId: sid });
    actionSeqRef.current += 1; // 本地动作:未决的断连重同步作废
    run.newRound();
    setMemorySaved(0);
    // 乐观:AGENT_STARTED 马上到,思考态先亮起。走 updateStatus 同步 statusRef
    // (断连兜底与 resync 门控都读 ref,只 setStatus 会让 ref 停留在 idle)
    updateStatus("thinking");
    setMessages((ms) => {
      // 截断点 = 末条「真实」user:后台注入的截图注记行不算提问,
      // 否则重答会把系统注记文本当用户问题重发(与后台 prepareRegenerate 同规则)
      let lastUser = -1;
      ms.forEach((m, i) => {
        if (m.sessionId === sid && m.role === "user" && !m.synthetic) {
          lastUser = i;
        }
      });
      return lastUser === -1 ? ms : ms.slice(0, lastUser + 1);
    });
    connect().postMessage({ type: MSG.REGENERATE, sessionId: sid });
  };

  // 确认卡答复:把用户的决定带回后台,请求随即出列(等待超时由后台兜底拒绝)
  const answerConfirm = (approved: boolean) => {
    if (!confirmReq) return;
    log.info("chat", "confirm answered", { approved, name: confirmReq.name });
    connect().postMessage({
      type: MSG.CONFIRM_RESPONSE,
      requestId: confirmReq.requestId,
      approved,
    });
    setConfirmReq(null);
  };

  // 开始新对话:只清本地视图。旧会话原样留在历史列表(多会话语义,
  // 不再通知后台删除);下次提交才会生成新的会话 id
  const resetConversation = () => {
    if (status !== "idle") return; // 运行中不允许打断
    log.debug("chat", "new conversation", { old: sessionRef.current });
    actionSeqRef.current += 1; // 本地动作:未决的断连重同步作废
    setMessages([]);
    setCompaction(null);
    setMemorySaved(0);
    run.newRound(); // 对话清空,本轮执行流也不保留
    setCurrentSession("");
    // 重置所有会话游标,保证下一次加载历史 / 提交都从空会话开始
    sessionRef.current = "";
    lastLoadedSessionRef.current = "";
  };

  /** 提交用户消息:归档上一轮文本段 → 本地回显 → 开新一轮 → 发给后台。
   *  附件预览 url 需在调用前经 cacheImgUrl 入缓存(回显气泡直接渲染);
   *  输入框与待发附件的清理由视图侧自理 */
  const submitUserMessage = (opts: SubmitArgs) => {
    sessionRef.current = opts.sessionId;
    setCurrentSession(opts.sessionId);
    actionSeqRef.current += 1; // 本地动作:未决的断连重同步作废
    // 先归档上一轮文本段(保证它排在本条 user 消息之前),再清空执行流开新一轮
    run.archiveTexts();
    const metas = (opts.images ?? []).map(({ id, mime, w, h }) => ({
      id,
      mime,
      w,
      h,
    }));
    setMessages((ms) => [
      ...ms,
      {
        role: "user",
        content: opts.text,
        sessionId: opts.sessionId,
        ...(metas.length ? { images: metas } : {}),
      },
    ]);
    run.newRound(); // AGENT_STARTED 会再兜一次
    const uploads = (opts.images ?? []).map(({ mime, base64, w, h }) => ({
      mime,
      base64,
      w,
      h,
    }));
    connect().postMessage({
      type: MSG.USER_MESSAGE,
      payload: {
        text: opts.text,
        sessionId: opts.sessionId,
        tabId: opts.tabId,
        ...(uploads.length ? { images: uploads } : {}),
      },
    });
  };

  return {
    messages,
    compaction,
    memorySaved,
    status,
    confirmReq,
    currentSession,
    /** 本轮执行流(渲染层直接消费) */
    runSegs: run.runSegs,
    runPhase: run.runPhase,
    runEndedAt: run.runEndedAt,
    openGroups: run.openGroups,
    toggleGroup: run.toggleGroup,
    resolveContext,
    submitUserMessage,
    openSession,
    resetConversation,
    regenerate,
    cancel,
    answerConfirm,
  };
}
