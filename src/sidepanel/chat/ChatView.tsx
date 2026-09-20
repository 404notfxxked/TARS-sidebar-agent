// 对话视图:渲染与输入区。agent 状态(port 事件、消息、会话游标、本轮
// 执行流)在 chat/useAgentChannel;执行流状态机在 chat/useRunSegments,
// 过程卡渲染在 chat/trace,气泡与 markdown 在 chat/bubbles,图片管线与
// 缓存在 chat/images,空态(问候/chips/每日一句)在 chat/EmptyState,
// 写操作确认卡在 chat/ConfirmCard。

import { useEffect, useRef, useState, type RefObject } from "react";
import { parseSkillInvocation } from "../../shared/skills";
import { createLogger } from "../../shared/logger";
import { cacheImgUrl, releaseAllImgUrls } from "./images";
import { ConfirmCard } from "./ConfirmCard";
import { useAgentChannel } from "./useAgentChannel";
import { useChatModels } from "./useChatModels";
import { useAttachments } from "./useAttachments";
import { useAutoScroll } from "./useAutoScroll";
import { useSkillMenu } from "./useSkillMenu";
import { useQuoteEnabled } from "./useQuoteEnabled";
import ChatHeader from "./ChatHeader";
import MessageList from "./MessageList";
import ComposerBar from "./ComposerBar";
import { useT } from "../ui/hooks";

const log = createLogger({ ctx: "panel" });

