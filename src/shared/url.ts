/** baseUrl → 主机名(供应商/服务器未命名时的展示兜底)。裸 new URL 会抛:
 *  「添加服务」建出的供应商 baseUrl 可为空串,解析失败回空串,不设防会把
 *  渲染它的面板炸白屏 */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
