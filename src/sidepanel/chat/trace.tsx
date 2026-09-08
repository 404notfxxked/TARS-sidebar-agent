// 本轮执行流的渲染层:思考段/文本段/工具段按到达顺序交错 —— 连续的过程段
// 聚成一张过程卡,文本段渲染为气泡。段类型也定义在这里(useRunSegments 是
// 它的状态层)。渲染是纯函数式的:输入段序列,不持有任何执行流状态。

import { useState, type ReactNode } from "react";
import { t } from "../../shared/i18n";
import { useCopyFlash } from "../ui/hooks";
import { AssistantBubble } from "./bubbles";

// ---- 本轮执行流(segments):思考段 / 文本段 / 工具段按到达顺序交错 ----
// 事件流本身按时序经单一 port FIFO 送达,前端只需按序落段即可交错渲染。
// 只属于「进行中 / 刚结束这轮」,不持久化;新一轮开始时文本段归档进 messages,过程段丢弃。

export type ToolSeg = {
  kind: "tool";
  id: string;
  name: string;
  displayName?: string;
  args?: unknown;
  status: "running" | "done" | "error";
  result?: unknown;
  /** 创建时刻:过程卡分组计时用 */
  t: number;
};
export type ReasoningSeg = {
  kind: "reasoning";
  text: string;
  /** 仍在流式生成中:驱动 ticker;阶段收口时置 false */
  active: boolean;
  t: number;
};
export type TextSeg = { kind: "text"; text: string; t: number };
export type RunSegment = ToolSeg | ReasoningSeg | TextSeg;
export type ProcessSeg = ToolSeg | ReasoningSeg;

// 展开预览的截断阈值(字符):工具结果可达 12k,思考过程整段也不短,不整段渲染;
// 展开区配「复制」按钮,完整内容可取出
const PREVIEW_CHARS = 500;
const REASONING_MAX_CHARS = 2000;

/** 本轮执行流渲染:连续的过程段(思考/工具)聚成一张过程卡,文本段渲染为气泡 */
export function RunZone({
  segs,
  phase,
  endedAt,
  openGroups,
  onToggleGroup,
}: {
  segs: RunSegment[];
  phase: "live" | "settled";
  endedAt: number | null;
  openGroups: Set<number>;
  onToggleGroup: (firstIdx: number) => void;
}) {
  const parts: ReactNode[] = [];
  let group: { s: ProcessSeg; i: number }[] = [];
  const closeGroup = (endT: number) => {
    if (group.length === 0) return;
    const firstIdx = group[0].i;
    parts.push(
      <ProcessCard
        key={`g${firstIdx}`}
        entries={group}
        phase={phase}
        durationMs={Math.max(0, endT - group[0].s.t)}
        open={openGroups.has(firstIdx)}
        onToggle={() => onToggleGroup(firstIdx)}
      />,
    );
    group = [];
  };
  segs.forEach((s, i) => {
    if (s.kind === "text") {
      // 空白文本段(模型在工具调用间隙常吐空/换行 content):
      // 渲染即空气泡,还会切断过程卡分组,把一轮过程拆成「1 步」卡串 —— 跳过
      if (!s.text.trim()) return;
      closeGroup(s.t); // 文本段开始 = 前一张过程卡计时截止
      parts.push(<AssistantBubble key={`t${i}`} text={s.text} />);
    } else {
      group.push({ s, i });
    }
  });
  closeGroup(endedAt ?? Date.now());
  return <>{parts}</>;
}

// RunZone 渲染文本段时直接复用对话气泡(bubbles 不依赖 trace,单向引用)。

/** 过程卡:live 态展示工具行 + 活跃思考 ticker(已收口思考行隐藏,保紧凑);
 * settled 态收拢为一行摘要 chip,点击展开完整行回看 */
