// 对话视图:经 port 连 SW,ReAct agent 的流式回复渲染

import { useEffect, useRef, useState, type ReactNode, type SubmitEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MSG, PORT_NAME, type AgentEvent } from "../shared/messages";
import { getActiveTabId } from "../shared/contentTools";
import { createLogger } from "../shared/logger";
import { getOrCreateSessionId } from "../shared/sessionStore";

// 面板侧只记时间线锚点(port 断开/取消/提交),事件细节以后台日志为准
const log = createLogger({ ctx: "panel" });

interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  /** 所属会话:全局单会话,与 tab 解耦(见 sessionStore) */
  sessionId: string;
}

type AgentStatus = "idle" | "thinking" | "streaming";

// ---- 本轮执行流(segments):思考段 / 文本段 / 工具段按到达顺序交错 ----
// 事件流本身按时序经单一 port FIFO 送达,前端只需按序落段即可交错渲染。
// 只属于「进行中 / 刚结束这轮」,不持久化;新一轮开始时文本段归档进 messages,过程段丢弃。

type ToolSeg = {
  kind: "tool";
  id: string;
  name: string;
  displayName?: string;
  args?: unknown;
  status: "running" | "done" | "error";
  result?: unknown;
  /** 创建时刻:过程卡分组计时用 */
  t: number;
};
type ReasoningSeg = {
  kind: "reasoning";
  text: string;
  /** 仍在流式生成中:驱动 ticker;阶段收口时置 false */
  active: boolean;
  /** settled 展开后的回看开关 */
  open?: boolean;
  t: number;
};
type TextSeg = { kind: "text"; text: string; t: number };
type RunSegment = ToolSeg | ReasoningSeg | TextSeg;
type ProcessSeg = ToolSeg | ReasoningSeg;

type ToolCallEvent = Extract<AgentEvent, { type: typeof MSG.AGENT_TOOL_CALL }>;
type ToolResultEvent = Extract<
  AgentEvent,
  { type: typeof MSG.AGENT_TOOL_RESULT }
>;

// 展开预览的截断阈值(字符):工具结果可达 12k,思考过程整段也不短,不整段渲染
const PREVIEW_CHARS = 200;
const REASONING_MAX_CHARS = 2000;

