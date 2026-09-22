// 主布局:对话视图常驻,设置/历史会话以整页悬浮层盖在其上。
// 不用条件挂载(旧版做法)的原因:卸载 ChatView 会丢掉对话内状态 ——
// 「打开面板总是新会话」的新语义下,没有可自动恢复的历史可拉,丢就是真丢。

import { useEffect, useRef, useState } from "react";
import ChatView from "./chat/ChatView";
import SettingsView from "./settings/SettingsView";
import SessionsView from "./sessions/SessionsView";
import MemoryView from "./memory/MemoryView";
import SkillView from "./skills/SkillView";
import { useLocale, useT } from "./ui/hooks";
import { ErrorBoundary } from "./ui/ErrorBoundary";

type Overlay = null | "settings" | "sessions" | "memory" | "skills";

export default function App() {
  // 语言订阅:t() 非响应式,切换语言后靠这里触发整棵树重渲染
  useLocale();
  const t = useT();
  const [overlay, setOverlay] = useState<Overlay>(null);
  // 输入框 ref 由这里持有:悬浮层收起后把焦点还给输入框,继续打字不用再点
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);
  /** 历史列表里选中的会话:交给常驻的 ChatView 打开,消费后清空。
   *  空串也是有效选择 = 「新对话」,所以用 null 表示「无待消费」 */
  const [resumeSessionId, setResumeSessionId] = useState<string | null>(null);
  /** ChatView 回传的当前会话,历史列表里高亮「当前」 */
  const [activeSessionId, setActiveSessionId] = useState("");
  /** 记忆页的来路:返回时回到原处(设置页进来回设置页,聊天轻提示进来回对话) */
  const [memoryFrom, setMemoryFrom] = useState<"chat" | "settings">("chat");
  /** 技能页的来路(同 memoryFrom):设置页管理入口 / 聊天 / 菜单空态引导 */
  const [skillFrom, setSkillFrom] = useState<"chat" | "settings">("settings");

  // 悬浮层打开期间 Esc 直接返回
  useEffect(() => {
    if (overlay === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOverlay(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [overlay]);

  // 悬浮层收起 → 焦点回归输入框(返回钮已随页面卸载,焦点本来就丢了)
  const prevOverlayRef = useRef<Overlay>(null);
  useEffect(() => {
    if (overlay === null && prevOverlayRef.current !== null) {
      chatInputRef.current?.focus();
    }
    prevOverlayRef.current = overlay;
  }, [overlay]);

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {/* 渲染兜底:对话视图与悬浮层各包一层(硬规则粒度裁决 = 两处,不做每内页多处)。
          悬浮层边界按 overlay 取 key:某页抛错后直接切另一页时重置边界,兜底态不跨页残留 */}
      <ErrorBoundary>
        <ChatView
        onOpenSettings={() => setOverlay("settings")}
        onOpenSessions={() => setOverlay("sessions")}
        onOpenMemory={() => {
          setMemoryFrom("chat");
          setOverlay("memory");
        }}
        onOpenSkills={() => {
          setSkillFrom("chat");
          setOverlay("skills");
        }}
        resumeSessionId={resumeSessionId}
        onResumeDone={() => setResumeSessionId(null)}
        onActiveSessionChange={setActiveSessionId}
        chatInputRef={chatInputRef}
      />
      </ErrorBoundary>
      {overlay !== null && (
        // 必须自身是 flex 列:内页(设置/历史)根节点靠 flex-1 撑满,
        // 若这里是普通块,内页高度随内容生长 → 文档级滚动,顶栏吸顶失效、
        // 内容溢出悬浮层底色露出 body 的 surface(看起来像背景断层)
        <div className="absolute inset-0 z-10 flex flex-col overflow-hidden bg-surface-container">
          <ErrorBoundary key={overlay}>
          {overlay === "settings" ? (
            <SettingsView
              onBack={() => setOverlay(null)}
              onOpenMemory={() => {
                setMemoryFrom("settings");
                setOverlay("memory");
              }}
              onOpenSkills={() => {
                setSkillFrom("settings");
                setOverlay("skills");
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
          ) : overlay === "memory" ? (
            <MemoryView
              onBack={() => setOverlay(memoryFrom === "settings" ? "settings" : null)}
              backLabel={
                memoryFrom === "settings"
                  ? t("memory.backToSettings")
                  : t("common.backToChat")
              }
            />
          ) : (
            <SkillView
              onBack={() => setOverlay(skillFrom === "settings" ? "settings" : null)}
              backLabel={
                skillFrom === "settings"
                  ? t("skills.backToSettings")
                  : t("common.backToChat")
              }
            />
          )}
          </ErrorBoundary>
        </div>
      )}
    </div>
  );
}
