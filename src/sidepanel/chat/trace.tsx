// 本轮执行流的渲染层:思考段/文本段/工具段按到达顺序交错。live 时连续过程段
// 聚卡、文本段流式为气泡;settled 时整轮过程(含中间文案)重排进一张卡,折叠成
// 「已执行 x · n 步」摘要 chip,点击回看完整过程 —— 折叠态即「已执行 x → 最终回答」。
// 历史回放的过程卡(ReplayProcessCard)也在这:后台投影的 processItems 复用
// 同一套行组件,无耗时元数据,chip 只报步数。
// 段类型也定义在这里(useRunSegments 是它的状态层)。渲染是纯函数式的:输入段
// 序列,不持有任何执行流状态。

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { LocalePref } from "../../shared/configStore";
import type { ProcessItem } from "../../shared/messages";
import type { TFn } from "../../shared/i18n";
import { useCopyFlash, useLocale, useT } from "../ui/hooks";
import { toolLabel } from "./toolNames";
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

// 展开预览的截断阈值(字符):回放投影里的单条工具结果上限 12k
// (sessionHistory PROCESS_RESULT_CAP_CHARS);实况读页窗口更大,思考/文案整段也不短;
// 展开区配「复制」按钮,完整内容可取出
const PREVIEW_CHARS = 500;
const REASONING_MAX_CHARS = 2000;

