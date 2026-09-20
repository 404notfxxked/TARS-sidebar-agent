// 撞窗紧急压缩的纯决策:是否触发 + 压缩后的发送投影。
// 从 callChat 闭包抽出,索引算术此前零单测。

import type { InternalMsg } from "../provider";
import { isContextOverflow } from "./compaction";

/**
 * 撞窗重试门:未做过紧急压缩、模型声明了上下文窗口、且错误命中撞窗文案
 * 才重试。emergency !== null(已压过)再撞窗说明压完还装不下,重试无益。
 */
export function shouldEmergencyCompact(
  err: unknown,
  emergency: unknown,
  contextTokens: number | undefined,
): boolean {
  return emergency === null && !!contextTokens && isContextOverflow(err);
}

/**
 * 压缩后的发送投影:摘要消息插在 system 后,真实消息从 afterIdx 起。
 * 不 mutate messages —— 持久化锚点(persistedInCtx/persistedSeqs)不受影响。
 *
 * afterIdx 的换算:compactHistory 吃 messages.slice(1)(去 system),产出的
 * uptoSeq 是该切片的 0 基下标;转回原 messages 要 +2(system 偏移 1 + slice
 * 端点转开区间 1),再交给 slice 作闭区间起点。
 */
export function projectEmergency(
  messages: InternalMsg[],
  summaryMsg: InternalMsg,
  afterIdx: number,
): InternalMsg[] {
  return [messages[0], summaryMsg, ...messages.slice(afterIdx)];
}
