// Skills 纯函数层(shared):SKILL.md 解析、调用 token 解析、历史投影剥离。
// 面板(技能页/输入区 / 菜单)与后台(skillStore/agent)共用;与 shared/mcp.ts
// 同款分工 —— 刻意不含任何存储/网络依赖,面板可安全 import。
//
// 格式对齐 Agent Skills 开放标准(agentskills.io):SKILL.md = YAML frontmatter
// + Markdown 正文;name ≤64 字符(小写字母/数字/连字符),description ≤1024。
// V1 是纯提示技能:scripts/ 无执行环境不支持,body 整体作为一个指令块注入。
// frontmatter 刻意手写解析不引依赖(gray-matter 会把 js-yaml 拖进 panel
// bundle);只覆盖标准实际用到的形状 —— 顶层标量 + 一层嵌套 map。

/** frontmatter 字段上限(标准约束) */
export const SKILL_NAME_MAX = 64;
export const SKILL_DESC_MAX = 1024;
/** 正文存储上限(字符):标准建议正文 <5000 token,放宽容纳 CJK 与长教程;
 *  超限拒绝保存,提示拆分引用文件 */
export const SKILL_BODY_MAX_CHARS = 30_000;

/** name 规范(标准):小写字母/数字,连字符分词,不以连字符开头/结尾、无连续连字符 */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidSkillName(name: string): boolean {
  return name.length >= 1 && name.length <= SKILL_NAME_MAX && SKILL_NAME_RE.test(name);
}

export interface ParsedSkill {
  name: string;
  description: string;
  /** 去 frontmatter 后的 Markdown 正文(首尾空白收敛) */
  body: string;
}

/** 解析失败原因(诊断串,面板在「保存失败:{error}」里原文展示) */
export function parseSkillMarkdown(raw: string): ParsedSkill {
  const text = raw.replace(/^\uFEFF/, "").trimStart();
  const error = (msg: string): never => {
    throw new Error(msg);
  };
  if (!text.startsWith("---")) {
    error("SKILL.md must start with a YAML frontmatter block (--- name/description ---)");
  }
  const newline = text.indexOf("\n");
  if (newline === -1) error("Frontmatter is not closed (missing closing ---)");
  const lines = text.slice(newline + 1).split("\n");
  const close = lines.findIndex((l) => l.trimEnd() === "---");
  if (close === -1) error("Frontmatter is not closed (missing closing ---)");

  // 最小 frontmatter 解析:顶层 `key: value` + 一层两空格缩进的嵌套 map
  // (metadata)。值去成对单/双引号;空行与 # 注释跳过
  const map = new Map<string, string | Map<string, string>>();
  let nested: { key: string; map: Map<string, string> } | null = null;
  for (const line of lines.slice(0, close)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indented = /^[ \t]+/.test(line);
    const kv = /^[ \t]*([^:]+):(?:[ \t]*(.*))?$/.exec(line);
    if (!kv) continue; // 不认识的行跳过,不做严格 YAML 校验
    const key = kv[1].trim();
    const value = unquote((kv[2] ?? "").trim());
    if (indented) {
      if (nested) nested.map.set(key, value);
      continue;
    }
    if (value === "") {
      nested = { key, map: new Map() };
      map.set(key, nested.map);
    } else {
      nested = null;
      map.set(key, value);
    }
  }

  const name = typeof map.get("name") === "string" ? (map.get("name") as string) : "";
  if (!name) error("Frontmatter is missing the required \"name\" field");
  if (!isValidSkillName(name)) {
    error(
      `Invalid skill name "${name}": use 1-${SKILL_NAME_MAX} lowercase letters/digits separated by single hyphens`,
    );
  }
  const description =
    typeof map.get("description") === "string" ? (map.get("description") as string) : "";
  if (!description) error("Frontmatter is missing the required \"description\" field");
  if (description.length > SKILL_DESC_MAX) {
    error(`description must be at most ${SKILL_DESC_MAX} characters (got ${description.length})`);
  }
  const body = lines
    .slice(close + 1)
    .join("\n")
    .trim();
  if (!body) error("Skill body is empty: add Markdown instructions after the frontmatter");
  if (body.length > SKILL_BODY_MAX_CHARS) {
    error(
      `Skill body must be at most ${SKILL_BODY_MAX_CHARS} characters (got ${body.length}); move details into reference files or trim it`,
    );
  }
  return { name, description, body };
}

function unquote(v: string): string {
  if (v.length >= 2) {
    const q = v[0];
    if (q === '"' && v.endsWith(q)) {
      // 双引号值做反转义(renderSkillMarkdown 写入时转义了 \ 和 ")
      return v.slice(1, -1).replace(/\\(.)/g, "$1");
    }
    if (q === "'" && v.endsWith(q)) return v.slice(1, -1);
  }
  return v;
}

// ---- 调用 token(输入框 / 菜单与 SW 解析共用一份语法) ----

export interface SkillInvocation {
  /** token 名(原文大小写;查库时两侧 toLowerCase) */
  name: string;
  /** 剥掉 token 后的余文(首尾空白收敛;可能为空) */
  rest: string;
}

/** 解析消息起始的技能调用 token:`/name rest…`。
 *  只认半角 `/` 在文本最前面;token 后必须是空白/换行/串尾,避免把
 *  网址路径、日期斜杠误当调用。不匹配返回 null,调用方原样透传 */
export function parseSkillInvocation(text: string): SkillInvocation | null {
  const m = /^\/([A-Za-z0-9][A-Za-z0-9_-]*)(?=[ \t\n]|$)/.exec(text);
  if (!m) return null;
  return { name: m[1], rest: text.slice(m[0].length).trim() };
}

/** agent 侧组装 <skill> 指令块(模型可见,英文)。块插在 <user-request>
 *  包裹之外:落盘保留(追问时上下文仍在),历史回放投影只取 <user-request>
 *  内文,块随之从显示层消失,无需专门剥离 */
export function renderSkillBlock(name: string, body: string): string {
  return [
    `<skill name="${name}">`,
    "The user explicitly invoked this skill; follow the instructions inside for the current request.",
    body,
    "</skill>",
  ].join("\n");
}

/** 行 → 可编辑的 SKILL.md 原文(技能页「编辑」用;description 加引号防
 *  冒号/引号破坏 frontmatter 结构,再解析时原值还原) */
export function renderSkillMarkdown(
  name: string,
  description: string,
  body: string,
): string {
  const desc = `"${description.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return ["---", `name: ${name}`, `description: ${desc}`, "---", "", body, ""].join(
    "\n",
  );
}