function formatTokens(n: number): string {
  if (n >= 1_000_000)
    return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

export default function ChatView({
  onOpenSettings,
}: {
  onOpenSettings: () => void;
}) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<AgentStatus>("idle");
  const [usage, setUsage] = useState<{ used: number; max: number } | null>(
    null,
  );
  const [currentSession, setCurrentSession] = useState("");
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const streamingRef = useRef(false);
  const sessionRef = useRef("");
  const historyReqRef = useRef("");
  const listRef = useRef<HTMLDivElement | null>(null);
  // 最近一次已加载历史的会话,防重复请求
  const lastLoadedSessionRef = useRef("");

  // ---- 本轮执行流状态:segs + ref 镜像 ----
  // ref 镜像让 port 事件回调(只注册一次)总是读到最新段序列,
  // 且允许一次事件里连贯地「读 → 变 → 写」,避免函数式 setState 里嵌套副作用
  const [runSegs, setRunSegs] = useState<RunSegment[]>([]);
  const runSegsRef = useRef<RunSegment[]>([]);
  const applySegs = (next: RunSegment[]) => {
    runSegsRef.current = next;
    setRunSegs(next);
  };
  /** live = 执行中(过程卡全展开);settled = 已结束(过程卡收成摘要 chip) */
  const [runPhase, setRunPhase] = useState<"live" | "settled">("settled");
  const runPhaseRef = useRef<"live" | "settled">("settled");
  const setPhase = (p: "live" | "settled") => {
    runPhaseRef.current = p;
    setRunPhase(p);
  };
  const [runEndedAt, setRunEndedAt] = useState<number | null>(null);
  /** 已展开回看的过程卡(以卡内首段在 segs 中的下标为 key,段序列只追加、下标即稳定身份) */
  const [openGroups, setOpenGroups] = useState<Set<number>>(new Set());

  // ---- 思考流缓冲:delta 先进缓冲,按固定节拍合入状态 ----
  // 流式期间只渲染单行 ticker(尾部内容),行高恒定不推挤后续消息;
  // 渲染频率从「每 delta 一次」降到 ~10Hz
  const reasoningBufRef = useRef("");
  const reasoningFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 把缓冲同步合入最后一个活跃思考段(节拍到期 / 阶段收口前调用) */
  const flushReasoning = () => {
    if (reasoningFlushRef.current !== null) {
      clearTimeout(reasoningFlushRef.current);
      reasoningFlushRef.current = null;
    }
    const buf = reasoningBufRef.current;
    if (!buf) return;
    reasoningBufRef.current = "";
    const segs = runSegsRef.current;
    const last = segs[segs.length - 1];
    if (last?.kind === "reasoning" && last.active) {
      applySegs([...segs.slice(0, -1), { ...last, text: last.text + buf }]);
    }
    // 活跃段已被收口(异常时序),缓冲无从归属,丢弃
  };

  /** 直接丢弃缓冲(新一轮开始 / 清空对话:旧缓冲不属于任何段) */
  const dropReasoningBuf = () => {
    if (reasoningFlushRef.current !== null) {
      clearTimeout(reasoningFlushRef.current);
      reasoningFlushRef.current = null;
    }
    reasoningBufRef.current = "";
  };

  // reasoning delta → 入缓冲;末段不是活跃思考段则先开新段(行立即出现,文本由节拍供给)
  const appendReasoning = (delta: string) => {
    reasoningBufRef.current += delta;
    const segs = runSegsRef.current;
    const last = segs[segs.length - 1];
    if (!(last?.kind === "reasoning" && last.active)) {
      applySegs([
        ...segs,
        { kind: "reasoning", text: "", active: true, t: Date.now() },
      ]);
    }
    if (reasoningFlushRef.current === null) {
      reasoningFlushRef.current = setTimeout(flushReasoning, 100);
    }
  };

  // 任何「下一阶段」事件(工具开始 / 文本开始)→ 先冲刷缓冲(别丢尾部字符),再收口活跃思考段
  const collapseReasoning = () => {
    flushReasoning();
    const segs = runSegsRef.current;
    if (segs.some((s) => s.kind === "reasoning" && s.active)) {
      applySegs(
        segs.map((s) =>
          s.kind === "reasoning" && s.active ? { ...s, active: false } : s,
        ),
      );
    }
  };

  /** 文本 delta:连续 delta 合并进末尾文本段,否则开新段(t 决定前一张过程卡的计时终点) */
  const appendTextDelta = (delta: string) => {
    const segs = runSegsRef.current;
    const last = segs[segs.length - 1];
    if (streamingRef.current && last?.kind === "text") {
      applySegs([...segs.slice(0, -1), { ...last, text: last.text + delta }]);
    } else {
      streamingRef.current = true;
      applySegs([...segs, { kind: "text", text: delta, t: Date.now() }]);
    }
  };

  const pushTool = (evt: ToolCallEvent) => {
    const segs = runSegsRef.current;
    applySegs([
      ...segs,
      {
        kind: "tool",
        id: evt.id,
        name: evt.name,
        displayName: evt.displayName,
        args: evt.args,
        status: "running",
        t: Date.now(),
      },
    ]);
  };

  const applyToolResult = (evt: ToolResultEvent) => {
    const segs = runSegsRef.current;
    if (!segs.some((s) => s.kind === "tool" && s.id === evt.id)) return;
    applySegs(
      segs.map((s) =>
        s.kind === "tool" && s.id === evt.id
          ? { ...s, status: evt.ok ? "done" : "error", result: evt.result }
          : s,
      ),
    );
  };

  /** 结束兜底:冲刷缓冲、归一残留 running 工具(防 spinner 卡死)、收口思考段、记录结束时刻 */
  const settleRun = () => {
    streamingRef.current = false;
    flushReasoning();
    const segs = runSegsRef.current;
    const next = segs.map((s) => {
      if (s.kind === "reasoning") return s.active ? { ...s, active: false } : s;
      if (s.kind === "tool")
        return s.status === "running" ? { ...s, status: "done" as const } : s;
      return s;
    });
    applySegs(next);
    setRunEndedAt(Date.now());
    setPhase("settled");
  };

  /** 归档:把本轮文本段依序转成 assistant 消息落回 messages。
   *  在追加下一条 user 消息之前调用,保证旧答案永远排在新问题之前;
   *  过程段不归档(不持久化),由随后的 clearRun 丢弃 */
  const flushRunTexts = () => {
    flushReasoning();
    streamingRef.current = false;
    const segs = runSegsRef.current;
    const texts = segs.filter((s): s is TextSeg => s.kind === "text");
    if (texts.length === 0) return;
    const sid = sessionRef.current;
    setMessages((ms) => [
      ...ms,
      ...texts.map((s) => ({
        role: "assistant" as const,
        content: s.text,
        sessionId: sid,
      })),
    ]);
    applySegs(segs.filter((s) => s.kind !== "text"));
  };

  /** 新一轮:清空段序列与回看开关 */
  const clearRun = () => {
    dropReasoningBuf();
    streamingRef.current = false;
    applySegs([]);
    setRunEndedAt(null);
    setOpenGroups(new Set());
    setPhase("live");
  };

  const toggleReasoning = (index: number) => {
    const segs = runSegsRef.current;
    const s = segs[index];
    if (s?.kind !== "reasoning") return;
    applySegs(
      segs.map((x, i) => (i === index ? { ...x, open: !s.open } : x)),
    );
  };

  const toggleGroup = (firstIdx: number) =>
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(firstIdx)) next.delete(firstIdx);
      else next.add(firstIdx);
      return next;
    });

  /** 会话全局唯一、与 tab 解耦;tabId 只随消息传递,作为工具执行的页面上下文 */
  const resolveContext = async (): Promise<{
    tabId: number | undefined;
    sessionId: string;
  }> => {
    const tabId = await getActiveTabId();
    return { tabId: tabId ?? undefined, sessionId: await getOrCreateSessionId() };
  };

  const connect = (): chrome.runtime.Port => {
    // 复用已有连接（没断开就不新建）
    if (portRef.current) return portRef.current;

    const port = chrome.runtime.connect({ name: PORT_NAME });
    portRef.current = port;

    // delta 顺序有保证:后台 readSSE 按序处理事件,port 单通道 FIFO 送达

    port.onMessage.addListener((evt: AgentEvent) => {
      switch (evt.type) {
        case MSG.AGENT_STARTED:
          sessionRef.current = evt.sessionId;
          setStatus("thinking");
          setUsage(null);
          // 新一轮开始:文本段归档兜底(正常在 submit 已做),过程段丢弃
          flushRunTexts();
          clearRun();
          break;
        case MSG.AGENT_THINKING:
          streamingRef.current = false; // 切断文本段,下一 delta 开新段
          setStatus("thinking");
          break;
        case MSG.AGENT_REASONING:
          appendReasoning(evt.delta);
          break;
        case MSG.AGENT_MESSAGE:
          // 文本开始 = 下一阶段:先收口思考段,再进段流式
          collapseReasoning();
          setStatus("streaming");
          appendTextDelta(evt.delta);
          break;
        case MSG.AGENT_TOOL_CALL:
          collapseReasoning();
          pushTool(evt);
          streamingRef.current = false;
          setStatus("thinking");
          break;
        case MSG.AGENT_TOOL_RESULT:
          applyToolResult(evt);
          break;
        case MSG.AGENT_DONE:
          settleRun();
          setStatus("idle");
          break;
        case MSG.AGENT_ERROR:
          // 错误详情由后台日志记录,面板只负责呈现
          settleRun();
          setStatus("idle");
          setMessages((ms) => [
            ...ms,
            {
              role: "assistant",
              content: `⚠ ${evt.error}`,
              sessionId: sessionRef.current,
            },
          ]);
          break;
        case MSG.AGENT_USAGE:
          setUsage({ used: evt.used, max: evt.max });
          break;
        case MSG.HISTORY:
          // 后端回的历史 → 填入该会话。
          // 仅当该会话在本地面板尚无记录时才填(本地有记录 = 本地更新过/正在用,保留本地);
          // 否则 idempotent,避免覆盖面板里已有的新消息。
          // 发起请求后会话已变(用户切走/抢先提交)则不切换 currentSession。
          if (historyReqRef.current === sessionRef.current) {
            setMessages((ms) => {
              const sid = historyReqRef.current;
              if (ms.some((m) => m.sessionId === sid)) return ms;
              return evt.messages.map((m) => ({ ...m, sessionId: sid }));
            });
            setCurrentSession(historyReqRef.current);
          }
          break;
      }
    });

    port.onDisconnect.addListener(() => {
      log.warn("chat", "port disconnected");
      portRef.current = null;
      streamingRef.current = false;
      // SW 休眠 / 刷新导致断开:run 已死,归一残留状态避免 UI 卡在 thinking;
      // 已结束(settled)的展示不动,用户可能正在回看
      if (runPhaseRef.current === "live") settleRun();
      setStatus("idle");
    });

    return port;
  };

  // 加载某会话历史到面板(去重:同一会话不重复请求)
  const loadSessionHistory = (sessionId: string) => {
    if (sessionId === lastLoadedSessionRef.current) return;
    historyReqRef.current = sessionId;
    lastLoadedSessionRef.current = sessionId;
    connect().postMessage({ type: MSG.LOAD_HISTORY, sessionId });
  };

  // 挂载时解析激活 tab 的会话,向后端拉取历史恢复显示
  useEffect(() => {
    const port = connect();
    resolveContext().then(({ sessionId }) => {
      sessionRef.current = sessionId;
      loadSessionHistory(sessionId);
    });
    return () => {
      streamingRef.current = false;
      dropReasoningBuf();
      port.disconnect();
      portRef.current = null;
    };
  }, []);

  // 新消息 / 段更新自动滚到底
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, runSegs, status]);

  const cancel = () => {
    log.info("chat", "cancel clicked", { sessionId: sessionRef.current });
    if (!sessionRef.current) return;
    connect().postMessage({
      type: MSG.CANCEL_RUN,
      sessionId: sessionRef.current,
    });
  };

  // 开始新对话:清掉后台该会话的历史 + 清空面板。
  // 全局单会话:清空后下次提问从空会话开始。
  const resetConversation = () => {
    if (status !== "idle") return; // 运行中不允许打断
    const old = sessionRef.current;
    log.debug("chat", "new conversation", { old });
    if (old) {
      connect().postMessage({ type: MSG.CLEAR_HISTORY, sessionId: old });
    }
    setMessages([]);
    setInput("");
    setUsage(null);
    clearRun(); // 对话清空,本轮执行流也不保留
    setCurrentSession("");
    // 重置所有会话游标,保证下一次加载历史 / 提交都从空会话开始
    sessionRef.current = "";
    historyReqRef.current = "";
    lastLoadedSessionRef.current = "";
  };

  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || status !== "idle") return;
    // 会话全局唯一;tabId 记录本次提问的页面上下文(工具去该 tab 执行)
    const { tabId, sessionId } = await resolveContext();
    sessionRef.current = sessionId;
    setCurrentSession(sessionId);
    log.info("chat", "submit", { text, sessionId, tabId });
    // 先归档上一轮文本段(保证它排在本条 user 消息之前),再清空执行流开新一轮
    flushRunTexts();
    setMessages((ms) => [...ms, { role: "user", content: text, sessionId }]);
    setInput("");
    clearRun(); // AGENT_STARTED 会再兜一次
    connect().postMessage({
      type: MSG.USER_MESSAGE,
      payload: { text, sessionId, tabId },
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex justify-end gap-1 px-4 pb-1 pt-3">
        <button
          type="button"
          onClick={resetConversation}
          aria-label="开始新对话"
          className="flex h-7 w-7 items-center justify-center rounded-[5px] text-[var(--muted)] transition-all duration-150 hover:bg-[var(--line)] hover:text-[var(--ink)] active:scale-90"
        >
          <PlusIcon />
        </button>
        <button
          type="button"
          onClick={onOpenSettings}
          aria-label="打开设置"
          className="flex h-7 w-7 items-center justify-center rounded-[5px] text-[var(--muted)] transition-all duration-150 hover:bg-[var(--line)] hover:text-[var(--ink)] active:scale-90"
        >
          <SettingsIcon />
        </button>
      </header>

      <div
        ref={listRef}
        className="flex-1 space-y-3 overflow-y-auto px-4 py-2 pb-1"
      >
        {(() => {
          const visible = messages.filter(
            (m) => m.sessionId === currentSession,
          );
          if (visible.length === 0 && status === "idle") return <EmptyState />;
          // 轨迹插在最后一条 user 消息之后:它是「当前这轮」的过程,
          // 本轮流式答案(assistant 气泡)自然排在轨迹后面;历史回放时 trace 为空不渲染
          const lastUserIdx = visible.reduce(
            (acc, m, i) => (m.role === "user" ? i : acc),
            -1,
          );
          return visible.flatMap((m, i) => {
            const node =
              m.role === "user" ? (
                <UserBubble key={i} text={m.content} />
              ) : (
                <AssistantBubble key={i} text={m.content} />
              );
            // 执行流插在最后一条 user 消息之后:按到达顺序交错渲染;
            // 历史回放时 segs 为空不渲染
            return i === lastUserIdx && runSegs.length > 0
              ? [
                  node,
                  <RunZone
                    key="run-zone"
                    segs={runSegs}
                    phase={runPhase}
                    endedAt={runEndedAt}
                    openGroups={openGroups}
                    onToggleGroup={toggleGroup}
                    onToggleReasoning={toggleReasoning}
                  />,
                ]
              : [node];
          });
        })()}
        {/* 网络等待等「无过程可看」时的活动指示;思考 ticker 存在时由 ticker 表达,不重复 */}
        {status === "thinking" &&
          !runSegs.some((s) => s.kind === "reasoning" && s.active) && (
            <div className="flex items-center gap-1.5 py-1 pl-1 text-[var(--muted)]">
              <span className="h-1 w-1 animate-pulse rounded-full bg-current" />
              <span className="h-1 w-1 animate-pulse rounded-full bg-current [animation-delay:150ms]" />
              <span className="h-1 w-1 animate-pulse rounded-full bg-current [animation-delay:300ms]" />
            </div>
          )}
      </div>

      {usage && (
        <div className="usage-bar px-4 py-1">
          <div className="usage-bar-track">
            <div
              className="usage-bar-fill"
              style={{
                width: `${Math.min((usage.used / usage.max) * 100, 100)}%`,
              }}
              data-usage-level={
                usage.used / usage.max < 0.5
                  ? "low"
                  : usage.used / usage.max < 0.8
                    ? "mid"
                    : "high"
              }
            />
          </div>
          <span className="usage-bar-label">
            {formatTokens(usage.used)} / {formatTokens(usage.max)}
          </span>
        </div>
      )}

      <form
        onSubmit={submit}
        className="input-pill mx-3 mb-3 rounded-2xl border border-[var(--line)] bg-white/75 shadow-md transition-all duration-200 focus-within:border-[var(--accent)] focus-within:shadow-lg"
      >
        <div className="flex items-center gap-2 px-3.5 py-2.5">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="读到什么，想问什么？"
            aria-label="提问"
            disabled={status !== "idle"}
            className="flex-1 bg-transparent py-1.5 text-[13px] text-[var(--ink)] outline-none placeholder:text-[var(--muted)] disabled:opacity-50"
          />
          {status === "idle" ? (
            <button
              type="submit"
              disabled={!input.trim()}
              aria-label="发送"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-[13px] leading-none text-white transition-all duration-150 hover:bg-[var(--accent-strong)] active:scale-90 disabled:opacity-25 disabled:scale-100"
            >
              ↑
            </button>
          ) : (
            <button
              type="button"
              onClick={cancel}
              aria-label="停止"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--danger)] text-white transition-all duration-150 hover:opacity-85 active:scale-90"
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                fill="currentColor"
              >
                <rect x="1.5" y="1.5" width="7" height="7" rx="1.2" />
              </svg>
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

function PlusIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <line x1="8" y1="3" x2="8" y2="13" />
      <line x1="3" y1="8" x2="13" y2="8" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      aria-hidden="true"
    >
      <line x1="2.5" y1="4" x2="13.5" y2="4" />
      <circle cx="6" cy="4" r="1.7" fill="currentColor" stroke="none" />
      <line x1="2.5" y1="8" x2="13.5" y2="8" />
      <circle cx="10.5" cy="8" r="1.7" fill="currentColor" stroke="none" />
      <line x1="2.5" y1="12" x2="13.5" y2="12" />
      <circle cx="5" cy="12" r="1.7" fill="currentColor" stroke="none" />
    </svg>
  );
}

