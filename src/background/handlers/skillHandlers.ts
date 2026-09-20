// skill 域 port 消息 handler:技能列表/导入/编辑回填/更新/启停/删除。
// 列表统一回 skillInfos(行形状,不含正文);导入/更新失败不静默,错误随
// SKILLS 回面板就地展示。skillInfos 自 index.ts 随拆分迁入(它只被本域用)。

import { MSG, type SideToBg, type SkillInfo } from "../../shared/messages";
import { renderSkillMarkdown } from "../../shared/skills";
import { errText } from "../../shared/errors";
import { createLogger } from "../../shared/logger";
import {
  deleteSkill,
  importSkill,
  listSkills,
  setSkillEnabled,
  updateSkill,
} from "../skills/skillStore";
import { getSkillRow } from "../sessions/sessionDb";
import type { PortCtx } from "./context";

const log = createLogger({ ctx: "bg" });

/** SkillRow → 面板展示形状(不含正文;chars 做量级提示) */
async function skillInfos(): Promise<SkillInfo[]> {
  return (await listSkills()).map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    enabled: r.enabled,
    updatedAt: r.updatedAt,
    chars: r.body.length,
  }));
}

export async function handleSkillMessage(
  msg: SideToBg,
  ctx: PortCtx,
): Promise<boolean> {
  const { port } = ctx;
  switch (msg.type) {
    case MSG.SKILL_LIST: {
      port.postMessage({ type: MSG.SKILLS, skills: await skillInfos() });
      return true;
    }
    case MSG.SKILL_ADD: {
      // 解析失败(缺字段/超限)不静默:错误随 SKILLS 回面板就地展示,
      // 列表仍回后台实际状态 —— 面板不需要再发一次 LIST
      try {
        await importSkill(msg.raw);
        port.postMessage({ type: MSG.SKILLS, skills: await skillInfos() });
      } catch (err) {
        log.warn("skills", "技能导入失败", {
          error: errText(err),
        });
        port.postMessage({
          type: MSG.SKILLS,
          skills: await skillInfos(),
          error: errText(err),
        });
      }
      return true;
    }
    case MSG.SKILL_GET: {
      // 编辑视图:行重组回 SKILL.md 原文(frontmatter 由 name/description 还原)
      const row = await getSkillRow(msg.id).catch(() => undefined);
      port.postMessage({
        type: MSG.SKILL_RAW,
        id: msg.id,
        ...(row
          ? {
              raw: renderSkillMarkdown(row.name, row.description, row.body),
            }
          : {}),
      });
      return true;
    }
    case MSG.SKILL_UPDATE: {
      try {
        await updateSkill(msg.id, msg.raw);
        port.postMessage({ type: MSG.SKILLS, skills: await skillInfos() });
      } catch (err) {
        log.warn("skills", "技能更新失败", {
          error: errText(err),
        });
        port.postMessage({
          type: MSG.SKILLS,
          skills: await skillInfos(),
          error: errText(err),
        });
      }
      return true;
    }
    case MSG.SKILL_TOGGLE: {
      try {
        await setSkillEnabled(msg.id, msg.enabled);
        port.postMessage({ type: MSG.SKILLS, skills: await skillInfos() });
      } catch (err) {
        port.postMessage({
          type: MSG.SKILLS,
          skills: await skillInfos(),
          error: errText(err),
        });
      }
      return true;
    }
    case MSG.SKILL_DELETE: {
      await deleteSkill(msg.id);
      port.postMessage({ type: MSG.SKILLS, skills: await skillInfos() });
      return true;
    }
    default:
      return false;
  }
}
