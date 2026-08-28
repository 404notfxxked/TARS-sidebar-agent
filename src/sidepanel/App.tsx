// 主布局:设置与对话是互斥的两个整页视图,这里只负责切换

import { useState } from "react";
import ChatView from "./ChatView";
import SettingsView from "./SettingsView";

export default function App() {
  const [showSettings, setShowSettings] = useState(false);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {showSettings ? (
        <SettingsView onBack={() => setShowSettings(false)} />
      ) : (
        <ChatView onOpenSettings={() => setShowSettings(true)} />
      )}
    </div>
  );
}