function ProcessCard({
  entries,
  phase,
  durationMs,
  open,
  onToggle,
}: {
  entries: { s: ProcessSeg; i: number }[];
  phase: "live" | "settled";
  durationMs: number;
  open: boolean;
  onToggle: () => void;
}) {
  if (phase === "live") {
    const rows = entries.filter(
      (e) => e.s.kind === "tool" || (e.s.kind === "reasoning" && e.s.active),
    );
    return (
      <div className="trace msg-in">
        {rows.map((e) =>
          e.s.kind === "reasoning" ? (
            <TickerRow key={`r${e.i}`} item={e.s} />
          ) : (
            <ToolRow key={e.s.id} item={e.s} />
          ),
        )}
      </div>
    );
  }
  const tools = entries
    .map((e) => e.s)
    .filter((s): s is ToolSeg => s.kind === "tool");
  const hasError = tools.some((t) => t.status === "error");
  const meta = tools.length
    ? t("chat.trace.stepsMeta", { n: tools.length, dur: fmtDur(durationMs) })
    : t("chat.trace.thinkingMeta", { dur: fmtDur(durationMs) });
  const chain = summarizeChain(tools);
  return (
    <div className="trace msg-in" data-open={open}>
      <button
        type="button"
        className="trace-header trace-summary"
        onClick={onToggle}
        aria-expanded={open}
      >
        <span className="trace-icon" aria-hidden="true">
          {hasError ? <MarkError /> : <MarkOk />}
        </span>
        <span className="trace-summary-meta">{meta}</span>
        {chain && <span className="trace-summary-chain">{chain}</span>}
        <span className="trace-tail">
          <ChevronIcon />
        </span>
      </button>
      <div className="trace-rows-wrap">
        <div className="trace-rows">
          {entries.map((e) =>
            e.s.kind === "reasoning" ? (
              <ReasoningRow key={`r${e.i}`} item={e.s} />
            ) : (
              <ToolRow key={e.s.id} item={e.s} />
            ),
          )}
        </div>
      </div>
    </div>
  );
}

/** 思考中 ticker:单行,只显示最近的尾部内容(节流刷新,不推挤布局) */
function TickerRow({ item }: { item: ReasoningSeg }) {
  return (
    <div className="trace-row" data-kind="reasoning" data-active="true">
      <div className="trace-line">
        <span className="trace-icon" aria-hidden="true">
          <SparkleIcon />
        </span>
        <span className="trace-label trace-shimmer">{t("chat.trace.thinking")}</span>
        <span className="trace-tail-text" aria-hidden="true">
          {tailSlice(item.text)}
        </span>
      </div>
    </div>
  );
}

/** 已收口的思考行(settled 展开区内):一行「思考过程」,点击展开完整文本回看。
 *  展开态是行内局部状态 —— 与 ToolRow 一致,不进 runSegs,
 *  否则会触发近底跟随的段更新 effect(旧版正是这样被拽底的) */
