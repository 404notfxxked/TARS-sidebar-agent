import type { TFn } from "../../shared/i18n";
// 记忆管理整页:列表独占一页(平铺在设置页时一节就超过一屏,且列表只增不减),
// 设置页只留 开关 + 摘要入口行,聊天流的「已写入 N 条」轻提示也直通本页。
// 结构沿用历史会话页的范式:吸顶头部 + 顶部添加条 + 行悬停操作 + 两段确认删除。
// 数据经 MEM_* 消息走后台(memoryClient),本视图不碰 IDB。

import { useEffect, useMemo, useRef, useState } from "react";
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
import { useConfirmDelete, useRowStagger, useT } from "../ui/hooks";
import { SubPageEmpty } from "../ui/SubPageEmpty";
import SkeletonRows from "../ui/SkeletonRows";
import SubPageHeader from "../ui/SubPageHeader";
import { StarIcon, TrashIcon } from "../ui/icons";

const log = createLogger({ ctx: "panel" });

export default function MemoryView({
  onBack,
  backLabel,
}: {
  onBack: () => void;
  /** 返回钮文案随来路:设置页入口「返回设置」,聊天入口由 App 传「返回对话」 */
  backLabel?: string;
}) {
  const t = useT();
  const [memories, setMemories] = useState<MemoryItem[] | null>(null);
  // 当前模型的上下文窗口:注入预算按它动态缩放(与后台注入同源)
  const [contextTokens, setContextTokens] = useState<number | undefined>();
  const [newMemory, setNewMemory] = useState("");
  // 行内编辑:点文本进入,失焦/回车提交,清空文本视为取消
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  // 右上溢出菜单:清空全部记忆(菜单内两段确认,关菜单即复位)
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  // 列表回填序号守卫(硬规则 10,同 useAgentChannel 的 actionSeq):写动作
  // 回包是全量快照,两个在途请求的回包乱序时,迟到的旧快照若仍整体替换,
  // 置顶/删除/新增会互相回滚。每次请求取递增序号,回包过期即丢弃;
  // 乐观本地变更(删除/清空)取新序号,天然作废此前在途请求。渲染期不写 ref
  const listSeqRef = useRef(0);
  // 后台兜底回包携带的操作错误(MEMORIES.error),就地展示不挂起
  const [listError, setListError] = useState<string | null>(null);

  useEffect(() => {
    const seq = ++listSeqRef.current;
    memReq({ type: MSG.MEM_LIST })
      .then((r) => {
        if (seq !== listSeqRef.current) return;
        setMemories(r.memories);
        setListError(r.error ?? null);
      })
      .catch(() => {
        if (seq === listSeqRef.current) setMemories([]); // 加载失败按空列表呈现,重开页面重试
      });
    loadConfig()
      .then((c) => setContextTokens(selectedContextTokens(c)))
      .catch(() => {});
  }, []);

  const add = async () => {
    const text = newMemory.trim();
    if (!text) return;
    const seq = ++listSeqRef.current;
    try {
      const r = await memReq({ type: MSG.MEM_ADD, text });
      if (seq !== listSeqRef.current) return;
      setMemories(r.memories);
      setListError(r.error ?? null);
      setNewMemory("");
    } catch (e) {
      log.error("memory", "记忆添加失败", { err: String(e) });
    }
  };

  const commitEdit = async (id: string, text: string) => {
    setEditingId(null);
    if (!text.trim()) return;
    const seq = ++listSeqRef.current;
    try {
      const r = await memReq({ type: MSG.MEM_UPDATE, id, text: text.trim() });
      if (seq !== listSeqRef.current) return;
      setMemories(r.memories);
      setListError(r.error ?? null);
    } catch (e) {
      log.error("memory", "记忆更新失败", { err: String(e) });
    }
  };

  const togglePin = async (m: MemoryItem) => {
    const seq = ++listSeqRef.current;
    try {
      const r = await memReq({ type: MSG.MEM_PIN, id: m.id, pinned: !m.pinned });
      if (seq !== listSeqRef.current) return;
      setMemories(r.memories);
      setListError(r.error ?? null);
    } catch (e) {
      log.error("memory", "记忆置顶失败", { err: String(e) });
    }
  };

  const { confirmingId, remove } = useConfirmDelete<string>((id) => {
    const seq = ++listSeqRef.current; // 乐观本地变更:作废此前在途请求
    setMemories((list) => list?.filter((m) => m.id !== id) ?? list);
    memReq({ type: MSG.MEM_DELETE, id })
      .then((r) => {
        if (seq !== listSeqRef.current) return;
        setMemories(r.memories);
        setListError(r.error ?? null);
      })
      .catch((e) => {
        // 乐观移除后兜底刷新:失败也要重拉一次真实状态,不能让已删的行
        // 凭空留在视图里(port 中途断开时回包永远不来,必须主动还原)
        log.error("memory", "记忆删除失败", { err: String(e) });
        const seq2 = ++listSeqRef.current;
        memReq({ type: MSG.MEM_LIST })
          .then((r) => {
            if (seq2 === listSeqRef.current) setMemories(r.memories);
          })
          .catch(() => {});
      });
  });

  const clearAll = () => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setConfirmClear(false);
    setMenuOpen(false);
    const seq = ++listSeqRef.current; // 乐观本地变更:作废此前在途请求
    setMemories([]);
    memReq({ type: MSG.MEM_CLEAR })
      .then((r) => {
        if (seq !== listSeqRef.current) return;
        setMemories(r.memories);
        setListError(r.error ?? null);
      })
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
  const rowDelay = useRowStagger(memories);

  return (
    <div className="view-in flex min-h-0 flex-1 flex-col">
      <SubPageHeader
        title={t("memory.entryTitle")}
        onBack={onBack}
        backLabel={backLabel ?? t("memory.backToSettings")}
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
      <div className="mx-auto w-full max-w-[560px] px-3 pb-1 pt-1">
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
          <p className="mb-0 mt-1.5 px-1 text-[12px] leading-4 tabular-nums text-on-surface-variant">
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
        {listError && <p className="field-hint text-error">{listError}</p>}
      </div>

      <div className="mx-auto w-full max-w-[560px] min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-1">
        {memories === null ? (
          <SkeletonRows widths={[80, 62, 71, 55]} />
        ) : memories.length === 0 ? (
          <SubPageEmpty
            icon={
              <>
                <path d="M3 7h18M4 7l1.2 12.2A2 2 0 0 0 7.2 21h9.6a2 2 0 0 0 2-1.8L20 7" />
                <path d="M9 11h6" />
              </>
            }
            title={t("memory.empty")}
            hint={t("memory.emptyHint")}
          />
        ) : (
          <ul className="m-0 list-none space-y-0.5 p-0">
            {memories.map((m) => (
              <MemoryRow
                key={m.id}
                memory={m}
                editing={editingId === m.id}
                editText={editingId === m.id ? editingText : ""}
                confirming={confirmingId === m.id}
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

/** tag 徽标文案:渲染时现取 t()(模块级求值会停在默认语言,AGENTS.md 硬规则 13) */
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
              className="btn-text danger px-2 text-[12px]"
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
