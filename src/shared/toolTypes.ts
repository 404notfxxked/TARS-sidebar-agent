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
