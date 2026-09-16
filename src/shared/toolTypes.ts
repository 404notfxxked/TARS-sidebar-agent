// 工具 schema 类型 —— 注册表(tools.ts)与 LLM 契约(provider/types.ts)共用
// 纯 schema,不含 execute:描述「工具长什么样」,不描述「怎么执行」

export interface ToolSchema {
  type: "function";
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// ---- 截图附件(page_screenshot 结果的图片旁路)----
// OpenAI 协议的 tool 消息 content 只支持文本,图片不能走 tool content。
// 约定:工具结果带 screenshot 字段时,agent 循环用 takeScreenshot 剥出字节、
// 紧随工具消息注入一条带图 user 消息(与用户上传图同一条 wire/落库管线);
// stripScreenshot 保证字节不进 tool 消息、不进日志。

export interface ToolScreenshot {
  /** 已降采样编码的图像字节(JPEG) */
  bytes: Uint8Array;
  mime: string;
  w: number;
  h: number;
}

export function takeScreenshot(result: unknown): ToolScreenshot | null {
  if (!result || typeof result !== "object" || !("screenshot" in result)) {
    return null;
  }
  const s = (result as { screenshot?: unknown }).screenshot;
  if (
    s &&
    typeof s === "object" &&
    "bytes" in s &&
    ((s as { bytes: unknown }).bytes instanceof Uint8Array)
  ) {
    return s as ToolScreenshot;
  }
  return null;
}

export function stripScreenshot<T>(result: T): T {
  if (result && typeof result === "object" && "screenshot" in result) {
    const { screenshot: _s, ...rest } = result as Record<string, unknown>;
    return rest as T;
  }
  return result;
}
