// / 技能菜单:输入以 / 开头(仅起始位置)时触发。触发判定走 input 值而非
// keydown:避开中文组词中间态;全角 ／ 不触发。清单带 3s TTL 缓存,菜单开着
// 才取(SW 全量列表,轻请求;技能页改动后最多 3s 自愈)。

import { useEffect, useRef, useState } from "react";
import { MSG, type SkillInfo } from "../../shared/messages";
import { skillReq } from "../clients/skillClient";

export function useSkillMenu(input: string, setInput: (v: string) => void) {
  const [skillList, setSkillList] = useState<SkillInfo[] | null>(null);
  const skillFetchedAtRef = useRef(0);
  const [slashClosed, setSlashClosed] = useState(false); // Esc 关闭,输入变化后重开
  const [skillIdx, setSkillIdx] = useState(0);
  const slashMatch = /^\/([A-Za-z0-9_-]*)$/.exec(input);
  const slashQuery = slashMatch?.[1] ?? "";
  const enabledSkills = (skillList ?? []).filter((s) => s.enabled);
  const skillMatches = (() => {
    const q = slashQuery.toLowerCase();
    if (!q) return enabledSkills;
    return enabledSkills.filter(
      (s) => s.name.includes(q) || s.description.toLowerCase().includes(q),
    );
  })();
  // 输入变化 → 高亮回到首项(菜单开着时每次改词都重置选择)
  // biome-ignore lint/correctness/useExhaustiveDependencies: setSkillIdx 是稳定 setState
  useEffect(() => setSkillIdx(0), [slashQuery]);
  const slashMenuOpen = !!slashMatch && !slashClosed;

  useEffect(() => {
    if (!slashMenuOpen || Date.now() - skillFetchedAtRef.current < 3_000) return;
    skillFetchedAtRef.current = Date.now();
    skillReq({ type: MSG.SKILL_LIST })
      .then((r) => setSkillList(r.skills))
      .catch(() => {
        skillFetchedAtRef.current = 0; // 失败不缓存,下次触发重取
      });
  }, [slashMenuOpen]);

  /** 选中技能:回填 token + 尾随空格(空格使 input 不再匹配 / 形态,菜单随之关闭) */
  const pickSkill = (name: string) => {
    setInput(`/${name} `);
    setSlashClosed(false);
    setSkillIdx(0);
  };

  return {
    skillList,
    enabledSkills,
    skillMatches,
    slashQuery,
    slashMenuOpen,
    skillIdx,
    setSkillIdx,
    setSlashClosed,
    pickSkill,
  };
}
