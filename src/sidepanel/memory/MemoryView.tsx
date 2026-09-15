import type { TFn } from "../../shared/i18n";
// 记忆管理整页:列表独占一页(平铺在设置页时一节就超过一屏,且列表只增不减),
// 设置页只留 开关 + 摘要入口行,聊天流的「已写入 N 条」轻提示也直通本页。
// 结构沿用历史会话页的范式:吸顶头部 + 顶部添加条 + 行悬停操作 + 两段确认删除。
// 数据经 MEM_* 消息走后台(memoryClient),本视图不碰 IDB。

import { useEffect, useMemo, useState } from "react";
import { MSG, type MemoryItem } from "../../shared/messages";
import {
  type MemoryTag,
  type MemoryTextLike,
  MEMORY_MAX_CHARS,
  memoryBudgetTokens,
  memoryUsedTokens,
  planMemoryInjection,
} from "../../shared/memory";
import { loadConfig, selectedContextTokens } from "../../shared/configStore";
import { createLogger } from "../../shared/logger";
import { memReq } from "../clients/memoryClient";
import { useConfirmReset, useT } from "../ui/hooks";
import SkeletonRows from "../ui/SkeletonRows";
import SubPageHeader from "../ui/SubPageHeader";
import { TrashIcon } from "../ui/icons";

const log = createLogger({ ctx: "panel" });

