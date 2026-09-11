// 设置页「技能」分节:总开关 + 管理入口行;技能的安装/编辑/启停/删除都在
// 技能整页(SkillView),这里只读列表做摘要(加载失败不打断设置页)。

import { useEffect, useState } from "react";
import { savePrefs } from "../../shared/configStore";
import { MSG, type SkillInfo } from "../../shared/messages";
import { t } from "../../shared/i18n";
import { skillReq } from "../clients/skillClient";
import SwitchRow from "../ui/SwitchRow";
import { SettingsSection } from "./parts";

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
  const [skillsOn, setSkillsOn] = useState(initialOn);
  const [skills, setSkills] = useState<SkillInfo[]>([]);

  useEffect(() => {
    skillReq({ type: MSG.SKILL_LIST })
      .then((r) => setSkills(r.skills))
      .catch(() => {}); // 列表加载失败不打断设置页,下次打开重试
  }, []);

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
      {skillsOn && (
        <button
          type="button"
          onClick={onOpenSkills}
          aria-label={t("skills.manage")}
          className="-mx-1 flex w-full items-center justify-between rounded-md px-1 py-1.5 text-left transition-colors duration-150 hover:bg-on-surface/8"
        >
          <span className="min-w-0 truncate pr-2 text-[13px] text-on-surface">
            {skills.length > 0
              ? t("skills.countLine", { n: skills.length })
              : t("skills.emptyShort")}
          </span>
          <span className="flex shrink-0 items-center gap-0.5 text-[12.5px] font-medium text-primary">
            {t("skills.manage")}
            <svg
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="m6 3.5 4.5 4.5L6 12.5" />
            </svg>
          </span>
        </button>
      )}
    </SettingsSection>
  );
}
