// 对话视图头部:会话操作(历史/新建)居左、全局设置居右 —— 高频对象操作占
// 视线起点,低频全局项放视觉终点,两侧分组也避免三个图标挤在一起的误触。

import LanguageMenu from "./LanguageMenu";
import { HistoryIcon, PlusIcon, SettingsIcon } from "../ui/icons";
import { useT } from "../ui/hooks";

export default function ChatHeader({
  busy,
  onOpenSessions,
  onOpenSettings,
  onReset,
}: {
  /** 运行中置灰「新对话 / 历史会话」:二者在运行中都不可用(切换能力后续再做) */
  busy: boolean;
  onOpenSessions: () => void;
  onOpenSettings: () => void;
  /** 新对话:重置会话游标 + 清输入草稿 + 清待发附件与上一屏气泡 URL */
  onReset: () => void;
}) {
  const t = useT();
  return (
    <header className="flex items-center justify-between px-4 pb-1 pt-3">
      <div className="flex gap-1">
        <button
          type="button"
          onClick={onOpenSessions}
          disabled={busy}
          aria-label={t("chat.openSessions")}
          title={busy ? t("chat.busySessionsHint") : undefined}
          className={busy ? "icon-btn opacity-30" : "icon-btn"}
        >
          <HistoryIcon />
        </button>
        <button
          type="button"
          onClick={onReset}
          disabled={busy}
          aria-label={t("chat.newChat")}
          title={busy ? t("chat.busyNewChatHint") : undefined}
          className={busy ? "icon-btn opacity-30" : "icon-btn"}
        >
          <PlusIcon />
        </button>
      </div>
      <div className="flex gap-1">
        <LanguageMenu />
        <button
          type="button"
          onClick={onOpenSettings}
          aria-label={t("chat.openSettings")}
          className="icon-btn"
        >
          <SettingsIcon />
        </button>
      </div>
    </header>
  );
}
