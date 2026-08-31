// 主布局:对话视图常驻,设置/历史会话以整页悬浮层盖在其上。
// 不用条件挂载(旧版做法)的原因:卸载 ChatView 会丢掉对话内状态 ——
// 「打开面板总是新会话」的新语义下,没有可自动恢复的历史可拉,丢就是真丢。

import { useEffect, useState } from "react";
import ChatView from "./ChatView";
import SettingsView from "./SettingsView";
import SessionsView from "./SessionsView";

type Overlay = null | "settings" | "sessions";

export default function App() {
  const [overlay, setOverlay] = useState<Overlay>(null);
  /** 历史列表里选中的会话:交给常驻的 ChatView 打开,消费后清空。
   *  空串也是有效选择 = 「新对话」,所以用 null 表示「无待消费」 */
  const [resumeSessionId, setResumeSessionId] = useState<string | null>(null);
  /** ChatView 回传的当前会话,历史列表里高亮「当前」 */
  const [activeSessionId, setActiveSessionId] = useState("");

  // 悬浮层打开期间 Esc 直接返回
  useEffect(() => {
    if (overlay === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOverlay(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [overlay]);

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <ChatView
        onOpenSettings={() => setOverlay("settings")}
        onOpenSessions={() => setOverlay("sessions")}
        resumeSessionId={resumeSessionId}
        onResumeDone={() => setResumeSessionId(null)}
        onActiveSessionChange={setActiveSessionId}
      />
      {overlay !== null && (
        <div className="absolute inset-0 z-10 bg-surface-container">
          {overlay === "settings" ? (
            <SettingsView onBack={() => setOverlay(null)} />
          ) : (
            <SessionsView
              onBack={() => setOverlay(null)}
              onPick={(id) => {
                setResumeSessionId(id);
                setOverlay(null);
              }}
              onNew={() => {
                setResumeSessionId("");
                setOverlay(null);
              }}
              activeId={activeSessionId}
            />
          )}
        </div>
      )}
    </div>
  );
}
