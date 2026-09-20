// prompt 组装的输入侧小件:user 消息正文(tab 清单 + 技能块 + 原话)与
// 显式技能调用的解析。装配主流程见 runSetup.ts(5a-2)。

import {
  parseSkillInvocation,
  renderSkillBlock,
} from "../../shared/skills";
import { getEnabledSkillByName } from "../skills/skillStore";
import { createLogger } from "../../shared/logger";

const log = createLogger({ ctx: "bg" });

/** 构造 user 消息内容:tab 清单与技能指令块(如有)包在 <context> 与
 *  <user-request> 之间 —— 都在包裹外,历史回放的 userRequestText 投影
 *  只取 <user-request> 内文,自动丢弃这两块(库保持全量,显示只留原话) */
export async function buildUserContent(
  text: string,
  skillBlock?: string,
): Promise<string> {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const tabs = await chrome.tabs.query({ currentWindow: true });
  // TODO(tab 上限):tab 很多时每轮全量注入清单 token 成本高。合理做法:
  //   激活 tab 置顶 + 按 lastAccessed 降序,只列前 ~20 个,超出标注"…还有 X 个未列出";
  //   更彻底:context 只注入激活 tab,完整清单靠 list_tabs 工具按需获取(渐进式披露)。
  const tabLines = tabs.map((t) => {
    const mark = t.active ? "* " : "  ";
    return `${mark}tabId ${t.id ?? "?"}: ${t.title ?? ""} | ${t.url ?? ""}`;
  });
  return [
    "<context>",
    `当前日期:${date}`,
    tabLines.join("\n"),
    "</context>",
    ...(skillBlock ? [skillBlock] : []),
    "<user-request>",
    text,
    "</user-request>",
  ].join("\n");
}

/** 解析本轮消息的技能调用:文本以 /name 开头且命中启用技能 → 返回
 *  <skill> 指令块;其余情况返回 null(原样透传) */
export async function resolveInvokedSkill(text: string): Promise<string | null> {
  const inv = parseSkillInvocation(text);
  if (!inv) return null;
  const row = await getEnabledSkillByName(inv.name);
  if (!row) return null;
  log.info("agent", "skill invoked", { name: row.name, chars: row.body.length });
  return renderSkillBlock(row.name, row.body);
}