function EmptyState() {
  return (
    <div className="px-2 py-10 text-center">
      <p className="mx-auto max-w-[220px] text-[16px] leading-relaxed text-[var(--muted)]">
        读到什么，想问什么，就在这里问。
        <br />
        我可以读取当前页面并回答。
      </p>
    </div>
  );
}

// ---- 执行流组件:内容 ⇆ 过程交错 ----

/** 本轮执行流渲染:连续的过程段(思考/工具)聚成一张过程卡,文本段渲染为气泡 */
function RunZone({
  segs,
  phase,
  endedAt,
  openGroups,
  onToggleGroup,
  onToggleReasoning,
}: {
  segs: RunSegment[];
  phase: "live" | "settled";
  endedAt: number | null;
  openGroups: Set<number>;
  onToggleGroup: (firstIdx: number) => void;
  onToggleReasoning: (index: number) => void;
}) {
  const parts: ReactNode[] = [];
  let group: { s: ProcessSeg; i: number }[] = [];
  const closeGroup = (endT: number) => {
    if (group.length === 0) return;
    const firstIdx = group[0].i;
    parts.push(
      <ProcessCard
        key={`g${firstIdx}`}
        entries={group}
        phase={phase}
        durationMs={Math.max(0, endT - group[0].s.t)}
        open={openGroups.has(firstIdx)}
        onToggle={() => onToggleGroup(firstIdx)}
        onToggleReasoning={onToggleReasoning}
      />,
    );
    group = [];
  };
  segs.forEach((s, i) => {
    if (s.kind === "text") {
      closeGroup(s.t); // 文本段开始 = 前一张过程卡计时截止
      parts.push(<AssistantBubble key={`t${i}`} text={s.text} />);
    } else {
      group.push({ s, i });
    }
  });
  closeGroup(endedAt ?? Date.now());
  return <>{parts}</>;
}

