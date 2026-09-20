/** 压平空白并截断(词边界不苛求),超出补省略号表示不完整。
 *  日志预览字段(标题/摘要/query)与结果字段裁剪都用它:query 在日志里只留
 *  40 字符 —— 完整原文已在工具结果与轨迹卡里,导出诊断日志时不必带走长原文 */
export function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
