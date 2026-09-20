/** unknown 错误 → 文本:Error 取 message,其余 String 化。
 *  要 stack 的诊断场景不走这里(直接判 instanceof 取 .stack,见 logger) */
export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
