// 历史会话视图:日期分组(今天/昨天/7 天内/更早)+ 搜索 + 当前会话高亮,
// 点击切回,单条删除。数据经 port 向后台要(SW 是 IndexedDB 唯一读写方),本视图不碰 IDB。

import { useEffect, useMemo, useRef, useState } from "react";
import { MSG, PORT_NAME, type SessionMeta } from "../shared/messages";
import { createLogger } from "../shared/logger";

const log = createLogger({ ctx: "panel" });

const DAY = 86_400_000;
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 行内短时间:组头已表达大粒度(今天/昨天/7 天内),行内只留细粒度 ——
 *  今天 → HH:mm;昨天 → 「昨天」;7 天内 → 「周三」;更早 → M/D(跨年带年份) */
function shortTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  if (ts >= startOfToday.getTime())
    return d.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  if (ts >= startOfToday.getTime() - DAY) return "昨天";
  if (ts >= startOfToday.getTime() - 7 * DAY) return WEEKDAYS[d.getDay()];
  const sameYear = d.getFullYear() === now.getFullYear();
  return sameYear
    ? `${d.getMonth() + 1}/${d.getDate()}`
    : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** 按本地日界分四组,空组丢弃;调用方保证列表已按 updatedAt 降序 */
function groupSessions(list: SessionMeta[]) {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const t0 = startOfToday.getTime();
  const groups: { label: string; items: SessionMeta[] }[] = [
    { label: "今天", items: [] },
    { label: "昨天", items: [] },
    { label: "7 天内", items: [] },
    { label: "更早", items: [] },
  ];
  for (const s of list) {
    if (s.updatedAt >= t0) groups[0].items.push(s);
    else if (s.updatedAt >= t0 - DAY) groups[1].items.push(s);
    else if (s.updatedAt >= t0 - 7 * DAY) groups[2].items.push(s);
    else groups[3].items.push(s);
  }
  return groups.filter((g) => g.items.length > 0);
}

