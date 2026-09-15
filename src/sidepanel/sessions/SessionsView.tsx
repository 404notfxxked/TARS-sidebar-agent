import type { TFn } from "../../shared/i18n";
// 历史会话视图:日期分组(今天/昨天/7 天内/更早)+ 搜索 + 当前会话高亮,
// 点击切回,单条删除。数据经 port 向后台要(SW 是 IndexedDB 唯一读写方),本视图不碰 IDB。

import { useEffect, useMemo, useRef, useState } from "react";
import { MSG, PORT_NAME, type SessionMeta } from "../../shared/messages";
import { createLogger } from "../../shared/logger";
import { useConfirmReset, useT } from "../ui/hooks";
import SkeletonRows from "../ui/SkeletonRows";
import SubPageHeader from "../ui/SubPageHeader";
import { TrashIcon } from "../ui/icons";

const log = createLogger({ ctx: "panel" });

const DAY = 86_400_000;
/** 星期短名键映射(键写字面量,勿动态拼键);文案在调用时经 t() 现取 */
const WEEKDAY_KEYS = [
  "sessions.weekday.su",
  "sessions.weekday.mo",
  "sessions.weekday.tu",
  "sessions.weekday.we",
  "sessions.weekday.th",
  "sessions.weekday.fr",
  "sessions.weekday.sa",
] as const;
const weekdayShort = (
  t: TFn,
  day: number,
): string => t(WEEKDAY_KEYS[day]);

/** 行内短时间:组头已表达大粒度(今天/昨天/7 天内),行内只留细粒度 ——
 *  今天 → HH:mm;昨天 → 「昨天」;7 天内 → 「周三」;更早 → M/D(跨年带年份) */
function shortTime(t: TFn, ts: number): string {
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
  if (ts >= startOfToday.getTime() - DAY) return t("sessions.yesterday");
  if (ts >= startOfToday.getTime() - 7 * DAY) return weekdayShort(t, d.getDay());
  const sameYear = d.getFullYear() === now.getFullYear();
  return sameYear
    ? `${d.getMonth() + 1}/${d.getDate()}`
    : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** 按本地日界分四组,空组丢弃;调用方保证列表已按 updatedAt 降序 */
function groupSessions(t: (path: string) => string, list: SessionMeta[]) {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const t0 = startOfToday.getTime();
  const groups: { label: string; items: SessionMeta[] }[] = [
    { label: t("sessions.groupToday"), items: [] },
    { label: t("sessions.groupYesterday"), items: [] },
    { label: t("sessions.groupWeek"), items: [] },
    { label: t("sessions.groupEarlier"), items: [] },
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
  const t = useT();
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null);
  // 两段确认删除:第一次点变「确认删除」,3s 不跟进而自动复位
  const [confirmId, armConfirm, resetConfirm] = useConfirmReset<string>();
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

  const refresh = () =>
    portRef.current?.postMessage({ type: MSG.LIST_SESSIONS });

  const remove = (id: string) => {
    if (confirmId !== id) {
      armConfirm(id);
      return;
    }
    resetConfirm();
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
  // 分组标签经 t() 现取:t 的函数身份随语言切换变化,useMemo 据此重算
  const groups = useMemo(
    () => (filtered ? groupSessions(t, filtered) : []),
    [filtered, t],
  );
  // 入场 stagger:全局序号封顶 8,30ms/行
  const rowDelay = useMemo(() => {
    const m = new Map<string, number>();
    filtered?.forEach((s, i) => {
      m.set(s.id, Math.min(i, 8) * 30);
    });
    return m;
  }, [filtered]);

  const pick = (id: string) => {
    log.debug("chat", "session picked", { id });
    onPick(id);
  };

  return (
    <div className="view-in flex min-h-0 flex-1 flex-col">
      <SubPageHeader title={t("sessions.title")} onBack={onBack}>
        <button
          type="button"
          onClick={onNew}
          aria-label={t("sessions.newChat")}
          title={t("sessions.newChat")}
          className="icon-btn ml-auto"
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
      </SubPageHeader>

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
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant"
          >
            <circle cx="7" cy="7" r="4.5" />
            <path d="m10.5 10.5 3 3" />
          </svg>
          <input
            type="text"
            // biome-ignore lint/a11y/noAutofocus: 打开历史列表即检索是产品语义(见 CHANGELOG)
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.stopPropagation();
                setQuery("");
              }
            }}
            placeholder={t("sessions.searchPlaceholder")}
            aria-label={t("sessions.searchPlaceholder")}
            autoComplete="off"
            spellCheck={false}
            className="search-bar"
          />
        </div>
      </div>

      {/* 顶部不留 padding:组头吸顶后若上方有缝,行会从缝里露出来(间距在组头自身 padding 里) */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {sessions === null ? (
          <SkeletonRows widths={[72, 55, 63, 46]} />
        ) : sessions.length === 0 ? (
          <EmptyState onNew={onNew} />
        ) : groups.length === 0 ? (
          <p className="px-1 py-8 text-center text-[12.5px] text-on-surface-variant">
            {t("sessions.noMatch", { query: query.trim() })}
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
  const t = useT();
  return (
    <li className="sessions-row-in" style={{ animationDelay: `${delay}ms` }}>
      <div
        className={`group flex items-center gap-1 rounded-md px-2 py-2 transition-colors duration-150 ${
          active ? "bg-secondary-container" : "hover:bg-on-surface/8"
        }`}
      >
        <button
          type="button"
          onClick={() => onPick(s.id)}
          className="min-w-0 flex-1 cursor-pointer text-left"
        >
          <span className="flex items-center gap-1.5">
            <span className="min-w-0 truncate text-[13px] leading-snug text-on-surface">
              {s.title}
            </span>
            {active && (
              <span className="shrink-0 rounded-full bg-primary px-2 py-px text-[10.5px] font-medium text-on-primary">
                {t("sessions.activeBadge")}
              </span>
            )}
          </span>
          <span className="mt-0.5 block text-[11px] text-on-surface-variant">
            {shortTime(t, s.updatedAt)} · {t("sessions.msgCount", { n: s.msgCount })}
          </span>
        </button>
        <button
          type="button"
          onClick={() => onRemove(s.id)}
          aria-label={
            confirming
              ? t("sessions.confirmDeleteOf", { title: s.title })
              : t("sessions.deleteOf", { title: s.title })
          }
          className={`shrink-0 rounded-full p-1.5 transition-colors duration-150 ${
            confirming
              ? "text-[11px] font-medium leading-none text-error"
              : "text-on-surface-variant opacity-0 hover:bg-error/8 hover:text-error focus-visible:opacity-100 group-hover:opacity-100"
          }`}
        >
          {confirming ? t("common.confirmDelete") : <TrashIcon />}
        </button>
      </div>
    </li>
  );
}

// ---- 空态 ----

function EmptyState({ onNew }: { onNew: () => void }) {
  const t = useT();
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
        className="text-on-surface-variant opacity-60"
      >
        <path d="M3 12a9 9 0 1 0 3-6.7" />
        <path d="M3 4v4h4" />
        <path d="M12 7v5l3 2" />
      </svg>
      <p className="m-0 text-[13px] text-on-surface-variant">
        {t("sessions.empty")}
      </p>
      <button type="button" onClick={onNew} className="settings-btn">
        {t("sessions.newChat")}
      </button>
    </div>
  );
}
