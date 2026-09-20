// 工具结果 → 观察文本的格式化:agent.ts 的工具日志/回填与各执行模块共用。

/** 工具结果转成可回填的字符串(LLM 收到的 observation) */
export function stringifyResult(r: unknown): string {
  if (typeof r === "string") return r;
  try {
    return JSON.stringify(r);
  } catch {
    return String(r);
  }
}
