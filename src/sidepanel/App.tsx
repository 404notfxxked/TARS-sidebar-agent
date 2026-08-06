// 主布局:仅保留设置入口,对话视图占满整栏

import { useState } from "react";
import ChatView from "./ChatView";
import SettingsPanel from "./SettingsPanel";

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

export default function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <div className="relative flex h-full flex-col">
      <header className="flex justify-end px-4 pb-1 pt-3">
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          aria-label="打开设置"
          className="flex h-7 w-7 items-center justify-center rounded-[5px] text-[var(--muted)] transition-all duration-150 hover:bg-[var(--line)] hover:text-[var(--ink)] active:scale-90"
        >
          <SettingsIcon />
        </button>
      </header>

      <ChatView />

      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
