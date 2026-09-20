// 请求侧图片投影:按视觉能力与字节预算决定哪些图片随请求发送。
// ⚠️ 只做投影,不改内存 loop.messages、不落盘 —— 溢出裁剪同理,落盘保持
// 全量历史(架构不变式 15①)。图片只在 user 角色发送 —— OpenAI 规范的
// tool/assistant 消息不支持 image_url,兼容端点同此。

import type { InternalMsg } from "../provider";
import { loadImage } from "../sessions/sessionHistory";
import { createLogger } from "../../shared/logger";
import type { RunLoopState } from "./agent";

const log = createLogger({ ctx: "bg" });

// 随请求发送的字节预算:超出时最旧的图不再随请求发送,只留文字
const IMAGE_WIRE_BUDGET_BYTES = 8 * 1024 * 1024;

/** 组装本轮请求消息:按视觉能力与字节预算决定哪些图片随请求发送。 */
export async function projectForRequest(
  loop: RunLoopState,
  visionOk: boolean,
  msgs: InternalMsg[],
): Promise<InternalMsg[]> {
  const hasImages = msgs.some(
    (m) => m.role === "user" && (m.images?.length ?? 0) > 0,
  );
  if (!hasImages) return msgs;
  // 水合:优先用内存字节(本轮新图),其次 images store(历史旧图)
  for (const m of msgs) {
    if (m.role !== "user" || !m.images) continue;
    for (const im of m.images) {
      if (im.bytes) {
        loop.imageBytes.set(im.id, im.bytes);
      } else if (!loop.imageBytes.has(im.id)) {
        const row = await loadImage(im.id).catch(() => undefined);
        if (row) loop.imageBytes.set(im.id, row.bytes);
      }
    }
  }
  if (!visionOk) {
    // 模型不支持视觉:全部图片不进请求(面板本就禁止发图,这里兜底,
    // 防「发完图切到非视觉模型再追问」这类路径把 400 炸出来)。
    // 被剥离的消息追加系统注,让模型知道用户发过图、为何看不见 ——
    // 只改请求侧投影,落盘与内存的 messages 不受影响
    return msgs.map((m) => {
      if (m.role !== "user" || !m.images?.length) return m;
      return {
        role: "user",
        content: `${m.content}\n[系统注：此消息原本附有 ${m.images.length} 张图片；当前模型不支持视觉识别，图片未随本次请求发送]`,
      };
    });
  }
  // 字节预算:从最新的图片往回分配,超支的旧图不出现在请求里
  const included = new Set<string>();
  let budget = IMAGE_WIRE_BUDGET_BYTES;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== "user" || !m.images) continue;
    for (let j = m.images.length - 1; j >= 0; j--) {
      const im = m.images[j];
      const size = loop.imageBytes.get(im.id)?.byteLength ?? 0;
      if (size > 0 && size <= budget) {
        budget -= size;
        included.add(im.id);
      }
    }
  }
  log.debug("agent", "image projection", {
    visionOk,
    hydrated: [...loop.imageBytes.entries()].map(
      ([id, b]) => `${id.slice(0, 8)}:${b.byteLength}`,
    ),
    included: included.size,
  });
  return msgs.map((m) => {
    if (m.role !== "user") return m;
    const imgs = (m.images ?? []).filter((im) => included.has(im.id));
    if (imgs.length === 0) return { role: "user", content: m.content };
    return {
      role: "user",
      content: m.content,
      images: imgs.map((im) => ({ ...im, bytes: loop.imageBytes.get(im.id) })),
    };
  });
}
