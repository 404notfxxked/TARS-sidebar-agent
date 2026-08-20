// 主布局:header(新对话 / 设置入口)在 ChatView 内,这里只保留设置面板的开关与遮罩

import { useState } from "react";
import ChatView from "./ChatView";
import SettingsPanel from "./SettingsPanel";

export default function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <div className="relative flex h-full flex-col">
      <ChatView onOpenSettings={() => setSettingsOpen(true)} />

      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