export default function SessionsView({
  onBack,
  onPick,
  onNew,
  activeId,
}: {
  onBack: () => void;
  onPick: (sessionId: string) => void;
  /** 发起新对话:回空白会话(运行中入口已置灰,触发时必然 idle) */
  onNew: () => void;
  /** 对话区当前所在会话,列表中高亮「当前」 */
  activeId: string;
}) {
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null);
  // 两段确认删除:第一次点变「确认删除」,3s 不跟进而自动复位
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const portRef = useRef<chrome.runtime.Port | null>(null);

  useEffect(() => {
    const port = chrome.runtime.connect({ name: PORT_NAME });
    portRef.current = port;
    port.onMessage.addListener((evt) => {
      if (evt.type === MSG.SESSIONS) setSessions(evt.sessions);
    });
    port.postMessage({ type: MSG.LIST_SESSIONS });
    return () => {
      port.disconnect();
      portRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!confirmId) return;
    const t = window.setTimeout(() => setConfirmId(null), 3000);
    return () => window.clearTimeout(t);
  }, [confirmId]);

  const refresh = () =>
    portRef.current?.postMessage({ type: MSG.LIST_SESSIONS });

  const remove = (id: string) => {
    if (confirmId !== id) {
      setConfirmId(id);
      return;
    }
    setConfirmId(null);
    setSessions((list) => list?.filter((s) => s.id !== id) ?? list);
    portRef.current?.postMessage({ type: MSG.DELETE_SESSION, sessionId: id });
    // 删除无回执,延迟拉一次列表兜底(后台失败时列表会还原)
    window.setTimeout(refresh, 300);
  };

  // 搜索:标题子串过滤(大小写不敏感,纯前端;列表本就全量在手)
  const kw = query.trim().toLowerCase();
  const filtered = useMemo(
    () => sessions?.filter((s) => !kw || s.title.toLowerCase().includes(kw)),
    [sessions, kw],
  );
  const groups = useMemo(
    () => (filtered ? groupSessions(filtered) : []),
    [filtered],
  );
  // 入场 stagger:全局序号封顶 8,30ms/行
  const rowDelay = useMemo(() => {
    const m = new Map<string, number>();
    filtered?.forEach((s, i) => m.set(s.id, Math.min(i, 8) * 30));
    return m;
  }, [filtered]);

  const pick = (id: string) => {
    log.debug("chat", "session picked", { id });
    onPick(id);
  };

  return (
    <div className="view-in flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-2 px-3 pb-1 pt-3">
        <button
          type="button"
          onClick={onBack}
          aria-label="返回对话"
          className="settings-icon-btn h-7 w-7"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M10 3 5 8l5 5" />
          </svg>
        </button>
        <h2 className="m-0 text-[15px] font-semibold tracking-[-0.01em] text-ink">
          历史会话
        </h2>
        <button
          type="button"
          onClick={onNew}
          aria-label="发起新对话"
          title="发起新对话"
          className="settings-icon-btn ml-auto h-7 w-7"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M8 3.5v9M3.5 8h9" />
          </svg>
        </button>
      </header>

      {/* 搜索:输入内 Esc 先清词(冒泡被拦下,不关页面) */}
      <div className="px-3 pb-1 pt-1">
        <div className="relative">
          <svg
            width="13"
            height="13"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
          >
            <circle cx="7" cy="7" r="4.5" />
            <path d="m10.5 10.5 3 3" />
          </svg>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.stopPropagation();
                setQuery("");
              }
            }}
            placeholder="搜索会话"
            aria-label="搜索会话"
            autoComplete="off"
            spellCheck={false}
            className="field-input py-1.5 pl-8 text-[12.5px]"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-1 pb-3">
        {sessions === null ? (
          <SkeletonRows />
        ) : sessions.length === 0 ? (
          <EmptyState onNew={onNew} />
        ) : groups.length === 0 ? (
          <p className="px-1 py-8 text-center text-[12.5px] text-muted">
            没有找到匹配「{query.trim()}」的会话
          </p>
        ) : (
          groups.map((g) => (
            <section key={g.label}>
              <h3 className="sessions-group-head">{g.label}</h3>
              <ul className="m-0 list-none space-y-0.5 p-0">
                {g.items.map((s) => (
                  <SessionRow
                    key={s.id}
                    session={s}
                    active={s.id === activeId}
                    confirming={confirmId === s.id}
                    delay={rowDelay.get(s.id) ?? 0}
                    onPick={pick}
                    onRemove={remove}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

// ---- 行 ----

function SessionRow({
  session: s,
  active,
  confirming,
  delay,
  onPick,
  onRemove,
}: {
  session: SessionMeta;
  active: boolean;
  confirming: boolean;
  delay: number;
  onPick: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <li className="sessions-row-in" style={{ animationDelay: `${delay}ms` }}>
      <div
        className={`group flex items-center gap-1 rounded-lg px-2 py-2 transition-colors ${
          active ? "bg-accent-soft" : "hover:bg-ink/5"
        }`}
      >
        <button
          type="button"
          onClick={() => onPick(s.id)}
          className="min-w-0 flex-1 cursor-pointer text-left"
        >
          <span className="flex items-center gap-1.5">
            <span className="min-w-0 truncate text-[13px] leading-snug text-ink">
              {s.title}
            </span>
            {active && <span className="model-badge shrink-0">当前</span>}
          </span>
          <span className="mt-0.5 block text-[11px] text-muted">
            {shortTime(s.updatedAt)} · {s.msgCount} 条
          </span>
        </button>
        <button
          type="button"
          onClick={() => onRemove(s.id)}
          aria-label={
            confirming
              ? `再点一次确认删除「${s.title}」`
              : `删除会话「${s.title}」`
          }
          className={`shrink-0 rounded-md p-1.5 transition-colors ${
            confirming
              ? "text-[11px] leading-none text-danger"
              : "text-muted opacity-0 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
          }`}
        >
          {confirming ? "确认删除" : <TrashIcon />}
        </button>
      </div>
    </li>
  );
}

function TrashIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="block"
    >
      <path d="M2.5 4h11M6.5 2h3M4 4l.7 9a1.5 1.5 0 0 0 1.5 1.3h3.6a1.5 1.5 0 0 0 1.5-1.3L12 4M6.5 7v4M9.5 7v4" />
    </svg>
  );
}

// ---- 骨架屏 / 空态 ----

function SkeletonRows() {
  return (
    <div className="space-y-4 px-2 pt-3" aria-hidden="true">
      {[72, 55, 63, 46].map((w, i) => (
        <div key={i} className="animate-pulse space-y-1.5">
          <div className="h-3 rounded bg-line" style={{ width: `${w}%` }} />
          <div className="h-2 w-2/5 rounded bg-line" />
        </div>
      ))}
    </div>
  );
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
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
        className="text-muted opacity-60"
      >
        <path d="M3 12a9 9 0 1 0 3-6.7" />
        <path d="M3 4v4h4" />
        <path d="M12 7v5l3 2" />
      </svg>
      <p className="m-0 text-[13px] text-muted">还没有历史会话</p>
      <button
        type="button"
        onClick={onNew}
        className="rounded-full border border-outline px-4 py-1.5 text-[12.5px] font-medium text-accent transition-colors hover:bg-accent/8"
      >
        发起新对话
      </button>
    </div>
  );
}
