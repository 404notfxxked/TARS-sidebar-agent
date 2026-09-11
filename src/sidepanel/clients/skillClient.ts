// 面板侧 SKILL_* 轻客户端:一次性端口请求,等后台回 SKILLS 全量列表。
// 技能页(增删改/启停)与聊天区 / 菜单共用;CRUD 全走消息,面板不碰 IDB
// (SW 是唯一读写方,同 memoryClient 的约束)。

import { MSG, PORT_NAME, type SkillInfo } from "../../shared/messages";

/** SKILL_* 请求 → 等第一条 SKILLS 应答(列表 + 可选 error) */
export function skillReq(msg: Record<string, unknown>): Promise<{
  skills: SkillInfo[];
  error?: string;
}> {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: PORT_NAME });
    port.onMessage.addListener(
      (evt: { type?: string; skills?: SkillInfo[]; error?: string }) => {
        if (evt.type === MSG.SKILLS) {
          resolve({ skills: evt.skills ?? [], error: evt.error });
          port.disconnect();
        }
      },
    );
    port.onDisconnect.addListener(() => reject(new Error("port closed")));
    port.postMessage(msg);
  });
}

/** 按 id 取 SKILL.md 原文(编辑视图);行已删除时 raw 为 undefined */
export function skillRawReq(
  id: string,
): Promise<{ id: string; raw?: string }> {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: PORT_NAME });
    port.onMessage.addListener(
      (evt: { type?: string; id?: string; raw?: string }) => {
        if (evt.type === MSG.SKILL_RAW && evt.id === id) {
          resolve({ id, raw: evt.raw });
          port.disconnect();
        }
      },
    );
    port.onDisconnect.addListener(() => reject(new Error("port closed")));
    port.postMessage({ type: MSG.SKILL_GET, id });
  });
}
