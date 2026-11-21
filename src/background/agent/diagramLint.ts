// 图表源码收尾自检:最终回答落定后扫描 mermaid/echarts 围栏块 —— echarts
// 本地 JSON.parse 验,mermaid 经 offscreen diagram_validate(parse-only,不
// 渲染)。有坏块产出英文修复 note 交 loop 回喂模型自修复;note 以
// SYSTEM_NOTE_PREFIX 开头是压缩轮切分契约(系统注记算上一轮延续,不算新的
// 一轮)。提取器按 CommonMark 围栏规则(0-3 空格缩进、闭栏同字符且不短于
// 开栏、反引号栏 info 串含反引号即失效);列表内深缩进围栏不识别 —— 漏检
// 方向安全(少校验不误报),渲染端 react-markdown 照常处理。note 的块数/
// 错误长度/总长都有显式上限:它是发给模型的文本,受输入预算纪律约束。

import {
  callOffscreenParser,
  ensureOffscreenDocument,
} from "../../shared/docBridge";
import { errText } from "../../shared/errors";
import { createLogger } from "../../shared/logger";
import { SYSTEM_NOTE_PREFIX } from "./compaction";

const log = createLogger({ ctx: "bg" });

export type DiagramLang = "mermaid" | "echarts";

export interface DiagramBlock {
  lang: DiagramLang;
  source: string;
}

const FENCE_OPEN_RE = /^[ ]{0,3}(`{3,}|~{3,})[ \t]*(.*)$/;
const FENCE_CLOSE_RE = /^[ ]{0,3}(`{3,}|~{3,})[ \t]*$/;

/** 提取回答里的图表围栏块(白名单 mermaid/echarts,保序) */
export function extractDiagramBlocks(md: string): DiagramBlock[] {
  const blocks: DiagramBlock[] = [];
  let fence: { char: string; len: number; lang: string } | null = null;
  let source: string[] = [];
  const isDiagram = (lang: string): lang is DiagramLang =>
    lang === "mermaid" || lang === "echarts";
  for (const line of md.split("\n")) {
    if (fence) {
      const close = FENCE_CLOSE_RE.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.len) {
        if (isDiagram(fence.lang)) {
          blocks.push({ lang: fence.lang, source: source.join("\n") });
        }
        fence = null;
        source = [];
      } else {
        source.push(line);
      }
    } else {
      const open = FENCE_OPEN_RE.exec(line);
      if (!open) continue;
      const info = open[2].trim();
      // CommonMark:反引号围栏的 info 串不允许出现反引号(出现即不是围栏)
      if (open[1][0] === "`" && info.includes("`")) continue;
      fence = { char: open[1][0], len: open[1].length, lang: info.split(/\s+/)[0] ?? "" };
      source = [];
    }
  }
  // 尾部未闭合围栏:截断/漏写闭栏的残段,渲染端也会当代码展示 —— 按剩余
  // 文本成块,校验方向与渲染一致
  if (fence && isDiagram(fence.lang)) {
    blocks.push({ lang: fence.lang, source: source.join("\n") });
  }
  return blocks;
}

interface DiagramFailure {
  lang: DiagramLang;
  error: string;
}

/** note 显式上限(发给模型的文本必须有界):块数、单错长度、总长三道闸 */
const NOTE_MAX_CHARS = 2000;
const NOTE_MAX_LISTED = 8;
const NOTE_ERROR_MAX_CHARS = 200;

function buildFixNote(failures: DiagramFailure[]): string {
  const listed = failures
    .slice(0, NOTE_MAX_LISTED)
    .map(
      (f, i) =>
        `- block ${i + 1} (${f.lang}): ${f.error.slice(0, NOTE_ERROR_MAX_CHARS)}`,
    );
  const rest = failures.length - listed.length;
  const lines = [
    `${SYSTEM_NOTE_PREFIX} automatic diagram check found ${failures.length} invalid code block(s) in your previous answer:`,
    ...listed,
    ...(rest > 0 ? [`(and ${rest} more invalid block(s) not listed)`] : []),
    "Resend ONLY the corrected fenced code block(s) with the same language tag (```mermaid or ```echarts), one block per failure. Do not add any commentary and do not repeat the unchanged parts of your answer.]",
  ];
  return lines.join("\n").slice(0, NOTE_MAX_CHARS);
}

/**
 * 校验回答里的全部图表块:全通过(或无图表块)返回 null,否则返回回喂
 * 修复 note。mermaid 校验基础设施不可用(offscreen 未起/请求超时)时该块
 * 按「无法判定」跳过 —— 计坏会诱导模型重写本来合法的源码
 */
export async function validateDiagrams(content: string): Promise<string | null> {
  const blocks = extractDiagramBlocks(content);
  if (blocks.length === 0) return null;
  const failures: DiagramFailure[] = [];
  for (const block of blocks) {
    if (block.lang === "echarts") {
      try {
        JSON.parse(block.source);
      } catch (e) {
        failures.push({ lang: "echarts", error: errText(e) });
      }
      continue;
    }
    try {
      await ensureOffscreenDocument();
      const r = (await callOffscreenParser(
        "diagram_validate",
        { source: block.source },
        15_000,
      )) as { ok?: boolean; error?: string } | null;
      if (r?.ok === true) continue;
      failures.push({
        lang: "mermaid",
        error: r?.error ?? "validator returned no error detail",
      });
    } catch (e) {
      log.warn("agent", "diagram validate unavailable, block skipped", {
        error: errText(e),
      });
    }
  }
  return failures.length > 0 ? buildFixNote(failures) : null;
}
