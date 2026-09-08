// 设置页「记忆」分节:总开关 + 摘要入口行;条目的增删改/置顶/清空都在
// 记忆整页(MemoryView),这里只读列表做摘要(列表加载失败不打断设置页)。

import { useEffect, useState } from "react";
import { savePrefs } from "../../shared/configStore";
import { memoryUsedTokens } from "../../shared/memory";
import { MSG, type MemoryItem } from "../../shared/messages";
import { t } from "../../shared/i18n";
import { memReq } from "../memoryClient";
import SwitchRow from "../ui/SwitchRow";
import { SettingsSection } from "./parts";

export default function MemorySection({
  initialOn,
  onOpenMemory,
  run,
}: {
  initialOn: boolean;
  /** 摘要入口行 → 记忆管理整页(列表不长在这里:平铺时一节超一屏) */
  onOpenMemory: () => void;
  run: (p: Promise<void>) => void;
}) {
  const [memoryOn, setMemoryOn] = useState(initialOn);
  const [memories, setMemories] = useState<MemoryItem[]>([]);

  useEffect(() => {
    memReq({ type: MSG.MEM_LIST })
      .then(setMemories)
      .catch(() => {}); // 列表加载失败不打断设置页,下次打开重试
  }, []);

  return (
    <SettingsSection title={t("settings.sectionMemory")}>
      <SwitchRow
        id="settings-memory"
        label={t("settings.sectionMemory")}
        checked={memoryOn}
        onChange={(next) => {
          setMemoryOn(next);
          run(savePrefs({ memory: next }));
        }}
        hint={t("settings.memoryHint")}
      />

      {memoryOn && (
        <button
          type="button"
          onClick={onOpenMemory}
          aria-label={t("memory.settingsManage")}
          className="-mx-1 flex w-full items-center justify-between rounded-md px-1 py-1.5 text-left transition-colors duration-150 hover:bg-on-surface/8"
        >
          <span className="min-w-0 truncate pr-2 text-[13px] text-on-surface">
            {memories.length > 0
              ? t("memory.settingsSaved", { n: memories.length, used: memoryUsedTokens(memories) })
              : t("memory.settingsEmpty")}
          </span>
          <span className="flex shrink-0 items-center gap-0.5 text-[12.5px] font-medium text-primary">
            {t("memory.settingsManage")}
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
