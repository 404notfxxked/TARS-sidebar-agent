// 工具调用的并行批次划分(纯函数层,单测覆盖)。
// ReAct 一轮可能带回多个工具调用:相邻的只读工具互不依赖,批内并行执行
// 压缩时延;写页工具(click/fill)与语义未知的 MCP 工具自成单批串行 ——
// 写动作必须逐个过确认门,未知工具不假设其只读。

/** 并行安全的只读工具(无副作用、互不依赖;find_elements 只观察不动作) */
export const PARALLEL_SAFE_TOOLS: ReadonlySet<string> = new Set([
  "get_tabs",
  "page_read",
  "page_find",
  "page_outline",
  "web_search",
  "web_fetch",
  "find_elements",
]);
// page_screenshot 刻意不进只读集:画标记 → 捕获 → 摘标记必须是原子序列,
// 同批其它工具并发改页会让截图拍到中间态

/** 单批并行上限:多路 web_search 会同时开多个真实标签页,并发过高
 *  既拖慢单路时延又容易触发引擎风控 */
export const MAX_PARALLEL_TOOLS = 3;

/**
 * 把一轮的工具调用切成有序批次:相邻的并行安全工具并入同批
 * (上限 MAX_PARALLEL_TOOLS,超出开新批),其余工具自成单批。
 * 执行语义:批次按序跑,批内 Promise.all;结果必须按原始顺序回填。
 */
export function partitionToolBatches<T extends { name: string }>(
  calls: T[],
): T[][] {
  const batches: T[][] = [];
  let i = 0;
  while (i < calls.length) {
    if (!PARALLEL_SAFE_TOOLS.has(calls[i].name)) {
      batches.push([calls[i]]);
      i++;
      continue;
    }
    const batch: T[] = [];
    while (
      i < calls.length &&
      batch.length < MAX_PARALLEL_TOOLS &&
      PARALLEL_SAFE_TOOLS.has(calls[i].name)
    ) {
      batch.push(calls[i]);
      i++;
    }
    batches.push(batch);
  }
  return batches;
}