/** 过程卡:live 态展示工具行 + 活跃思考 ticker(已收口思考行隐藏,保紧凑);
 * settled 态收拢为一行摘要 chip,点击展开完整行回看 */
function ProcessCard({
  entries,
  phase,
  durationMs,
  open,
  onToggle,
  onToggleReasoning,
}: {
  entries: { s: ProcessSeg; i: number }[];
  phase: "live" | "settled";
  durationMs: number;
  open: boolean;
  onToggle: () => void;
  onToggleReasoning: (index: number) => void;
}) {
  if (phase === "live") {
    const rows = entries.filter(
      (e) => e.s.kind === "tool" || (e.s.kind === "reasoning" && e.s.active),
    );
    return (
      <div className="trace msg-in">
        {rows.map((e) =>
          e.s.kind === "reasoning" ? (
            <TickerRow key={`r${e.i}`} item={e.s} />
          ) : (
            <ToolRow key={e.s.id} item={e.s} />
          ),
        )}
      </div>
    );
  }
  const tools = entries
    .map((e) => e.s)
    .filter((s): s is ToolSeg => s.kind === "tool");
  const hasError = tools.some((t) => t.status === "error");
  const meta = tools.length
    ? `${tools.length} 步 · ${fmtDur(durationMs)}`
    : `思考 · ${fmtDur(durationMs)}`;
  const chain = summarizeChain(tools);
  return (
    <div className="trace msg-in" data-open={open}>
      <button
        type="button"
        className="trace-header trace-summary"
        onClick={onToggle}
        aria-expanded={open}
      >
        <span className="trace-icon" aria-hidden="true">
          {hasError ? <MarkError /> : <MarkOk />}
        </span>
        <span className="trace-summary-meta">{meta}</span>
        {chain && <span className="trace-summary-chain">{chain}</span>}
        <span className="trace-tail">
          <ChevronIcon />
        </span>
      </button>
      <div className="trace-rows-wrap">
        <div className="trace-rows">
          {entries.map((e) =>
            e.s.kind === "reasoning" ? (
              <ReasoningRow
                key={`r${e.i}`}
                item={e.s}
                onToggle={() => onToggleReasoning(e.i)}
              />
            ) : (
              <ToolRow key={e.s.id} item={e.s} />
            ),
          )}
        </div>
      </div>
    </div>
  );
}

