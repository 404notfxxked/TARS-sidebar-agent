// 技能领域层:SKILL.md 的导入/编辑/启停/删除,一行一条存 IndexedDB
// (db "tars" 的 skills store,经 sessionDb 底层函数访问;同 memoryStore 的
// 单写者纪律 —— 面板经消息协议间接读写)。
//
// 设计要点:
// - 解析与校验全在 shared/skills.ts(纯函数),这里只做领域规则:同名 upsert、
//   改名时全库查重、列表按 name 排序(/ 菜单的次序要稳定可预期)
// - 调用入口 getEnabledSkillByName 只认启用技能;查不到返回 null,调用方
//   (agent)原样透传文本,不报错不打断 —— 与 MCP 幻觉工具名的宽容纪律一致
// - 错误一律 throw 带原因的 Error(解析错误原文来自 shared/skills,英文诊断串,
//   面板在「保存失败:{error}」里展示),不静默吞

import { createLogger } from "../../shared/logger";
import { parseSkillMarkdown } from "../../shared/skills";
import type { SkillRow } from "../sessions/sessionDb";
import {
  deleteSkillRow,
  getSkillRow,
  listSkillRows,
  putSkillRow,
} from "../sessions/sessionDb";

const log = createLogger({ ctx: "bg" });

/** 全部技能,按 name 字典序(菜单与列表次序稳定) */
export async function listSkills(): Promise<SkillRow[]> {
  const rows = await listSkillRows();
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/** 导入(新增或同名覆盖):name 相同视为同一技能,保留 id/创建时间/启停状态 */
export async function importSkill(
  raw: string,
): Promise<{ row: SkillRow; replaced: boolean }> {
  const parsed = parseSkillMarkdown(raw);
  const all = await listSkillRows();
  const now = Date.now();
  const prev = all.find((r) => r.name === parsed.name);
  const row: SkillRow = prev
    ? { ...prev, description: parsed.description, body: parsed.body, updatedAt: now }
    : {
        id: crypto.randomUUID(),
        name: parsed.name,
        description: parsed.description,
        body: parsed.body,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      };
  await putSkillRow(row);
  log.info("skills", prev ? "技能已覆盖更新" : "技能已安装", {
    name: row.name,
    chars: row.body.length,
  });
  return { row, replaced: !!prev };
}

/** 编辑:重新解析全文(name 允许改,全库查重);id/创建时间/启停状态保留 */
export async function updateSkill(id: string, raw: string): Promise<SkillRow> {
  const parsed = parseSkillMarkdown(raw);
  const prev = await getSkillRow(id);
  if (!prev) throw new Error("Skill not found or already deleted");
  const clash = (await listSkillRows()).find(
    (r) => r.id !== id && r.name === parsed.name,
  );
  if (clash) throw new Error(`Another skill already uses the name "${parsed.name}"`);
  const row: SkillRow = {
    ...prev,
    name: parsed.name,
    description: parsed.description,
    body: parsed.body,
    updatedAt: Date.now(),
  };
  await putSkillRow(row);
  log.info("skills", "技能已更新", { name: row.name });
  return row;
}

export async function setSkillEnabled(id: string, enabled: boolean): Promise<void> {
  const prev = await getSkillRow(id);
  if (!prev) throw new Error("Skill not found or already deleted");
  await putSkillRow({ ...prev, enabled, updatedAt: prev.updatedAt });
  log.info("skills", enabled ? "技能已启用" : "技能已停用", { name: prev.name });
}

export async function deleteSkill(id: string): Promise<void> {
  await deleteSkillRow(id);
  log.info("skills", "技能已删除", {});
}

/** agent 调用入口:按 token 名找启用技能(大小写不敏感);未命中返回 null */
export async function getEnabledSkillByName(
  name: string,
): Promise<SkillRow | null> {
  const needle = name.toLowerCase();
  const hit = (await listSkillRows()).find(
    (r) => r.enabled && r.name.toLowerCase() === needle,
  );
  return hit ?? null;
}