function ReasoningRow({ item }: { item: ReasoningSeg }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="trace-row" data-kind="reasoning" data-open={open}>
      <button
        type="button"
        className="trace-header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="trace-icon" aria-hidden="true">
          <SparkleIcon />
        </span>
        <span className="trace-label">{t("chat.trace.reasoning")}</span>
        <span className="trace-tail">
          <ChevronIcon />
        </span>
      </button>
      <div className="trace-body-wrap">
        <div className="trace-body">
          <div className="reasoning-text">
            {truncate(item.text, REASONING_MAX_CHARS)}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 工具行:名称 + 状态常显(对勾/叉以描边画入),参数/结果点击展开(摘要截断) */
function ToolRow({ item }: { item: ToolSeg }) {
  const [open, setOpen] = useState(false);
  const statusText =
    item.status === "running"
      ? t("chat.trace.running")
      : item.status === "error"
        ? t("chat.trace.failed")
        : t("chat.trace.done");
  return (
    <div
      className="trace-row"
      data-kind="tool"
      data-status={item.status}
      data-open={open}
    >
      <button
        type="button"
        className="trace-header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="trace-icon" aria-hidden="true">
          {item.status === "running" ? (
            <span className="trace-spinner" />
          ) : item.status === "error" ? (
            <MarkError />
          ) : (
            <MarkOk />
          )}
        </span>
        <span className="trace-label">{item.displayName ?? item.name}</span>
        <span className="trace-tail">
          <span className="trace-status">{statusText}</span>
          <ChevronIcon />
        </span>
      </button>
      <div className="trace-body-wrap">
        <div className="trace-body">
          <CopyableSection
            label={t("chat.trace.args")}
            text={
              item.args === undefined ? t("chat.trace.none") : stringifyPreview(item.args)
            }
          />
          {item.result !== undefined && (
            <CopyableSection
              label={item.status === "error" ? t("chat.trace.error") : t("chat.trace.result")}
              text={stringifyPreview(item.result)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** 参数/结果小节:标题行带「复制」(取完整内容);预览截断展示 */
function CopyableSection({ label, text }: { label: string; text: string }) {
  const [copied, copy] = useCopyFlash();
  return (
    <>
      <div className="trace-sec-row">
        <span className="trace-sec">{label}</span>
        <button type="button" onClick={() => copy(text)} className="trace-copy-btn">
          {copied ? t("common.copied") : t("common.copy")}
        </button>
      </div>
      <pre className="trace-pre">{truncate(text, PREVIEW_CHARS)}</pre>
    </>
  );
}

function MarkOk() {
  return (
    <svg
      className="trace-mark mark-ok"
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden="true"
    >
      <path d="M2.6 6.4 4.9 8.7 9.4 3.4" />
    </svg>
  );
}

function MarkError() {
  return (
    <svg
      className="trace-mark mark-error"
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden="true"
    >
      <path d="M3.2 3.2 8.8 8.8M8.8 3.2 3.2 8.8" />
    </svg>
  );
}

/** 毫秒 → 「5s」「1m03s」(下限 1s,避免闪 0s) */
function fmtDur(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/** 工具链摘要:连续同名合并 ×n,「查找元素 → 点击元素 → 读取章节×2」 */
function summarizeChain(tools: ToolSeg[]): string {
  const runs: { name: string; n: number }[] = [];
  for (const tool of tools) {
    const name = tool.displayName ?? tool.name;
    const last = runs[runs.length - 1];
    if (last?.name === name) last.n += 1;
    else runs.push({ name, n: 1 });
  }
  return runs.map((r) => (r.n > 1 ? `${r.name}×${r.n}` : r.name)).join(" → ");
}

/** 四角星(SF Symbols sparkle 风):思考过程的图标 */
function SparkleIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 2.75C8.6 5.4 10.6 7.4 13.25 8 10.6 8.6 8.6 10.6 8 13.25 7.4 10.6 5.4 8.6 2.75 8 5.4 7.4 7.4 5.4 8 2.75Z" />
    </svg>
  );
}

/** 折叠指示箭头:单个 SVG,开合沿同一路径旋转(CSS 接管 transform) */
function ChevronIcon() {
  return (
    <svg
      className="trace-chevron"
      width="10"
      height="10"
      viewBox="0 0 12 12"
      aria-hidden="true"
    >
      <path d="M4.5 2.75 8.25 6 4.5 9.25" />
    </svg>
  );
}

/** unknown → 可展示文本:字符串原样,对象 JSON 美化,失败退 String() */
function stringifyPreview(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return String(v);
  }
}

/** ticker 单行容量(按显示宽度估算:CJK≈1 单位,西文≈0.55;≈220px @12px) */
const TAIL_WIDTH_UNITS = 17;

/** 思考 ticker:从尾部按显示宽度截取最近的单行内容,越界时前缀 … 标记截断 */
function tailSlice(s: string): string {
  let units = 0;
  let i = s.length;
  while (i > 0) {
    const cp = s.codePointAt(i - 1)!;
    const w = cp > 0x2e7f ? 1 : 0.55; // CJK 及全角记 1,其余记约半宽
    if (units + w > TAIL_WIDTH_UNITS) break;
    units += w;
    i -= cp > 0xffff ? 2 : 1;
  }
  const tail = s.slice(i).replace(/\s+$/, "");
  return i > 0 && tail ? `…${tail}` : tail;
}

/** 超长文本截断,尾部标注总字数 */
function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}${t("chat.truncatedChars", { n: s.length })}` : s;
}
