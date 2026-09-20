// 消息列表:可见消息过滤(当前会话、剔除注入行)、空态、trace 插入点、
// 压缩分隔条、「回到最新」悬浮钮与记忆落库轻提示。只收 props —— port 订阅
// (useAgentChannel)仍归 ChatView 唯一持有。

import type { RefObject } from "react";
import type { ChatMsg } from "./useAgentChannel";
import type { RunSegment } from "./useRunSegments";
import { ReplayProcessCard, RunZone } from "./trace";
import {
  AssistantBubble,
  CompactionDivider,
  ErrorBubble,
  NoticeBubble,
  UserBubble,
} from "./bubbles";
import { EmptyState } from "./EmptyState";
import { ArchiveIcon, ArrowDownIcon } from "../ui/icons";
import { useT } from "../ui/hooks";

export default function MessageList({
  listRef,
  messages,
  currentSession,
  status,
  compaction,
  runSegs,
  runPhase,
  runEndedAt,
  openGroups,
  toggleGroup,
  regenerate,
  quoteEnabled,
  memorySaved,
  onOpenMemory,
  onPickEmpty,
  atBottom,
  onJumpLatest,
}: {
  listRef: RefObject<HTMLDivElement | null>;
  messages: ChatMsg[];
  currentSession: string;
  status: string;
  compaction: { uptoSeq: number } | null;
  runSegs: RunSegment[];
  runPhase: "live" | "settled";
  runEndedAt: number | null;
  openGroups: Set<number>;
  toggleGroup: (firstIdx: number) => void;
  regenerate: () => void;
  quoteEnabled: boolean;
  memorySaved: number;
  onOpenMemory: () => void;
  /** 空态 chips 点击:回填输入并聚焦 */
  onPickEmpty: (text: string) => void;
  atBottom: boolean;
  onJumpLatest: () => void;
}) {
  const t = useT();
  // 注入的伪 user 消息(截图附件注记)只属于模型管线,对话流不渲染
  // —— 实况视图本来就不显示它,回放对齐;落盘仍全量(synthetic 行
  // 留在库与 messages 态里,只是不进消息流)
  const visible = messages.filter(
    (m) => m.sessionId === currentSession && !m.synthetic,
  );
  // 轨迹插在最后一条 user 消息之后:它是「当前这轮」的过程,
  // 本轮流式答案(assistant 气泡)自然排在轨迹后面;历史回放时 trace 为空不渲染
  const lastUserIdx = visible.reduce(
    (acc, m, i) => (m.role === "user" ? i : acc),
    -1,
  );
  // 重新生成的挂点:本轮答案在 RunZone(settled 收尾气泡)由它自己挂;
  // 无本轮答案时,只有当可见消息的最后一条就是普通 assistant 气泡
  // (历史回放/上一轮归档后)才挂——重答截到末条 user,挂中间气泡会误导。
  // processOnly 纯过程行不是答案,排除
  let lastAssistantIdx = -1;
  if (runSegs.length === 0 && status === "idle") {
    const last = visible[visible.length - 1];
    if (
      last &&
      last.role === "assistant" &&
      !last.error &&
      !last.notice &&
      !last.processOnly
    ) {
      lastAssistantIdx = visible.length - 1;
    }
  }
  // 错误重试挂点:与 lastAssistantIdx 同规则,只有末条就是错误气泡
  // 才挂 —— 重试 = regenerate(截到末条 user 重跑),挂在中间错误上
  // 会让重试范围看起来比实际大
  let lastErrorIdx = -1;
  if (runSegs.length === 0 && status === "idle") {
    const last = visible[visible.length - 1];
    if (last && last.role === "assistant" && last.error) {
      lastErrorIdx = visible.length - 1;
    }
  }
  // 压缩分隔条插在第一条 seq 超过压缩点的记录之前;历史消息按 seq
  // 升序,所以命中第一条之后不再重复插
  let dividerPlaced = false;
  // 上翻回看后流式仍在推进/内容很长时,给一个单跳回底的入口
  const hasContent =
    messages.some((m) => m.sessionId === currentSession) || runSegs.length > 0;

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={listRef}
        role="log"
        aria-live="polite"
        aria-atomic="false"
        className="h-full overflow-y-auto px-4 pt-2 pb-8"
      >
        {/* 内容列:面板拖宽后封顶 560px 居中,窄面板不变 */}
        <div className="mx-auto w-full max-w-[560px] space-y-3">
          {visible.length === 0 && status === "idle" ? (
            <EmptyState onPick={onPickEmpty} showQuote={quoteEnabled} />
          ) : (
            visible.flatMap((m, i) => {
              const showDivider =
                compaction !== null &&
                !dividerPlaced &&
                (m.seq ?? Number.MAX_SAFE_INTEGER) > compaction.uptoSeq;
              if (showDivider) dividerPlaced = true;
              const divider =
                showDivider ? [<CompactionDivider key="ctx-div" />] : [];
              const node =
                m.role === "user" ? (
                  <UserBubble key={i} text={m.content} images={m.images} />
                ) : m.error ? (
                  // 失败轮:过程卡(如有)+ 错误气泡,与实况「过程卡 → 错误」同构
                  <div key={i} className="flex flex-col gap-1.5">
                    {m.processItems && m.processItems.length > 0 && (
                      <ReplayProcessCard items={m.processItems} />
                    )}
                    <ErrorBubble
                      text={m.content}
                      onRetry={i === lastErrorIdx ? regenerate : undefined}
                    />
                  </div>
                ) : m.notice ? (
                  <NoticeBubble key={i} kind={m.noticeKind} />
                ) : m.processItems && m.processItems.length > 0 ? (
                  // 历史回放:过程卡(思考/中间文案/工具)+ 收尾气泡 ——
                  // 与实况 settled 布局同构;processOnly 载体行(无收尾
                  // 记录的 run)只有卡
                  <div key={i} className="flex flex-col gap-1.5">
                    <ReplayProcessCard items={m.processItems} />
                    {!m.processOnly && (
                      <AssistantBubble
                        text={m.content}
                        actions={i === lastAssistantIdx ? "copy-regen" : "copy"}
                        onRegenerate={i === lastAssistantIdx ? regenerate : undefined}
                      />
                    )}
                  </div>
                ) : (
                  <AssistantBubble
                    key={i}
                    text={m.content}
                    actions={i === lastAssistantIdx ? "copy-regen" : "copy"}
                    onRegenerate={i === lastAssistantIdx ? regenerate : undefined}
                  />
                );
              // 执行流插在最后一条 user 消息之后:按到达顺序交错渲染;
              // 历史回放时 segs 为空不渲染
              return i === lastUserIdx && runSegs.length > 0
                ? [
                    ...divider,
                    node,
                    <RunZone
                      key="run-zone"
                      segs={runSegs}
                      phase={runPhase}
                      endedAt={runEndedAt}
                      openGroups={openGroups}
                      onToggleGroup={toggleGroup}
                      onRegenerate={regenerate}
                    />,
                  ]
                : [...divider, node];
            })
          )}
          {/* 网络等待等「无过程可看」时的活动指示;思考 ticker 存在时由 ticker 表达,不重复 */}
          {status === "thinking" &&
            !runSegs.some((s) => s.kind === "reasoning" && s.active) && (
              <div className="flex items-center gap-1.5 py-1 pl-1 text-on-surface-variant">
                <span className="h-1 w-1 animate-pulse rounded-full bg-current" />
                <span className="h-1 w-1 animate-pulse rounded-full bg-current [animation-delay:150ms]" />
                <span className="h-1 w-1 animate-pulse rounded-full bg-current [animation-delay:300ms]" />
              </div>
            )}
          {/* 记忆落库轻提示:仅当本轮发生过保存时出现,点击直通记忆管理页 */}
          {memorySaved > 0 && (
            <button
              type="button"
              onClick={onOpenMemory}
              className="memory-hint"
              aria-label={t("chat.memorySavedHint", { n: memorySaved })}
            >
              <ArchiveIcon /> {t("chat.memorySavedLabel", { n: memorySaved })}
            </button>
          )}
        </div>
      </div>
      {!atBottom && hasContent && (
        <button
          type="button"
          onClick={onJumpLatest}
          aria-label={t("chat.jumpLatest")}
          title={t("chat.jumpLatest")}
          className="jump-latest msg-in"
        >
          <ArrowDownIcon />
        </button>
      )}
    </div>
  );
}