/** 思考中 ticker:单行,只显示最近的尾部内容(节流刷新,不推挤布局) */
function TickerRow({ item }: { item: ReasoningSeg }) {
  return (
    <div className="trace-row" data-kind="reasoning" data-active="true">
      <div className="trace-line">
        <span className="trace-icon" aria-hidden="true">
          <SparkleIcon />
        </span>
        <span className="trace-label trace-shimmer">思考中</span>
        <span className="trace-tail-text" aria-hidden="true">
          {tailSlice(item.text)}
        </span>
      </div>
    </div>
  );
}

/** 已收口的思考行(settled 展开区内):一行「思考过程」,点击展开完整文本回看 */
function ReasoningRow({
  item,
  onToggle,
}: {
  item: ReasoningSeg;
  onToggle: () => void;
}) {
  const open = !!item.open;
  return (
    <div className="trace-row" data-kind="reasoning" data-open={open}>
      <button
        type="button"
        className="trace-header"
        onClick={onToggle}
        aria-expanded={open}
      >
        <span className="trace-icon" aria-hidden="true">
          <SparkleIcon />
        </span>
        <span className="trace-label">思考过程</span>
        <span className="trace-tail">
          <ChevronIcon />
        </span>
      </button>
      <div className="trace-body-wrap">
        <div className="trace-body">
          <div className="reasoning-text">
            {truncate(item.text, REASONING_MAX_CHARS)}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 工具行:名称 + 状态常显(对勾/叉以描边画入),参数/结果点击展开(摘要截断) */
function ToolRow({ item }: { item: ToolSeg }) {
  const [open, setOpen] = useState(false);
  const statusText =
    item.status === "running"
      ? "运行中"
      : item.status === "error"
        ? "失败"
        : "完成";
  return (
    <div
      className="trace-row"
      data-kind="tool"
      data-status={item.status}
      data-open={open}
    >
      <button
        type="button"
        className="trace-header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="trace-icon" aria-hidden="true">
          {item.status === "running" ? (
            <span className="trace-spinner" />
          ) : item.status === "error" ? (
            <MarkError />
          ) : (
            <MarkOk />
          )}
        </span>
        <span className="trace-label">{item.displayName ?? item.name}</span>
        <span className="trace-tail">
          <span className="trace-status">{statusText}</span>
          <ChevronIcon />
        </span>
      </button>
      <div className="trace-body-wrap">
        <div className="trace-body">
          <div className="trace-sec">参数</div>
          <pre className="trace-pre">
            {item.args === undefined
              ? "(无)"
              : truncate(stringifyPreview(item.args), PREVIEW_CHARS)}
          </pre>
          {item.result !== undefined && (
            <>
              <div className="trace-sec">
                {item.status === "error" ? "错误" : "结果"}
              </div>
              <pre className="trace-pre">
                {truncate(stringifyPreview(item.result), PREVIEW_CHARS)}
              </pre>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function MarkOk() {
  return (
    <svg
      className="trace-mark mark-ok"
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden="true"
    >
      <path d="M2.6 6.4 4.9 8.7 9.4 3.4" />
    </svg>
  );
}

function MarkError() {
  return (
    <svg
      className="trace-mark mark-error"
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden="true"
    >
      <path d="M3.2 3.2 8.8 8.8M8.8 3.2 3.2 8.8" />
    </svg>
  );
}

/** 毫秒 → 「5s」「1m03s」(下限 1s,避免闪 0s) */
function fmtDur(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/** 工具链摘要:连续同名合并 ×n,「查找元素 → 点击元素 → 读取章节×2」 */
function summarizeChain(tools: ToolSeg[]): string {
  const runs: { name: string; n: number }[] = [];
  for (const t of tools) {
    const name = t.displayName ?? t.name;
    const last = runs[runs.length - 1];
    if (last?.name === name) last.n += 1;
    else runs.push({ name, n: 1 });
  }
  return runs.map((r) => (r.n > 1 ? `${r.name}×${r.n}` : r.name)).join(" → ");
}

/** 四角星(SF Symbols sparkle 风):思考过程的图标 */
function SparkleIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 2.75C8.6 5.4 10.6 7.4 13.25 8 10.6 8.6 8.6 10.6 8 13.25 7.4 10.6 5.4 8.6 2.75 8 5.4 7.4 7.4 5.4 8 2.75Z" />
    </svg>
  );
}

/** 折叠指示箭头:单个 SVG,开合沿同一路径旋转(CSS 接管 transform) */
function ChevronIcon() {
  return (
    <svg
      className="trace-chevron"
      width="10"
      height="10"
      viewBox="0 0 12 12"
      aria-hidden="true"
    >
      <path d="M4.5 2.75 8.25 6 4.5 9.25" />
    </svg>
  );
}

/** unknown → 可展示文本:字符串原样,对象 JSON 美化,失败退 String() */
function stringifyPreview(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return String(v);
  }
}

/** ticker 单行容量(按显示宽度估算:CJK≈1 单位,西文≈0.55;≈220px @12px) */
const TAIL_WIDTH_UNITS = 17;

/** 思考 ticker:从尾部按显示宽度截取最近的单行内容,越界时前缀 … 标记截断 */
function tailSlice(s: string): string {
  let units = 0;
  let i = s.length;
  while (i > 0) {
    const cp = s.codePointAt(i - 1)!;
    const w = cp > 0x2e7f ? 1 : 0.55; // CJK 及全角记 1,其余记约半宽
    if (units + w > TAIL_WIDTH_UNITS) break;
    units += w;
    i -= cp > 0xffff ? 2 : 1;
  }
  const tail = s.slice(i).replace(/\s+$/, "");
  return i > 0 && tail ? `…${tail}` : tail;
}

/** 超长文本截断,尾部标注总字数 */
function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…(共 ${s.length} 字)` : s;
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="msg-in ml-auto w-fit max-w-[86%] rounded-xl rounded-br-md bg-[var(--accent-soft)] px-3.5 py-2 text-[13px] leading-relaxed shadow-[var(--shadow-sm)]">
      {text}
    </div>
  );
}

function AssistantBubble({ text }: { text: string }) {
  return (
    <div className="msg-in w-fit max-w-[86%] pl-3 text-[13px] leading-relaxed">
      <div className="markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </div>
    </div>
  );
}
