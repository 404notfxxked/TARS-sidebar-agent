// 设置页「技能」分节:总开关 + 管理入口行;技能的安装/编辑/启停/删除都在
// 技能整页(SkillView),这里只读列表做摘要。列表加载失败不渲染「暂无技能」
// ——存储异常伪装成空数据是恐慌性误报(同 SubPageError 口径),就地示错给重试。

import { useCallback, useEffect, useState } from "react";
import { savePrefs } from "../../shared/configStore";
import { MSG, type SkillInfo } from "../../shared/messages";
import { useT } from "../ui/hooks";
import { skillReq } from "../clients/skillClient";
import SwitchRow from "../ui/SwitchRow";
import { EntryRow, SettingsSection } from "./parts";

export default function SkillSection({
  initialOn,
  onOpenSkills,
  run,
}: {
  initialOn: boolean;
  /** 管理入口行 → 技能整页(安装/编辑不长在这里) */
  onOpenSkills: () => void;
  run: (p: Promise<void>) => void;
}) {
  const t = useT();
  const [skillsOn, setSkillsOn] = useState(initialOn);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(() => {
    setLoadFailed(false);
    skillReq({ type: MSG.SKILL_LIST })
      .then((r) => setSkills(r.skills))
      .catch(() => setLoadFailed(true));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <SettingsSection title={t("skills.settingsSection")}>
      <SwitchRow
        id="settings-skills"
        label={t("skills.settingsSection")}
        checked={skillsOn}
        onChange={(next) => {
          setSkillsOn(next);
          run(savePrefs({ skills: next }));
        }}
        hint={t("skills.hint")}
      />
      {skillsOn &&
        (loadFailed ? (
          <div className="flex items-center justify-between gap-2 px-2 py-1.5">
            <span className="min-w-0 truncate text-[13px] text-error">
              {t("skills.loadFailed")}
            </span>
            <button type="button" className="btn-text shrink-0" onClick={load}>
              {t("common.retry")}
            </button>
          </div>
        ) : (
          <EntryRow
            ariaLabel={t("skills.manage")}
            summary={
              skills.length > 0
                ? t("skills.countLine", { n: skills.length })
                : t("skills.emptyShort")
            }
            action={t("skills.manage")}
            onClick={onOpenSkills}
          />
        ))}
    </SettingsSection>
  );
}
