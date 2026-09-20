// 面板侧 SKILL_* 轻客户端:一次性端口请求,等后台回 SKILLS 全量列表。
// 技能页(增删改/启停)与聊天区 / 菜单共用;CRUD 全走消息,面板不碰 IDB
// (SW 是唯一读写方,同 memoryClient 的约束)。

import { MSG, type SkillInfo } from "../../shared/messages";
import { portReq } from "./portRequest";

/** SKILL_* 请求 → 等第一条 SKILLS 应答(列表 + 可选 error) */
export async function skillReq(msg: Record<string, unknown>): Promise<{
  skills: SkillInfo[];
  error?: string;
}> {
  const evt = await portReq<{ skills?: SkillInfo[]; error?: string }>(
    msg,
    MSG.SKILLS,
  );
  return { skills: evt.skills ?? [], error: evt.error };
}

/** 按 id 取 SKILL.md 原文(编辑视图);行已删除时 raw 为 undefined */
export async function skillRawReq(
  id: string,
): Promise<{ id: string; raw?: string }> {
  const evt = await portReq<{ id?: string; raw?: string }>(
    { type: MSG.SKILL_GET, id },
    MSG.SKILL_RAW,
    (e) => e.id === id,
  );
  return { id, raw: evt.raw };
}