export default function ChatView({
  onOpenSettings,
  onOpenSessions,
  onOpenMemory,
  onOpenSkills,
  resumeSessionId,
  onResumeDone,
  onActiveSessionChange,
  chatInputRef,
}: {
  onOpenSettings: () => void;
  onOpenSessions: () => void;
  /** 轻提示直通记忆管理页(不经设置页中转,同 ChatGPT「Memory updated」) */
  onOpenMemory: () => void;
  /** / 菜单空态引导 → 技能管理整页 */
  onOpenSkills: () => void;
  /** 历史列表选中的会话:非空时打开它,完事后回调置空 */
  resumeSessionId: string | null;
  onResumeDone: () => void;
  /** 当前会话变化时回传 App,历史列表据此高亮「当前」 */
  onActiveSessionChange?: (sessionId: string) => void;
  /** 输入框 ref:App 持有,悬浮层关闭/一轮收口后把焦点还给输入框 */
  chatInputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const t = useT();
  const chat = useAgentChannel({ resumeSessionId, onResumeDone });
  const {
    messages,
    compaction,
    memorySaved,
    status,
    confirmReq,
    currentSession,
    runSegs,
    runPhase,
    runEndedAt,
    openGroups,
    toggleGroup,
  } = chat;

  const [input, setInput] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);

  const {
    providers,
    modelProvider,
    modelId,
    visionOk,
    curModelEntry,
    thinkingOptions,
    thinkingDefault,
    showThinking,
    setThinkingEffort,
    pickModel,
  } = useChatModels();

  const {
    pendingImages,
    attachHint,
    fileInputRef,
    addAttachments,
    removePending,
    clearAttachments,
    flashHint,
  } = useAttachments(visionOk);

  const { atBottom, scrollToLatest } = useAutoScroll(listRef, {
    messages,
    runSegs,
    status,
  });

  const {
    skillList,
    enabledSkills,
    skillMatches,
    slashQuery,
    slashMenuOpen,
    skillIdx,
    setSkillIdx,
    setSlashClosed,
    pickSkill,
  } = useSkillMenu(input, setInput);

  // 切会话时清空输入草稿与待发附件:为 A 会话贴的图不该在 B 会话里发出
  // (预览 objectURL 一并回收);上一屏气泡的图片 URL 也在此时回收(新会话
  // 的图缺缓存会重新走 GET_IMAGE)。「新对话」按钮的清空在调用点自理。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只随 resumeSessionId 触发,clearAttachments 读 ref + 稳定 setter,无过期闭包问题
  useEffect(() => {
    if (resumeSessionId !== null) {
      setInput("");
      clearAttachments();
      releaseAllImgUrls();
    }
  }, [resumeSessionId]);

  // 当前会话回传给 App,历史列表据此高亮「当前」
  useEffect(() => {
    onActiveSessionChange?.(currentSession);
  }, [currentSession, onActiveSessionChange]);

  // 空态每日一句展示开关(设置 → 外观;storage 事件实时跟随)
  const quoteEnabled = useQuoteEnabled();

  // 一轮收口后若焦点已落在 body(停止钮卸载、悬浮层刚关等),把焦点还给
  // 输入框:下一问是收口后的高频动作,不该让用户再点一次输入框。
  // 放在渲染后执行,才能看到停止钮卸载后的最终焦点归属
  useEffect(() => {
    if (status === "idle" && document.activeElement === document.body) {
      chatInputRef.current?.focus();
    }
  }, [status, chatInputRef]);

  const submit = async () => {
    const text = input.trim();
    if ((!text && pendingImages.length === 0) || status !== "idle") return;
    // /token 命中已停用技能:提示但不拦截(SW 侧同样只认启用,原样透传)
    const inv = parseSkillInvocation(text);
    if (inv && skillList) {
      const hit = skillList.find(
        (s) => !s.enabled && s.name === inv.name.toLowerCase(),
      );
      if (hit) flashHint(t("skills.disabledHint", { name: hit.name }));
    }
    // 附件是开着视觉模型时贴的、发送前切到了非视觉模型:照常发送(图片仍会
    // 入库,切回视觉模型后可继续引用),但明确告知本次模型看不到
    if (pendingImages.length > 0 && !visionOk) {
      flashHint(
        t("chat.visionModelFallback"),
      );
    }
    // 会话全局唯一;tabId 记录本次提问的页面上下文(工具去该 tab 执行)
    const { tabId, sessionId } = await chat.resolveContext();
    log.info("chat", "submit", {
      text,
      sessionId,
      tabId,
      images: pendingImages.length,
    });
    // 本地回显:预览 url 先入气泡缓存,渲染无需再向后台取字节
    for (const p of pendingImages) cacheImgUrl(p.id, p.url);
    chat.submitUserMessage({
      sessionId,
      tabId,
      text,
      ...(pendingImages.length ? { images: pendingImages } : {}),
    });
    setInput("");
    clearAttachments();
  };

  // 新对话:重置会话游标 + 清输入草稿 + 清待发附件,上一屏气泡 URL 一并回收
  const startNewConversation = () => {
    chat.resetConversation();
    setInput("");
    clearAttachments();
    releaseAllImgUrls();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 会话操作(历史/新建)居左、全局设置居右:高频对象操作占视线起点,
          低频全局项放视觉终点,两侧分组也避免三个图标挤在一起的误触 */}
      <ChatHeader
        busy={status !== "idle"}
        onOpenSessions={onOpenSessions}
        onOpenSettings={onOpenSettings}
        onReset={startNewConversation}
      />

      {/* 消息列表 + 悬浮层锚点:滚离底部时右下角浮现「回到最新」 */}
      <MessageList
        listRef={listRef}
        messages={messages}
        currentSession={currentSession}
        status={status}
        compaction={compaction}
        runSegs={runSegs}
        runPhase={runPhase}
        runEndedAt={runEndedAt}
        openGroups={openGroups}
        toggleGroup={toggleGroup}
        regenerate={chat.regenerate}
        quoteEnabled={quoteEnabled}
        memorySaved={memorySaved}
        onOpenMemory={onOpenMemory}
        onPickEmpty={(text) => {
          setInput(text);
          chatInputRef.current?.focus();
        }}
        atBottom={atBottom}
        onJumpLatest={scrollToLatest}
      />

      {/* 写操作确认卡:后台在执行点击/填写前停下等答复;展示目标页与写入内容 */}
      {confirmReq && (
        <ConfirmCard req={confirmReq} onAnswer={chat.answerConfirm} />
      )}

      <ComposerBar
        input={input}
        setInput={setInput}
        onSubmit={submit}
        onCancel={chat.cancel}
        status={status}
        chatInputRef={chatInputRef}
        attachments={{
          pendingImages,
          attachHint,
          removePending,
          fileInputRef,
          onPickFiles: (files) => void addAttachments(files),
          visionOk,
        }}
        skills={{
          list: skillList,
          enabled: enabledSkills,
          matches: skillMatches,
          query: slashQuery,
          open: slashMenuOpen,
          activeIndex: skillIdx,
          setActiveIndex: setSkillIdx,
          onClose: setSlashClosed,
          onPick: pickSkill,
          onManage: onOpenSkills,
        }}
        models={{
          providers,
          providerId: modelProvider,
          modelId,
          onPick: pickModel,
          showThinking,
          thinkingOptions,
          thinkingDefault,
          reasoningEffort: curModelEntry?.reasoningEffort,
          onPickThinking: setThinkingEffort,
        }}
      />
    </div>
  );
}
