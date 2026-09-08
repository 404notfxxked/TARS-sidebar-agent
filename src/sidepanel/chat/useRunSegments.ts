// 本轮执行流的状态层:思考/文本/工具段的落段、缓冲合流、收口与归档。
// 从 ChatView 拆出的纯状态 hook,不碰 port;段类型与渲染见 trace.tsx。
//
// 核心机制:
// - ref 镜像让 port 事件回调(只注册一次,闭包停留在首帧)总是读到最新段序列,
//   且允许一次事件里连贯地「读 → 变 → 写」,避免函数式 setState 里嵌套副作用
// - 思考流/正文流各带缓冲:delta 先进缓冲,按固定节拍(~10Hz)合入状态,
//   长回答避免「每 delta 全量重解析 markdown」的 O(n²) 重复解析

import { useEffect, useRef, useState } from "react";
import { MSG, type AgentEvent } from "../../shared/messages";
import type {
  ProcessSeg,
  ReasoningSeg,
  RunSegment,
  TextSeg,
  ToolSeg,
} from "./trace";

type ToolCallEvent = Extract<AgentEvent, { type: typeof MSG.AGENT_TOOL_CALL }>;
type ToolResultEvent = Extract<
  AgentEvent,
  { type: typeof MSG.AGENT_TOOL_RESULT }
>;

/**
 * 执行流状态机。onArchiveTexts:一轮结束把文本段归档成 assistant 消息的出口
 * (ChatView 侧落 messages,附当前 sessionId)。返回的操作按 port 事件一一对应。
 */
