// 主布局:卷首 header + 对话 + 设置滑层

import { useEffect, useState } from 'react'
import ChatView from './ChatView'
import SettingsPanel from './SettingsPanel'
import { loadConfig } from '../shared/configStore'

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
  )
}

export default function App() {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [active, setActive] = useState<{ provider: string; model: string } | null>(null)

  // 挂载时 + 设置关闭后,刷新「当前配置」chip
  useEffect(() => {
    if (!settingsOpen) {
      loadConfig().then((c) => {
        setActive(c.model ? { provider: c.provider, model: c.model } : null)
      })
    }
  }, [settingsOpen])

  return (
    <div className="relative flex h-full flex-col">
      <header className="flex items-start justify-between px-4 pb-3 pt-4">
        <div>
          <h1 className="title-serif m-0 text-[16px] font-semibold leading-none">
            随读
          </h1>
          <p className="eyebrow m-0 mt-1.5">Sidebar · QA</p>
        </div>
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          aria-label="打开设置"
          className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-[5px] text-[var(--muted)] transition-colors hover:bg-[var(--line)] hover:text-[var(--ink)]"
        >
          <SettingsIcon />
        </button>
      </header>

      {active && (
        <p className="px-4 pb-2 font-mono text-[10px] tracking-[0.04em] text-[var(--muted)]">
          {active.model} · {active.provider}
        </p>
      )}

      <ChatView />

      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}