export default function MemoryView({ onBack }: { onBack: () => void }) {
  const t = useT();
  const [memories, setMemories] = useState<MemoryItem[] | null>(null);
  // 当前模型的上下文窗口:注入预算按它动态缩放(与后台注入同源)
  const [contextTokens, setContextTokens] = useState<number | undefined>();
  const [newMemory, setNewMemory] = useState("");
  // 行内编辑:点文本进入,失焦/回车提交,清空文本视为取消
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  // 两段确认删除:首点进入待确认,3 秒未跟进自动复位(同历史页)
  const [confirmDelId, armConfirmDel, resetConfirmDel] =
    useConfirmReset<string>();
  // 右上溢出菜单:清空全部记忆(菜单内两段确认,关菜单即复位)
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    memReq({ type: MSG.MEM_LIST })
      .then(setMemories)
      .catch(() => setMemories([])); // 加载失败按空列表呈现,重开页面重试
    loadConfig()
      .then((c) => setContextTokens(selectedContextTokens(c)))
      .catch(() => {});
  }, []);

  const add = async () => {
    const text = newMemory.trim();
    if (!text) return;
    try {
      setMemories(await memReq({ type: MSG.MEM_ADD, text }));
      setNewMemory("");
    } catch (e) {
      log.error("memory", "记忆添加失败", { err: String(e) });
    }
  };

  const commitEdit = async (id: string, text: string) => {
    setEditingId(null);
    if (!text.trim()) return;
    try {
      setMemories(await memReq({ type: MSG.MEM_UPDATE, id, text: text.trim() }));
    } catch (e) {
      log.error("memory", "记忆更新失败", { err: String(e) });
    }
  };

  const togglePin = async (m: MemoryItem) => {
    try {
      setMemories(
        await memReq({ type: MSG.MEM_PIN, id: m.id, pinned: !m.pinned }),
      );
    } catch (e) {
      log.error("memory", "记忆置顶失败", { err: String(e) });
    }
  };

  const remove = (id: string) => {
    if (confirmDelId !== id) {
      armConfirmDel(id);
      return;
    }
    resetConfirmDel();
    setMemories((list) => list?.filter((m) => m.id !== id) ?? list);
    memReq({ type: MSG.MEM_DELETE, id })
      .then(setMemories)
      .catch(() => {}); // 乐观移除后兜底刷新;失败时列表会还原
  };

  const clearAll = () => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setConfirmClear(false);
    setMenuOpen(false);
    setMemories([]);
    memReq({ type: MSG.MEM_CLEAR })
      .then(setMemories)
      .catch(() => {});
  };

  // 副标:每轮实际注入 token 估算 + 超预算提示(与后台同一套规划函数,
  // 预算按当前模型 contextTokens 动态缩放)
  const plan = useMemo(
    () => (memories ? planMemoryInjection(memories, contextTokens) : null),
    [memories, contextTokens],
  );
  const usedTokens = useMemo(
    () => (memories ? memoryUsedTokens(memories, contextTokens) : 0),
    [memories, contextTokens],
  );
  // 入场 stagger:全局序号封顶 8,30ms/行(同历史页)
  const rowDelay = useMemo(() => {
    const m = new Map<string, number>();
    memories?.forEach((r, i) => {
      m.set(r.id, Math.min(i, 8) * 30);
    });
    return m;
  }, [memories]);

  return (
    <div className="view-in flex min-h-0 flex-1 flex-col">
      <SubPageHeader
        title={t("memory.entryTitle")}
        onBack={onBack}
        backLabel={t("memory.backToSettings")}
      >
        {/* 溢出菜单:清空全部(两段确认;菜单收起即复位)。
            Esc 在此拦下先关菜单,不冒泡到 App 层关整页(容器本身非交互元素,焦点在内部按钮上) */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: Esc 拦截容器,见上 */}
        <div
          className="relative ml-auto"
          onKeyDown={(e) => {
            if (e.key === "Escape" && menuOpen) {
              e.stopPropagation();
              setMenuOpen(false);
              setConfirmClear(false);
            }
          }}
        >
          <button
            type="button"
            aria-label={t("memory.pageMenu")}
            aria-expanded={menuOpen}
            className="icon-btn"
            onClick={() => {
              setMenuOpen((v) => !v);
              setConfirmClear(false);
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="currentColor"
              aria-hidden="true"
            >
              <circle cx="8" cy="3.2" r="1.2" />
              <circle cx="8" cy="8" r="1.2" />
              <circle cx="8" cy="12.8" r="1.2" />
            </svg>
          </button>
          {menuOpen && (
            <>
              {/* 点菜单外任意处收起(垫层在菜单之下、页面之上) */}
              {/* biome-ignore lint/a11y/noStaticElementInteractions: 菜单垫层(scrim),标准模式 */}
              {/* biome-ignore lint/a11y/useKeyWithClickEvents: 垫层仅服务指针,键盘经 Esc 关闭(见上方 onKeyDown) */}
              <div
                className="fixed inset-0 z-10"
                onClick={() => {
                  setMenuOpen(false);
                  setConfirmClear(false);
                }}
              />
              <div className="combo-pop combo-pop--down z-20" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={clearAll}
                  className={`block w-full rounded-none px-3 py-1.5 text-left text-[12.5px] transition-colors duration-150 ${
                    confirmClear
                      ? "font-medium text-error"
                      : "text-error hover:bg-error/8"
                  }`}
                >
                  {confirmClear ? t("memory.confirmClearAll") : t("memory.clearAll")}
                </button>
              </div>
            </>
          )}
        </div>
      </SubPageHeader>

      {/* 添加条:胶囊输入 + 圆形添加钮(回车同效) */}
      <div className="px-3 pb-1 pt-1">
        <div className="relative">
          <input
            id="memory-new-input"
            type="text"
            value={newMemory}
            maxLength={MEMORY_MAX_CHARS}
            onChange={(e) => setNewMemory(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void add();
              }
            }}
            placeholder={t("memory.addPlaceholder")}
            aria-label={t("memory.add")}
            autoComplete="off"
            spellCheck={false}
            className="memory-add"
          />
          <button
            type="button"
            aria-label={t("memory.addBtn")}
            title={t("common.add")}
            disabled={!newMemory.trim()}
            onClick={() => void add()}
            className="icon-btn-filled absolute right-[5px] top-1/2 h-[26px] w-[26px] -translate-y-1/2"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M8 3.5v9M3.5 8h9" />
            </svg>
          </button>
        </div>
        {memories !== null && memories.length > 0 && (
          <p className="mb-0 mt-1.5 px-1 text-[11px] leading-4 tabular-nums text-on-surface-variant">
            {t("memory.saved", {
              n: memories.length,
              used: usedTokens,
              budget: memoryBudgetTokens(contextTokens),
            })}
            {plan && plan.dropped.length > 0 && (
              <span className="text-error">
                {" · "}{t("memory.dropped", { n: plan.dropped.length })}
              </span>
            )}
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-1">
        {memories === null ? (
          <SkeletonRows widths={[80, 62, 71, 55]} />
        ) : memories.length === 0 ? (
          <EmptyState />
        ) : (
          <ul className="m-0 list-none space-y-0.5 p-0">
            {memories.map((m) => (
              <MemoryRow
                key={m.id}
                memory={m}
                editing={editingId === m.id}
                editText={editingId === m.id ? editingText : ""}
                confirming={confirmDelId === m.id}
                delay={rowDelay.get(m.id) ?? 0}
                onEditStart={() => {
                  setEditingId(m.id);
                  setEditingText(m.text);
                }}
                onEditText={setEditingText}
                onEditCommit={() => void commitEdit(m.id, editingText)}
                onPin={() => void togglePin(m)}
                onRemove={() => remove(m.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---- 行 ----

/** tag 徽标文案:渲染时现取 t()(模块级求值会停在默认语言,契约 6) */
function memoryTagLabel(
  t: TFn,
  tag: MemoryTag,
): string {
  switch (tag) {
    case "identity":
      return t("memory.tagIdentity");
    case "preference":
      return t("memory.tagPreference");
    case "project":
      return t("memory.tagProject");
    case "health":
      return t("memory.tagHealth");
    case "other":
      return t("memory.tagOther");
  }
}

function MemoryRow({
  memory: m,
  editing,
  editText,
  confirming,
  delay,
  onEditStart,
  onEditText,
  onEditCommit,
  onPin,
  onRemove,
}: {
  memory: MemoryItem & MemoryTextLike;
  editing: boolean;
  editText: string;
  confirming: boolean;
  delay: number;
  onEditStart: () => void;
  onEditText: (t: string) => void;
  onEditCommit: () => void;
  onPin: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  return (
    <li className="memory-row-in" style={{ animationDelay: `${delay}ms` }}>
      <div className="group flex items-start gap-1 rounded-md px-2 py-2 transition-colors duration-150 hover:bg-on-surface/8">
        {editing ? (
          <input
            type="text"
            // biome-ignore lint/a11y/noAutofocus: 点「编辑」即进入行内编辑,自动聚焦是产品语义
            autoFocus
            value={editText}
            maxLength={MEMORY_MAX_CHARS}
            onChange={(e) => onEditText(e.target.value)}
            onBlur={onEditCommit}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            className="field-input flex-1"
          />
        ) : (
          <button
            type="button"
            onClick={onEditStart}
            title={t("memory.clickToEdit")}
            className="min-w-0 flex-1 cursor-pointer text-left text-[13px] leading-5 text-on-surface"
          >
            {m.text}
            {(m.key || m.subject) && (
              <span className="memory-src">
                {[m.subject, m.key].filter(Boolean).join("·")}
              </span>
            )}
            {m.tag && <span className="memory-src">{memoryTagLabel(t, m.tag)}</span>}
            {m.source === "model" && (
              <span className="memory-src">AI</span>
            )}
          </button>
        )}
        <span className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            aria-label={m.pinned ? t("memory.unpin") : t("memory.pin")}
            title={m.pinned ? t("memory.unpin") : t("memory.pin")}
            onClick={onPin}
            className={
              m.pinned
                ? "icon-btn text-primary"
                : "icon-btn text-on-surface-variant opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            }
          >
            <StarIcon filled={m.pinned} />
          </button>
          {confirming ? (
            <button
              type="button"
              aria-label={t("common.confirmDelete")}
              onClick={onRemove}
              className="btn-text danger px-2 text-[11px]"
            >
              {t("common.confirmDelete")}
            </button>
          ) : (
            <button
              type="button"
              aria-label={t("memory.deleteOne")}
              title={t("memory.deleteOne")}
              onClick={onRemove}
              className="icon-btn text-on-surface-variant opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-error"
            >
              <TrashIcon />
            </button>
          )}
        </span>
      </div>
    </li>
  );
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
      aria-hidden="true"
      className="block"
    >
      <path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.2L8 11.5l-3.8 2 .7-4.2-3.1-3 4.3-.6L8 1.8z" />
    </svg>
  );
}

// ---- 空态 ----

function EmptyState() {
  const t = useT();
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
      <svg
        width="30"
        height="30"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="text-on-surface-variant opacity-60"
      >
        <path d="M3 7h18M4 7l1.2 12.2A2 2 0 0 0 7.2 21h9.6a2 2 0 0 0 2-1.8L20 7" />
        <path d="M9 11h6" />
      </svg>
      <p className="m-0 text-[13px] text-on-surface-variant">{t("memory.empty")}</p>
      <p className="m-0 text-[11.5px] leading-4 text-on-surface-variant/80">
        {t("memory.emptyHint")}
      </p>
    </div>
  );
}
