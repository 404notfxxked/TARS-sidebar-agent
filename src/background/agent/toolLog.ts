// 工具日志的入参脱敏(硬规则 12 判据:「导出诊断时是否带走超出功能必需的
// 原文」)。fill_input 的 text 是用户输入原文(密码/OTP/卡号高频出现),
// logger 的键名脱敏(REDACT_KEY_RE 只匹配键名)罩不住它 —— 写日志前在此
// 替换为长度占位,选择器与 pressEnterAfter 保留可诊断。
// 面板侧 AGENT_TOOL_CALL 事件不经此处:UI 展示给用户本人且不进诊断导出,
// 确认卡也需要原文供人审。

export function redactToolArgsForLog(name: string, args: unknown): unknown {
  if (name === "fill_input" && typeof args === "object" && args !== null) {
    const a = args as Record<string, unknown>;
    if (typeof a.text === "string") {
      return { ...a, text: `[redacted ${a.text.length} chars]` };
    }
  }
  return args;
}
