/** "Receiving end does not exist" = 消息目标侧没有接收者:content 目标 tab
 *  没有 script(旧 tab / 特殊页,值得注入兜底),offscreen 文档刚建、listener
 *  尚未注册(值得短等重试)。其余错误照抛,由调用方区分 */
export function isNoReceiverError(err: unknown): boolean {
  return (
    err instanceof Error && err.message.includes("Receiving end does not exist")
  );
}
