// 设置页「历史数据」分节:保留时长档位 + 本地占用估算 + 清空全部历史
// (两段确认;SW 是历史库的唯一读写方,清空走消息,即发即断无回执)。

import { useEffect, useState } from "react";
import { savePrefs } from "../../shared/configStore";
import { MSG, PORT_NAME } from "../../shared/messages";
import { useConfirmReset, useT } from "../ui/hooks";
import Segmented from "../ui/Segmented";
import { SettingsSection } from "./parts";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function DataSection({
  initialRetentionDays,
  run,
}: {
  initialRetentionDays: number;
  run: (p: Promise<void>) => void;
}) {
  const t = useT();
  const [retention, setRetention] = useState<"7" | "30" | "0">(
    initialRetentionDays === 0 || initialRetentionDays === 30
      ? (String(initialRetentionDays) as "0" | "30")
      : "7",
  );
  const [usage, setUsage] = useState<string | null>(null);
  const [confirmClear, armConfirmClear, resetConfirmClear] =
    useConfirmReset<true>();

  /** 历史库占用(IDB 属整个扩展 origin,此值含日志等其他 local 数据,看个量级) */
  const refreshUsage = () => {
    navigator.storage
      .estimate()
      .then((est) =>
        setUsage(est.usage != null ? formatBytes(est.usage) : t("common.unknown")),
      )
      .catch(() => setUsage(null));
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅挂载取一次用量;refreshUsage 非稳定引用,入依赖会每次渲染重拉
  useEffect(() => {
    refreshUsage();
  }, []);

  // 历史保留期分段选项:值为天数,0 = 不自动清理;标签渲染时现取 t()
  const retentionOptions: { value: "7" | "30" | "0"; label: string }[] = [
    { value: "7", label: t("settings.retention7") },
    { value: "30", label: t("settings.retention30") },
    { value: "0", label: t("settings.retentionAll") },
  ];

  const changeRetention = (v: "7" | "30" | "0") => {
    setRetention(v);
    run(savePrefs({ historyRetention: Number(v) }));
  };

  const clearAllHistory = () => {
    if (!confirmClear) {
      armConfirmClear(true);
      return;
    }
    resetConfirmClear();
    // SW 是历史库的唯一读写方,清空走消息(即发即断,无回执)
    const port = chrome.runtime.connect({ name: PORT_NAME });
    port.postMessage({ type: MSG.CLEAR_ALL_HISTORY });
    port.disconnect();
    window.setTimeout(refreshUsage, 300);
  };

  return (
    <>
      <SettingsSection title={t("settings.sectionData")}>
        <div className="settings-field">
          <span className="field-label">{t("settings.retention")}</span>
          <Segmented
            value={retention}
            options={retentionOptions}
            onChange={changeRetention}
            ariaLabel={t("settings.retentionAria")}
          />
        </div>
        <div className="settings-row">
          <span className="settings-row-label">{t("settings.localUsage")}</span>
          <span className="font-mono text-[12px] text-on-surface-variant">
            {usage ?? "—"}
          </span>
        </div>
        <div className="settings-block">
          <button
            type="button"
            onClick={clearAllHistory}
            className="btn-text danger"
          >
            {confirmClear ? t("common.confirmClear") : t("settings.clearHistory")}
          </button>
        </div>
      </SettingsSection>
      <p className="settings-group-footer mt-2">
        {t("settings.dataFooter")}
      </p>
    </>
  );
}
