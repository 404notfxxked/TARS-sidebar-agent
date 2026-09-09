// 主布局:对话视图常驻,设置/历史会话以整页悬浮层盖在其上。
// 不用条件挂载(旧版做法)的原因:卸载 ChatView 会丢掉对话内状态 ——
// 「打开面板总是新会话」的新语义下,没有可自动恢复的历史可拉,丢就是真丢。

import { useEffect, useState } from "react";
import ChatView from "./chat/ChatView";
import SettingsView from "./settings/SettingsView";
import SessionsView from "./sessions/SessionsView";
import MemoryView from "./memory/MemoryView";
import { useLocale } from "./ui/hooks";

type Overlay = null | "settings" | "sessions" | "memory";

export default function App() {
  // 语言订阅:t() 非响应式,切换语言后靠这里触发整棵树重渲染
  useLocale();
  const [overlay, setOverlay] = useState<Overlay>(null);
  /** 历史列表里选中的会话:交给常驻的 ChatView 打开,消费后清空。
   *  空串也是有效选择 = 「新对话」,所以用 null 表示「无待消费」 */
  const [resumeSessionId, setResumeSessionId] = useState<string | null>(null);
  /** ChatView 回传的当前会话,历史列表里高亮「当前」 */
  const [activeSessionId, setActiveSessionId] = useState("");
  /** 记忆页的来路:返回时回到原处(设置页进来回设置页,聊天轻提示进来回对话) */
  const [memoryFrom, setMemoryFrom] = useState<"chat" | "settings">("chat");

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
        onOpenMemory={() => {
          setMemoryFrom("chat");
          setOverlay("memory");
        }}
        resumeSessionId={resumeSessionId}
        onResumeDone={() => setResumeSessionId(null)}
        onActiveSessionChange={setActiveSessionId}
      />
      {overlay !== null && (
        // 必须自身是 flex 列:内页(设置/历史)根节点靠 flex-1 撑满,
        // 若这里是普通块,内页高度随内容生长 → 文档级滚动,顶栏吸顶失效、
        // 内容溢出悬浮层底色露出 body 的 surface(看起来像背景断层)
        <div className="absolute inset-0 z-10 flex flex-col overflow-hidden bg-surface-container">
          {overlay === "settings" ? (
            <SettingsView
              onBack={() => setOverlay(null)}
              onOpenMemory={() => {
                setMemoryFrom("settings");
                setOverlay("memory");
              }}
            />
          ) : overlay === "sessions" ? (
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
          ) : (
            <MemoryView
              onBack={() => setOverlay(memoryFrom === "settings" ? "settings" : null)}
            />
          )}
        </div>
      )}
    </div>
  );
}
