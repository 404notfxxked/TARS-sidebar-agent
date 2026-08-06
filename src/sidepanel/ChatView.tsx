// 对话视图:经 port 连 SW,ReAct agent 的流式回复渲染

import { useEffect, useRef, useState, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MSG, PORT_NAME, type AgentEvent } from "../shared/messages";

interface ChatMsg {
  role: "user" | "assistant";
  content: string;
}

type AgentStatus = "idle" | "thinking" | "streaming";

export default function ChatView() {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<AgentStatus>("idle");
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const streamingRef = useRef(false);
  const sessionRef = useRef("");
  const listRef = useRef<HTMLDivElement | null>(null);

  const connect = (): chrome.runtime.Port => {
    // 复用已有连接（没断开就不新建）
    if (portRef.current) return portRef.current;

    const port = chrome.runtime.connect({ name: PORT_NAME });
    portRef.current = port;
    console.log("[chat] port connected");

    const appendDelta = (delta: string) => {
      if (!streamingRef.current) {
        streamingRef.current = true;
        setMessages((ms) => [...ms, { role: "assistant", content: delta }]);
      } else {
        setMessages((ms) => {
          const last = ms[ms.length - 1];
          if (last?.role === "assistant") {
            return [
              ...ms.slice(0, -1),
              { ...last, content: last.content + delta },
            ];
          }
          return [...ms, { role: "assistant", content: delta }];
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
          break;
        case MSG.AGENT_THINKING:
          console.log("[chat] agent thinking, turn:", evt.turn);
          finalize();
          setStatus("thinking");
          break;
        case MSG.AGENT_MESSAGE:
          setStatus("streaming");
          appendDelta(evt.delta);
          break;
        case MSG.AGENT_TOOL_CALL:
          console.log("[chat] tool call:", evt.name);
          finalize();
          setStatus("thinking");
          break;
        case MSG.AGENT_DONE:
          console.log("[chat] agent done");
          finalize();
          setStatus("idle");
          break;
        case MSG.AGENT_ERROR:
          console.log("[chat] agent error:", evt.error);
          finalize();
          setStatus("idle");
          setMessages((ms) => [
            ...ms,
            { role: "assistant", content: `⚠ ${evt.error}` },
          ]);
          break;
      }
    });

    port.onDisconnect.addListener(() => {
      console.log("[chat] port disconnected");
      portRef.current = null;
      streamingRef.current = false;
    });

    return port;
  };

  useEffect(() => {
    const port = connect();
    return () => {
      streamingRef.current = false;
      port.disconnect();
      portRef.current = null;
    };
  }, []);

  // 新消息自动滚到底
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, status]);

  const cancel = () => {
    console.log("[chat] cancel clicked, sessionId:", sessionRef.current);
    if (!sessionRef.current) return;
    connect().postMessage({
      type: MSG.CANCEL_RUN,
      sessionId: sessionRef.current,
    });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || status !== "idle") return;
    console.log("[chat] submit, text:", text);
    setMessages((ms) => [...ms, { role: "user", content: text }]);
    setInput("");
    connect().postMessage({ type: MSG.USER_MESSAGE, payload: { text } });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={listRef}
        className="flex-1 space-y-3 overflow-y-auto px-4 py-2 pb-1"
      >
        {messages.length === 0 && status === "idle" ? (
          <EmptyState />
        ) : (
          messages.map((m, i) =>
            m.role === "user" ? (
              <UserBubble key={i} text={m.content} />
            ) : (
              <AssistantBubble key={i} text={m.content} />
            ),
          )
        )}
        {status === "thinking" && (
          <div className="flex items-center gap-1.5 py-1 pl-1 text-[var(--muted)]">
            <span className="h-1 w-1 animate-pulse rounded-full bg-current" />
            <span className="h-1 w-1 animate-pulse rounded-full bg-current [animation-delay:150ms]" />
            <span className="h-1 w-1 animate-pulse rounded-full bg-current [animation-delay:300ms]" />
          </div>
        )}
      </div>

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
