/** 压平空白并截断(词边界不苛求),超出补省略号表示不完整。
 *  日志预览字段(标题/摘要/query)与结果字段裁剪都用它:query 在日志里只留
 *  40 字符 —— 完整原文已在工具结果与轨迹卡里,导出诊断日志时不必带走长原文 */
export function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  // UTF-16 下标截断会劈开代理对(emoji 等 astral 字符):切点落在码元中间
  // 会把孤立半字喂给模型(搜索标题/摘要可见);末位是高代理时回退一位保住整对
  const cut = flat.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  const safe = last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
  return `${safe}…`;
}
