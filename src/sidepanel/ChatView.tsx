// 对话视图:经 port 连 SW,ReAct agent 的流式回复渲染

import { useEffect, useRef, useState, type FormEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { MSG, PORT_NAME, type AgentEvent } from '../shared/messages'

interface ChatMsg {
  role: 'user' | 'assistant'
  content: string
}

type AgentStatus = 'idle' | 'thinking' | 'streaming'

export default function ChatView() {
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [status, setStatus] = useState<AgentStatus>('idle')
  const portRef = useRef<chrome.runtime.Port | null>(null)
  const streamingRef = useRef(false)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const port = chrome.runtime.connect({ name: PORT_NAME })
    portRef.current = port

    const appendDelta = (delta: string) => {
      if (!streamingRef.current) {
        streamingRef.current = true
        setMessages((ms) => [...ms, { role: 'assistant', content: delta }])
      } else {
        setMessages((ms) => {
          const last = ms[ms.length - 1]
          if (last?.role === 'assistant') {
            return [...ms.slice(0, -1), { ...last, content: last.content + delta }]
          }
          return [...ms, { role: 'assistant', content: delta }]
        })
      }
    }
    const finalize = () => {
      streamingRef.current = false
    }

    port.onMessage.addListener((evt: AgentEvent) => {
      switch (evt.type) {
        case MSG.AGENT_STARTED:
          setStatus('thinking')
          break
        case MSG.AGENT_THINKING:
          finalize()
          setStatus('thinking')
          break
        case MSG.AGENT_MESSAGE:
          setStatus('streaming')
          appendDelta(evt.delta)
          break
        case MSG.AGENT_TOOL_CALL:
          finalize()
          setStatus('thinking')
          break
        case MSG.AGENT_DONE:
          finalize()
          setStatus('idle')
          break
        case MSG.AGENT_ERROR:
          finalize()
          setStatus('idle')
          setMessages((ms) => [...ms, { role: 'assistant', content: `⚠ ${evt.error}` }])
          break
      }
    })

    return () => {
      finalize()
      port.disconnect()
    }
  }, [])

  // 新消息自动滚到底
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, status])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const text = input.trim()
    if (!text || status !== 'idle') return
    setMessages((ms) => [...ms, { role: 'user', content: text }])
    setInput('')
    portRef.current?.postMessage({ type: MSG.USER_MESSAGE, payload: { text } })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-2">
        {messages.length === 0 && status === 'idle' ? (
          <EmptyState />
        ) : (
          messages.map((m, i) =>
            m.role === 'user' ? (
              <UserBubble key={i} text={m.content} />
            ) : (
              <AssistantBubble key={i} text={m.content} />
            ),
          )
        )}
        {status === 'thinking' && (
          <div className="flex items-center gap-1.5 py-1 pl-1 text-[var(--muted)]">
            <span className="h-1 w-1 animate-pulse rounded-full bg-current" />
            <span className="h-1 w-1 animate-pulse rounded-full bg-current [animation-delay:150ms]" />
            <span className="h-1 w-1 animate-pulse rounded-full bg-current [animation-delay:300ms]" />
          </div>
        )}
      </div>

      <form onSubmit={submit} className="px-4 pb-5 pt-2">
        <div className="flex items-center gap-2 border-b border-[var(--line)] pb-2 transition-colors focus-within:border-[var(--accent)]">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="读到什么，想问什么？"
            aria-label="提问"
            disabled={status !== 'idle'}
            className="flex-1 bg-transparent py-1 text-[13px] text-[var(--ink)] outline-none placeholder:text-[var(--muted)] disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={!input.trim() || status !== 'idle'}
            aria-label="发送"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[5px] bg-[var(--accent)] text-[13px] leading-none text-white transition-colors hover:bg-[var(--accent-strong)] disabled:opacity-30"
          >
            ↑
          </button>
        </div>
      </form>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="px-2 py-12 text-center">
      <p className="eyebrow">New Note</p>
      <p className="mx-auto mt-3 max-w-[200px] text-[12px] leading-relaxed text-[var(--muted)]">
        在文档里读到什么，就在这里问。
        <br />
        我可以读取当前页面并回答。
      </p>
    </div>
  )
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="msg-in ml-auto w-fit max-w-[86%] rounded-[6px] border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-[13px] leading-relaxed">
      {text}
    </div>
  )
}

function AssistantBubble({ text }: { text: string }) {
  return (
    <div className="msg-in w-fit max-w-[86%] border-l-2 border-[var(--accent)] pl-2.5 text-[13px] leading-relaxed">
      <div className="markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </div>
    </div>
  )
}
