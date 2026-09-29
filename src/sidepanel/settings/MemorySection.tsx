// 设置页「记忆」分节:总开关 + 摘要入口行;条目的增删改/置顶/清空都在
// 记忆整页(MemoryView),这里只读列表做摘要。列表加载失败不渲染「暂无记忆」
// ——存储异常伪装成空数据是恐慌性误报(同 SubPageError 口径),就地示错给重试。

import { useCallback, useEffect, useState } from "react";
import { savePrefs } from "../../shared/configStore";
import { memoryUsedTokens } from "../../shared/memory";
import { MSG, type MemoryItem } from "../../shared/messages";
import { useT } from "../ui/hooks";
import { memReq } from "../clients/memoryClient";
import SwitchRow from "../ui/SwitchRow";
import { EntryRow, HintMore, SettingsSection } from "./parts";

export default function MemorySection({
  initialOn,
  contextTokens,
  onOpenMemory,
  run,
}: {
  initialOn: boolean;
  /** 当前模型的上下文窗口:注入预算按它动态缩放,摘要行估算与后台同源 */
  contextTokens?: number;
  /** 摘要入口行 → 记忆管理整页(列表不长在这里:平铺时一节超一屏) */
  onOpenMemory: () => void;
  run: (p: Promise<void>) => void;
}) {
  const t = useT();
  const [memoryOn, setMemoryOn] = useState(initialOn);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(() => {
    setLoadFailed(false);
    memReq({ type: MSG.MEM_LIST })
      .then((r) => setMemories(r.memories))
      .catch(() => setLoadFailed(true));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

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
      {/* 关闭行为(数据不删除)按需展开;开启态的关键语义留在开关 hint 里 */}
      <HintMore detail={t("settings.memoryDetail")} />

      {memoryOn &&
        (loadFailed ? (
          <div className="flex items-center justify-between gap-2 px-2 py-1.5">
            <span className="min-w-0 truncate text-[13px] text-error">
              {t("memory.loadFailed")}
            </span>
            <button type="button" className="btn-text shrink-0" onClick={load}>
              {t("common.retry")}
            </button>
          </div>
        ) : (
          <EntryRow
            ariaLabel={t("memory.settingsManage")}
            summary={
              memories.length > 0
                ? t("memory.settingsSaved", {
                    n: memories.length,
                    used: memoryUsedTokens(memories, contextTokens),
                  })
                : t("memory.settingsEmpty")
            }
            action={t("memory.settingsManage")}
            onClick={onOpenMemory}
          />
        ))}
    </SettingsSection>
  );
}
