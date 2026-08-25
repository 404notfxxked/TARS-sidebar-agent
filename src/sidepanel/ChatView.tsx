// 对话视图:经 port 连 SW,ReAct agent 的流式回复渲染

import { useEffect, useRef, useState, type SubmitEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MSG, PORT_NAME, type AgentEvent } from "../shared/messages";
import { getActiveTabId } from "../shared/contentTools";
import { getOrCreateSessionId } from "../shared/sessionStore";

interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  /** 所属会话:全局单会话,与 tab 解耦(见 sessionStore) */
  sessionId: string;
}

type AgentStatus = "idle" | "thinking" | "streaming";

// ---- 执行轨迹(trace):当前轮的思考块 + 工具块,按时间序混合 ----
// 只属于「进行中这轮」,不持久化;新一轮(AGENT_STARTED / 提交)清空

type ToolTraceItem = {
  kind: "tool";
  id: string;
  name: string;
  displayName?: string;
  args?: unknown;
  status: "running" | "done" | "error";
  result?: unknown;
};
type ReasoningTraceItem = {
  kind: "reasoning";
  text: string;
  collapsed: boolean;
  /** 仍在流式生成中:驱动 shimmer 标题与光标;阶段收口时置 false */
  active: boolean;
};
type TraceItem = ToolTraceItem | ReasoningTraceItem;

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

  const [trace, setTrace] = useState<TraceItem[]>([]);

  // ---- 思考流缓冲:delta 先进缓冲,按固定节拍合入状态 ----
  // 流式期间只渲染单行 ticker(尾部内容),行高恒定不推挤后续消息;
  // 渲染频率从「每 delta 一次」降到 ~10Hz
  const reasoningBufRef = useRef("");
  const reasoningFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 把缓冲同步合入最后一个活跃思考块(节拍到期 / 阶段收口前调用) */
  const flushReasoning = () => {
    if (reasoningFlushRef.current !== null) {
      clearTimeout(reasoningFlushRef.current);
      reasoningFlushRef.current = null;
    }
    const buf = reasoningBufRef.current;
    if (!buf) return;
    reasoningBufRef.current = "";
    setTrace((ts) => {
      const last = ts[ts.length - 1];
      if (last?.kind === "reasoning" && last.active) {
        return [...ts.slice(0, -1), { ...last, text: last.text + buf }];
      }
      return ts; // 活跃块已被收口(异常时序),缓冲无从归属,丢弃
    });
  };

  /** 直接丢弃缓冲(新一轮开始 / 清空对话:旧缓冲不属于任何块) */
  const dropReasoningBuf = () => {
    if (reasoningFlushRef.current !== null) {
      clearTimeout(reasoningFlushRef.current);
      reasoningFlushRef.current = null;
    }
    reasoningBufRef.current = "";
  };

  // reasoning delta → 入缓冲;无活跃思考块则先开块(行立即出现,文本由节拍供给)
  const appendReasoning = (delta: string) => {
    reasoningBufRef.current += delta;
    setTrace((ts) => {
      const last = ts[ts.length - 1];
      return last?.kind === "reasoning" && last.active
        ? ts
        : [
            ...ts,
            { kind: "reasoning", text: "", collapsed: false, active: true },
          ];
    });
    if (reasoningFlushRef.current === null) {
      reasoningFlushRef.current = setTimeout(flushReasoning, 100);
    }
  };

  // 任何「下一阶段」事件(工具开始 / 内容开始)→ 先冲刷缓冲(别丢尾部字符),再收口所有思考块
  const collapseReasoning = () => {
    flushReasoning();
    setTrace((ts) =>
      ts.some((t) => t.kind === "reasoning" && (t.active || !t.collapsed))
        ? ts.map((t) =>
            t.kind === "reasoning"
              ? { ...t, collapsed: true, active: false }
              : t,
          )
        : ts,
    );
  };

  const pushTool = (evt: ToolCallEvent) =>
    setTrace((ts) => [
      ...ts,
      {
        kind: "tool",
        id: evt.id,
        name: evt.name,
        displayName: evt.displayName,
        args: evt.args,
        status: "running",
      },
    ]);

  const applyToolResult = (evt: ToolResultEvent) =>
    setTrace((ts) =>
      ts.map((t) =>
        t.kind === "tool" && t.id === evt.id
          ? { ...t, status: evt.ok ? "done" : "error", result: evt.result }
          : t,
      ),
    );

  // 结束兜底:先冲刷缓冲,再把残留 running 工具归一为 done(防 spinner 卡死),思考块收口
  const settleTrace = () => {
    flushReasoning();
    setTrace((ts) => {
      let changed = false;
      const next = ts.map((t) => {
        if (t.kind === "reasoning" && (!t.collapsed || t.active)) {
          changed = true;
          return { ...t, collapsed: true, active: false };
        }
        if (t.kind === "tool" && t.status === "running") {
          changed = true;
          return { ...t, status: "done" as const };
        }
        return t;
      });
      return changed ? next : ts;
    });
  };

  const toggleReasoning = (index: number) =>
    setTrace((ts) =>
      ts.map((t, i) =>
        t.kind === "reasoning" && i === index
          ? { ...t, collapsed: !t.collapsed }
          : t,
      ),
    );

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
    console.log("[chat] port connected");

    // delta 顺序有保证:后台 readSSE 按序处理事件,port 单通道 FIFO 送达
    const appendDelta = (delta: string) => {
      if (!streamingRef.current) {
        streamingRef.current = true;
        setMessages((ms) => [
          ...ms,
          { role: "assistant", content: delta, sessionId: sessionRef.current },
        ]);
      } else {
        setMessages((ms) => {
          const last = ms[ms.length - 1];
          if (last?.role === "assistant") {
            return [
              ...ms.slice(0, -1),
              { ...last, content: last.content + delta },
            ];
          }
          // 防御分支:正常流式时最后一条必是 assistant,走上面合并;走不到这里
          return [
            ...ms,
            {
              role: "assistant",
              content: delta,
              sessionId: sessionRef.current,
            },
          ];
        });
      }
    };
    const finalize = () => {
      streamingRef.current = false;
    };

    port.onMessage.addListener((evt: AgentEvent) => {
      switch (evt.type) {
        case MSG.AGENT_STARTED:
          sessionRef.current = evt.sessionId;
          console.log("[chat] agent started, sessionId:", evt.sessionId);
          setStatus("thinking");
          setUsage(null);
          // 新一轮开始:上一轮轨迹不保留(过程不持久化),旧缓冲一并丢弃
          dropReasoningBuf();
          setTrace([]);
          break;
        case MSG.AGENT_THINKING:
          console.log("[chat] agent thinking, turn:", evt.turn);
          finalize();
          setStatus("thinking");
          break;
        case MSG.AGENT_REASONING:
          appendReasoning(evt.delta);
          break;
        case MSG.AGENT_MESSAGE:
          // 内容开始 = 下一阶段:折叠思考块,再走现有流式逻辑
          collapseReasoning();
          setStatus("streaming");
          appendDelta(evt.delta);
          break;
        case MSG.AGENT_TOOL_CALL:
          console.log("[chat] tool call:", evt.name);
          collapseReasoning();
          pushTool(evt);
          finalize();
          setStatus("thinking");
          break;
        case MSG.AGENT_TOOL_RESULT:
          applyToolResult(evt);
          break;
        case MSG.AGENT_DONE:
          console.log("[chat] agent done");
          finalize();
          settleTrace();
          setStatus("idle");
          break;
        case MSG.AGENT_ERROR:
          console.log("[chat] agent error:", evt.error);
          finalize();
          settleTrace();
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
      console.log("[chat] port disconnected");
      portRef.current = null;
      streamingRef.current = false;
      // SW 休眠 / 刷新导致断开时,重置状态,避免 UI 卡在 thinking
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

  // 新消息 / 轨迹更新自动滚到底
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, trace, status]);

  const cancel = () => {
    console.log("[chat] cancel clicked, sessionId:", sessionRef.current);
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
    console.log("[chat] new conversation, old session:", old);
    if (old) {
      connect().postMessage({ type: MSG.CLEAR_HISTORY, sessionId: old });
    }
    setMessages([]);
    setInput("");
    setUsage(null);
    dropReasoningBuf();
    setTrace([]); // 对话清空,上一轮轨迹也不保留
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
    console.log(
      "[chat] submit, text:",
      text,
      "session:",
      sessionId,
      "tab:",
      tabId,
    );
    setMessages((ms) => [...ms, { role: "user", content: text, sessionId }]);
    setInput("");
    setTrace([]); // 新一轮:旧轨迹立即清掉(AGENT_STARTED 会再兜一次)
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
            return i === lastUserIdx && trace.length > 0
              ? [
                  node,
                  <TraceView
                    key="trace"
                    items={trace}
                    onToggleReasoning={toggleReasoning}
                  />,
                ]
              : [node];
          });
        })()}
        {status === "thinking" && (
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

// ---- 执行轨迹组件 ----

/** 轨迹容器:单一卡片面(settings-card 同族),行序 = 时间序(思考行 + 工具行) */
function TraceView({
  items,
  onToggleReasoning,
}: {
  items: TraceItem[];
  onToggleReasoning: (index: number) => void;
}) {
  return (
    <div className="msg-in trace">
      {items.map((t, i) =>
        t.kind === "reasoning" ? (
          <ReasoningRow
            key={i}
            item={t}
            onToggle={() => onToggleReasoning(i)}
          />
        ) : (
          <ToolRow key={t.id} item={t} />
        ),
      )}
    </div>
  );
}

/** 思考行:流式时是单行 ticker(只显示最近的尾部内容,节流刷新,不推挤布局);
 * 阶段结束后折叠为一行,点击展开完整文本回看 */
function ReasoningRow({
  item,
  onToggle,
}: {
  item: ReasoningTraceItem;
  onToggle: () => void;
}) {
  if (item.active) {
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
  const open = !item.collapsed;
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
function ToolRow({ item }: { item: ToolTraceItem }) {
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
            <svg
              className="trace-mark mark-error"
              width="12"
              height="12"
              viewBox="0 0 12 12"
            >
              <path d="M3.2 3.2 8.8 8.8M8.8 3.2 3.2 8.8" />
            </svg>
          ) : (
            <svg
              className="trace-mark mark-ok"
              width="12"
              height="12"
              viewBox="0 0 12 12"
            >
              <path d="M2.6 6.4 4.9 8.7 9.4 3.4" />
            </svg>
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