/** 本轮执行流渲染:live 按到达顺序交错;settled 重排为单张过程卡 + 收尾答案气泡 */
export function RunZone({
  segs,
  phase,
  endedAt,
  openGroups,
  onToggleGroup,
  onRegenerate,
}: {
  segs: RunSegment[];
  phase: "live" | "settled";
  endedAt: number | null;
  openGroups: Set<number>;
  onToggleGroup: (firstIdx: number) => void;
  /** 重新生成:仅 settled 的最后一个答案气泡带(与业界一致的末条重答位) */
  onRegenerate?: () => void;
}) {
  // settled:整轮过程重排进一张卡(思考/工具/中间文案);只有收尾的连续文本段
  // (最终回答)留在卡外作气泡。文本是否「中间文案」取决于其后是否还有过程段
  if (phase === "settled") {
    let lastProc = -1;
    segs.forEach((s, i) => {
      if (s.kind !== "text") lastProc = i;
    });
    const bubble = (key: string, s: TextSeg, last: boolean) => (
      <AssistantBubble
        key={key}
        text={s.text}
        actions={last ? "copy-regen" : "copy"}
        onRegenerate={onRegenerate}
      />
    );
    if (lastProc === -1) {
      // 纯文本轮:无过程卡,文本即答案
      const lastText = segs.reduce(
        (acc, s, i) => (s.kind === "text" && s.text.trim() ? i : acc),
        -1,
      );
      return (
        <>
          {segs.map((s, i) =>
            s.kind === "text" && s.text.trim()
              ? bubble(`t${i}`, s, i === lastText)
              : null,
          )}
        </>
      );
    }
    const entries = segs
      .map((s, i) => ({ s, i }))
      .slice(0, lastProc + 1)
      .filter(({ s }) => s.kind !== "text" || s.text.trim() !== "");
    const firstIdx = entries[0].i;
    const tail = segs.slice(lastProc + 1);
    const lastTail = tail.reduce(
      (acc, s, i) => (s.kind === "text" && s.text.trim() !== "" ? i : acc),
      -1,
    );
    return (
      <>
        <ProcessCard
          key={`g${firstIdx}`}
          entries={entries}
          phase="settled"
          endT={endedAt ?? Date.now()}
          open={openGroups.has(firstIdx)}
          onToggle={() => onToggleGroup(firstIdx)}
        />
        {tail.map((s, i) =>
          s.kind === "text" && s.text.trim() !== ""
            ? bubble(`t${lastProc + 1 + i}`, s, i === lastTail)
            : null,
        )}
      </>
    );
  }

  // live:按到达顺序交错。文本段先按气泡流式(它是否「中间文案」要等后续过程段
  // 到达才能确定,settled 时统一重排进卡);连续过程段聚卡,已收口的思考行保留可回看
  const parts: ReactNode[] = [];
  let group: { s: ProcessSeg; i: number }[] = [];
  const closeGroup = (endT: number) => {
    if (group.length === 0) return;
    const firstIdx = group[0].i;
    parts.push(
      <ProcessCard
        key={`g${firstIdx}`}
        entries={group}
        phase="live"
        endT={endT}
        open={false}
        onToggle={() => {}}
      />,
    );
    group = [];
  };
  segs.forEach((s, i) => {
    if (s.kind === "text") {
      // 空白文本段(模型在工具调用间隙常吐空/换行 content):
      // 渲染即空气泡,还会切断过程卡分组 —— 跳过
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

/** 段条目 + 行级时长(下一段到达时刻 − 本段创建时刻;末段用卡截止时刻) */
type Entry = { s: RunSegment; i: number; durMs: number };

/** 过程卡:live 态展示工具行 + 思考行(活跃的为 ticker,已收口的保留可回看);
 *  settled 态收拢为一行摘要 chip(「已执行 x · n 步」),点击展开完整过程回看 */
function ProcessCard({
  entries,
  phase,
  endT,
  open,
  onToggle,
}: {
  entries: { s: ProcessSeg | TextSeg; i: number }[];
  phase: "live" | "settled";
  endT: number;
  open: boolean;
  onToggle: () => void;
}) {
  // live→settled 的收拢动画:翻转瞬间先以展开态渲染一帧(无过渡),下一帧放行
  // 默认的 0fr 过渡,让「过程收成摘要 chip」是一次可见的高度收拢而非硬切。
  // settled 单卡复用 live 首卡的 key(g{firstIdx}),实例跨相位保留,ref 才有意义
  const t = useT();
  const locale = useLocale();
  const prevPhase = useRef(phase);
  const [collapsing, setCollapsing] = useState(false);
  useEffect(() => {
    const wasLive = prevPhase.current === "live";
    prevPhase.current = phase;
    if (!wasLive || phase !== "settled") return;
    setCollapsing(true);
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setCollapsing(false));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [phase]);

  const rows: Entry[] = entries.map((e, k) => ({
    ...e,
    durMs: Math.max(0, (entries[k + 1]?.s.t ?? endT) - e.s.t),
  }));

  if (phase === "live") {
    return (
      <div className="trace msg-in">
        {rows.map((e) =>
          e.s.kind === "reasoning" ? (
            e.s.active ? (
              <TickerRow key={`r${e.i}`} item={e.s} />
            ) : (
              <ReasoningRow key={`r${e.i}`} item={e.s} durMs={e.durMs} />
            )
          ) : e.s.kind === "tool" ? (
            <ToolRow key={e.s.id} item={e.s} durMs={e.durMs} />
          ) : null,
        )}
      </div>
    );
  }

  const tools = rows
    .map((r) => r.s)
    .filter((s): s is ToolSeg => s.kind === "tool");
  const hasError = tools.some((tl) => tl.status === "error");
  const totalMs = Math.max(0, endT - rows[0].s.t);
  // 折叠摘要只报一个总时长 + 步数(业界惯例 "Thought for 5s"/"Worked for 2m"
  // 一律单一时长);思考耗时明细在展开区的各行里,不进摘要
  const meta = tools.length
    ? t("chat.trace.stepsMeta", { dur: fmtDur(totalMs, locale) })
    : t("chat.trace.thoughtMeta", { dur: fmtDur(totalMs, locale) });
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
        <span className="trace-tail">
          <ChevronIcon />
        </span>
      </button>
      <div
        className="trace-rows-wrap"
        style={
          collapsing
            ? {
                gridTemplateRows: "1fr",
                transition: "none",
                opacity: 1,
                visibility: "visible",
              }
            : undefined
        }
      >
        <div className="trace-rows">
          {rows.map((e) =>
            e.s.kind === "reasoning" ? (
              <ReasoningRow key={`r${e.i}`} item={e.s} durMs={e.durMs} />
            ) : e.s.kind === "text" ? (
              <TextRow key={`t${e.i}`} item={e.s} />
            ) : (
              <ToolRow key={e.s.id} item={e.s} durMs={e.durMs} />
            ),
          )}
        </div>
      </div>
    </div>
  );
}

/** 思考中 ticker:恒定行高的「思考窗」——标题行(shimmer + 计时)下方固定 3 行、
 *  底部锚定、顶部渐隐,流式期间不推挤布局;每秒重渲驱动行尾计时 */
function TickerRow({ item }: { item: ReasoningSeg }) {
  const t = useT();
  const locale = useLocale();
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((v) => v + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="trace-row" data-kind="reasoning" data-active="true">
      <div className="trace-line">
        <span className="trace-icon" aria-hidden="true">
          <SparkleIcon />
        </span>
        <span className="trace-label trace-shimmer">{t("chat.trace.thinking")}</span>
        <span className="trace-tail">
          <span className="trace-status">{fmtDur(Date.now() - item.t, locale)}</span>
        </span>
      </div>
      {item.text !== "" && (
        <div className="think-window" aria-hidden="true">
          <div className="reasoning-text">{windowSlice(item.text)}</div>
        </div>
      )}
    </div>
  );
}

/** 思考行(已收口):一行「思考过程 · 时长 · 字数」,点击展开完整文本回看。
 *  展开态是行内局部状态 —— 与 ToolRow 一致,不进 runSegs,
 *  否则会触发近底跟随的段更新 effect(旧版正是这样被拽底的) */
function ReasoningRow({ item, durMs }: { item: ReasoningSeg; durMs: number }) {
  const t = useT();
  const locale = useLocale();
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
          <span className="trace-status">
            {t("chat.trace.reasoningMeta", { dur: fmtDur(durMs, locale), n: item.text.length })}
          </span>
          <ChevronIcon />
        </span>
      </button>
      <div className="trace-body-wrap">
        <div className="trace-body">
          <div className="trace-copy-row">
            <CopyButton text={item.text} />
          </div>
          <div className="reasoning-text">
            {truncate(t, item.text, REASONING_MAX_CHARS)}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 回放思考行:历史 run 落盘的 reasoning_content。与实况思考行同一套视觉;
 *  耗时未落盘,尾部无计时。ReplayProcessCard 与行级使用(旧版单独成卡,
 *  现收进过程卡)共用 */
function ReplayReasoningRow({ text }: { text: string }) {
  const t = useT();
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
          <div className="trace-copy-row">
            <CopyButton text={text} />
          </div>
          <div className="reasoning-text">{truncate(t, text, REASONING_MAX_CHARS)}</div>
        </div>
      </div>
    </div>
  );
}

/** 回放过程卡:历史 run 投影的 processItems(思考/中间文案/工具调用+结果),
 *  折叠成只报步数的摘要 chip(耗时未落盘,不报时长),展开复用实况同一套
 *  行组件回看。由 ChatView 组合在收尾气泡上方 —— trace 已引用 AssistantBubble,
 *  bubbles 反向导入会成环 */
export function ReplayProcessCard({ items }: { items: ProcessItem[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const hasError = items.some((it) => it.kind === "tool" && it.error);
  const meta = items.some((it) => it.kind === "tool")
    ? t("chat.trace.replaySteps", { n: items.length })
    : t("chat.trace.replayThoughts", { n: items.length });
  return (
    <div className="trace msg-in" data-open={open}>
      <button
        type="button"
        className="trace-header trace-summary"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="trace-icon" aria-hidden="true">
          {hasError ? <MarkError /> : <MarkOk />}
        </span>
        <span className="trace-summary-meta">{meta}</span>
        <span className="trace-tail">
          <ChevronIcon />
        </span>
      </button>
      <div className="trace-rows-wrap">
        <div className="trace-rows">
          {items.map((it, i) =>
            it.kind === "reasoning" ? (
              <ReplayReasoningRow key={`r${i}`} text={it.text} />
            ) : it.kind === "text" ? (
              <TextRow key={`t${i}`} item={{ kind: "text", text: it.text, t: 0 }} />
            ) : (
              <ToolRow
                key={it.id || `tool${i}`}
                item={{
                  kind: "tool",
                  id: it.id,
                  name: it.name,
                  args: it.args,
                  result: it.result,
                  status: it.error ? "error" : "done",
                  t: 0,
                }}
              />
            ),
          )}
        </div>
      </div>
    </div>
  );
}

/** 中间文案行(轮内思考/工具之间的叙述文本):摘要为单行首行预览,展开回看全文 */
function TextRow({ item }: { item: TextSeg }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="trace-row" data-kind="text" data-open={open}>
      <button
        type="button"
        className="trace-header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="trace-icon" aria-hidden="true">
          <LinesIcon />
        </span>
        <span className="trace-label">{t("chat.trace.interim")}</span>
        <span className="trace-tail">
          <span className="trace-status trace-preview">{firstLine(item.text)}</span>
          <ChevronIcon />
        </span>
      </button>
      <div className="trace-body-wrap">
        <div className="trace-body">
          <div className="trace-copy-row">
            <CopyButton text={item.text} />
          </div>
          <div className="reasoning-text">
            {truncate(t, item.text, REASONING_MAX_CHARS)}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 工具行:名称 + 状态常显(对勾/叉以描边画入),参数/结果点击展开(摘要截断)。
 *  完成的尾部直接给耗时(✓ 图标已表达完成,不再重复「完成」二字,与
 *  Manus/Cursor 的每步计时一致);运行中/失败仍用文字。
 *  durMs 缺省 = 回放形态(耗时未落盘),完成态只留图标 */
function ToolRow({ item, durMs }: { item: ToolSeg; durMs?: number }) {
  const t = useT();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const statusText =
    item.status === "running"
      ? t("chat.trace.running")
      : item.status === "error"
        ? t("chat.trace.failed")
        : durMs === undefined
          ? ""
          : fmtDur(durMs, locale);
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
        <span className="trace-label">{toolLabel(t, item.name, item.displayName)}</span>
        <span className="trace-tail">
          {statusText !== "" && (
            <span className="trace-status">{statusText}</span>
          )}
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
  const t = useT();
  return (
    <>
      <div className="trace-sec-row">
        <span className="trace-sec">{label}</span>
        <CopyButton text={text} />
      </div>
      <pre className="trace-pre">{truncate(t, text, PREVIEW_CHARS)}</pre>
    </>
  );
}

/** 「复制」按钮:复制完整内容,点击后短暂闪烁「已复制」 */
function CopyButton({ text }: { text: string }) {
  const t = useT();
  const [copied, copy] = useCopyFlash();
  return (
    <button type="button" onClick={() => copy(text)} className="trace-copy-btn">
      {copied ? t("common.copied") : t("common.copy")}
    </button>
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

/** 毫秒 → 时长短文案(下限 1s,避免闪 0s):zh「5 秒 / 3 分 21 秒」,
 *  en「5s / 3m 21s」。locale 由调用方传入(useLocale 产物)——render 期
 *  辅助函数自读模块态会被 React Compiler 按参数缓存,语言切换后不刷新 */
function fmtDur(ms: number, locale: LocalePref): string {
  const s = Math.max(1, Math.round(ms / 1000));
  const zh = locale === "zh-CN";
  if (s < 60) return zh ? `${s} 秒` : `${s}s`;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return zh ? `${m} 分 ${sec} 秒` : `${m}m ${sec}s`;
}

/** 四角星(SF Symbols sparkle 风):思考过程的图标 */
function SparkleIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 2.75C8.6 5.4 10.6 7.4 13.25 8 10.6 8.6 8.6 10.6 8 13.25 7.4 10.6 5.4 8.6 2.75 8 5.4 7.4 7.4 5.4 8 2.75Z" />
    </svg>
  );
}

/** 三横线(文本段):中间文案行的图标 */
function LinesIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 4.5h10M3 8h10M3 11.5h6.5" />
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

/** 思考窗容量:窗口仅 ~3 行,1200 字符的尾部已远超可视量,避免整段长文常驻 DOM */
const WINDOW_CHARS = 1200;

/** 思考窗:截取尾部若干字符;落点劈开代理对时回退一个码元保持成对 */
function windowSlice(s: string): string {
  if (s.length <= WINDOW_CHARS) return s;
  let i = s.length - WINDOW_CHARS;
  const c = s.codePointAt(i) ?? 0;
  if (c >= 0xdc00 && c <= 0xdfff) i -= 1;
  return s.slice(i);
}

/** 单行预览:取首个非空行并去首尾空白 */
function firstLine(s: string): string {
  const line = s.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.trim();
}

/** 超长文本截断,尾部标注总字数(t 由调用方传入,理由同 fmtDur)。
 *  截断点落在代理对高半时回退一个码元(同 windowSlice 的处理),不渲染出
 *  替换符 */
function truncate(
  t: TFn,
  s: string,
  max: number,
): string {
  if (s.length <= max) return s;
  let end = max;
  const c = s.codePointAt(end) ?? 0;
  if (c >= 0xdc00 && c <= 0xdfff) end -= 1;
  return `${s.slice(0, end)}${t("chat.truncatedChars", { n: s.length })}`;
}