export function useRunSegments(
  onArchiveTexts: (texts: string[]) => void,
) {
  // 归档回调经 ref 转发:hook 操作保持稳定语义,回调实现可随渲染刷新
  const archiveRef = useRef(onArchiveTexts);
  archiveRef.current = onArchiveTexts;

  const [runSegs, setRunSegs] = useState<RunSegment[]>([]);
  const runSegsRef = useRef<RunSegment[]>([]);
  // streamingRef:正文段是否在流式中。appendTextDelta 以它区分「续段」与「开新段」,
  // AGENT_THINKING / 工具开始把它切断,下一个文本 delta 自然开新段
  const streamingRef = useRef(false);
  const applySegs = (next: RunSegment[]) => {
    runSegsRef.current = next;
    setRunSegs(next);
  };
  /** live = 执行中(过程卡全展开);settled = 已结束(过程卡收成摘要 chip) */
  const [runPhase, setRunPhase] = useState<"live" | "settled">("settled");
  const runPhaseRef = useRef<"live" | "settled">("settled");
  const setPhase = (p: "live" | "settled") => {
    runPhaseRef.current = p;
    setRunPhase(p);
  };
  const [runEndedAt, setRunEndedAt] = useState<number | null>(null);
  /** 已展开回看的过程卡(以卡内首段在 segs 中的下标为 key,段序列只追加、下标即稳定身份) */
  const [openGroups, setOpenGroups] = useState<Set<number>>(new Set());

  // ---- 思考流缓冲:delta 先进缓冲,按固定节拍合入状态 ----
  // 流式期间只渲染单行 ticker(尾部内容),行高恒定不推挤后续消息;
  // 渲染频率从「每 delta 一次」降到 ~10Hz
  const reasoningBufRef = useRef("");
  const reasoningFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- 正文流缓冲:同一节拍策略。否则每个 delta 全量重解析该段 markdown,
  // 长回答是 O(n²) 重复解析;合帧到 ~10Hz 后,重解析频率与段长解耦 ----
  const textBufRef = useRef("");
  const textFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 把缓冲同步合入最后一个活跃思考段(节拍到期 / 阶段收口前调用) */
  const flushReasoning = () => {
    if (reasoningFlushRef.current !== null) {
      clearTimeout(reasoningFlushRef.current);
      reasoningFlushRef.current = null;
    }
    const buf = reasoningBufRef.current;
    if (!buf) return;
    reasoningBufRef.current = "";
    const segs = runSegsRef.current;
    const last = segs[segs.length - 1];
    if (last?.kind === "reasoning" && last.active) {
      applySegs([...segs.slice(0, -1), { ...last, text: last.text + buf }]);
    }
    // 活跃段已被收口(异常时序),缓冲无从归属,丢弃
  };

  /** 直接丢弃缓冲(新一轮开始 / 清空对话:旧缓冲不属于任何段) */
  const dropReasoningBuf = () => {
    if (reasoningFlushRef.current !== null) {
      clearTimeout(reasoningFlushRef.current);
      reasoningFlushRef.current = null;
    }
    reasoningBufRef.current = "";
  };

  /** 把缓冲同步合入最后一个文本段(节拍到期 / 阶段收口前调用);
   *  末段已不是文本段(时序异常)时缓冲无从归属,丢弃 */
  const flushText = () => {
    if (textFlushRef.current !== null) {
      clearTimeout(textFlushRef.current);
      textFlushRef.current = null;
    }
    const buf = textBufRef.current;
    if (!buf) return;
    textBufRef.current = "";
    const segs = runSegsRef.current;
    const last = segs[segs.length - 1];
    if (last?.kind === "text") {
      applySegs([...segs.slice(0, -1), { ...last, text: last.text + buf }]);
    }
  };

  /** 直接丢弃正文缓冲(同 dropReasoningBuf) */
  const dropTextBuf = () => {
    if (textFlushRef.current !== null) {
      clearTimeout(textFlushRef.current);
      textFlushRef.current = null;
    }
    textBufRef.current = "";
  };

  // reasoning delta → 入缓冲;末段不是活跃思考段则先开新段(行立即出现,文本由节拍供给)
  const appendReasoning = (delta: string) => {
    reasoningBufRef.current += delta;
    const segs = runSegsRef.current;
    const last = segs[segs.length - 1];
    if (!(last?.kind === "reasoning" && last.active)) {
      applySegs([
        ...segs,
        { kind: "reasoning", text: "", active: true, t: Date.now() },
      ]);
    }
    if (reasoningFlushRef.current === null) {
      reasoningFlushRef.current = setTimeout(flushReasoning, 100);
    }
  };

  // 任何「下一阶段」事件(工具开始 / 文本开始)→ 先冲刷两种缓冲(别丢尾部字符),再收口活跃思考段
  const collapseReasoning = () => {
    flushReasoning();
    flushText();
    const segs = runSegsRef.current;
    if (segs.some((s) => s.kind === "reasoning" && s.active)) {
      applySegs(
        segs.map((s) =>
          s.kind === "reasoning" && s.active ? { ...s, active: false } : s,
        ),
      );
    }
  };

  /** 文本 delta:已在文本段则入缓冲按节拍合入;否则开新段(首 delta 立即上屏) */
  const appendTextDelta = (delta: string) => {
    const segs = runSegsRef.current;
    const last = segs[segs.length - 1];
    if (streamingRef.current && last?.kind === "text") {
      textBufRef.current += delta;
      if (textFlushRef.current === null) {
        textFlushRef.current = setTimeout(flushText, 100);
      }
    } else {
      flushText(); // 防御:残留缓冲仍归属上一个文本段
      streamingRef.current = true;
      applySegs([...segs, { kind: "text", text: delta, t: Date.now() }]);
    }
  };

  const pushTool = (evt: ToolCallEvent) => {
    flushText(); // 正文缓冲归属前一段,先落盘再追加工具段
    const segs = runSegsRef.current;
    applySegs([
      ...segs,
      {
        kind: "tool",
        id: evt.id,
        name: evt.name,
        displayName: evt.displayName,
        args: evt.args,
        status: "running",
        t: Date.now(),
      },
    ]);
  };

  const applyToolResult = (evt: ToolResultEvent) => {
    const segs = runSegsRef.current;
    if (!segs.some((s) => s.kind === "tool" && s.id === evt.id)) return;
    applySegs(
      segs.map((s) =>
        s.kind === "tool" && s.id === evt.id
          ? { ...s, status: evt.ok ? "done" : "error", result: evt.result }
          : s,
      ),
    );
  };

  /** 结束兜底:冲刷缓冲、归一残留 running 工具(防 spinner 卡死)、收口思考段、记录结束时刻 */
  const settleRun = () => {
    streamingRef.current = false;
    flushReasoning();
    flushText();
    const segs = runSegsRef.current;
    const next = segs.map((s) => {
      if (s.kind === "reasoning") return s.active ? { ...s, active: false } : s;
      if (s.kind === "tool")
        return s.status === "running" ? { ...s, status: "done" as const } : s;
      return s;
    });
    applySegs(next);
    setRunEndedAt(Date.now());
    setPhase("settled");
  };

  /** 归档:把本轮文本段依序转成 assistant 消息落回 messages。
   *  在追加下一条 user 消息之前调用,保证旧答案永远排在新问题之前;
   *  过程段不归档(不持久化),由随后的 newRound 丢弃 */
  const archiveTexts = () => {
    flushReasoning();
    flushText();
    streamingRef.current = false;
    const segs = runSegsRef.current;
    // 空白文本段与渲染侧同规则跳过:不归档成空气消息
    const texts = segs.filter(
      (s): s is TextSeg => s.kind === "text" && s.text.trim().length > 0,
    );
    if (texts.length === 0) return;
    archiveRef.current(texts.map((s) => s.text));
    applySegs(segs.filter((s) => s.kind !== "text"));
  };

  /** 新一轮:清空段序列与回看开关 */
  const newRound = () => {
    dropReasoningBuf();
    streamingRef.current = false;
    applySegs([]);
    setRunEndedAt(null);
    setOpenGroups(new Set());
    setPhase("live");
  };

  const toggleGroup = (firstIdx: number) =>
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(firstIdx)) next.delete(firstIdx);
      else next.add(firstIdx);
      return next;
    });

  // 卸载兜底:清节拍定时器与缓冲,避免卸载后 setState
  useEffect(
    () => () => {
      streamingRef.current = false;
      dropReasoningBuf();
      dropTextBuf();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return {
    /** 段序列:思考/文本/工具交错,渲染层(RunZone)直接消费 */
    runSegs,
    runPhase,
    runEndedAt,
    openGroups,
    toggleGroup,
    /** AGENT_STARTED:文本段归档兜底(正常在 submit 已做)+ 开新一轮 */
    onStarted: () => {
      archiveTexts();
      newRound();
    },
    /** AGENT_THINKING:切断文本段,下一 delta 开新段 */
    onThinking: () => {
      streamingRef.current = false;
    },
    onReasoningDelta: appendReasoning,
    /** AGENT_MESSAGE:文本开始 = 下一阶段,先收口思考段再进段流式 */
    onMessageDelta: (delta: string) => {
      collapseReasoning();
      appendTextDelta(delta);
    },
    /** AGENT_TOOL_CALL:收口思考段、落工具段、切断正文段 */
    onToolCall: (evt: ToolCallEvent) => {
      collapseReasoning();
      pushTool(evt);
      streamingRef.current = false;
    },
    onToolResult: applyToolResult,
    /** AGENT_DONE / AGENT_ERROR:冲刷缓冲、归一残留段、记录结束时刻 */
    onSettled: settleRun,
    /** port 断开:run 已死(SW 休眠/刷新),归一残留状态避免 UI 卡在 thinking;
     *  已结束(settled)的展示不动,用户可能正在回看 */
    onPortDisconnected: () => {
      streamingRef.current = false;
      if (runPhaseRef.current === "live") settleRun();
    },
    /** submit / 切会话 / 新对话时手动归档本轮文本段 */
    archiveTexts,
    newRound,
  };
}

/** 段类型再导出:ChatView 组装 props 时用,不必再开 trace 的导入清单 */
export type { RunSegment, ProcessSeg, ReasoningSeg, TextSeg, ToolSeg };
