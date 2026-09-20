/** JSON.parse 失败回空对象:wire 上可能坏掉的 JSON 字段(工具 args、思考块
 *  signature)宽松解析,单条坏数据不当炸整条流 */
export function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
