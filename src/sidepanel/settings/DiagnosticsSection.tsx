// 设置页「诊断」分节:运行日志条数 + 复制/下载 JSONL + 清空(两段确认)。
// 日志是排查问题的出口:下载后放进项目 .logs/ 目录给 TARS 分析。

import { useEffect, useState } from "react";
import { clearAllLogs, readAllLogEntries, toJsonl } from "../../shared/logger";
import { useConfirmReset, useCopyFlash, useT } from "../ui/hooks";
import { SettingsSection } from "./parts";

export default function DiagnosticsSection() {
  const t = useT();
  const [logCount, setLogCount] = useState<number | null>(null);
  const [copied, copyLogs] = useCopyFlash();
  const [confirmClearLogs, armConfirmClearLogs, resetConfirmClearLogs] =
    useConfirmReset<true>();

  useEffect(() => {
    readAllLogEntries()
      .then((es) => setLogCount(es.length))
      .catch(() => setLogCount(-1));
  }, []);

  const downloadLogs = async () => {
    const entries = await readAllLogEntries();
    const blob = new Blob([toJsonl(entries)], {
      type: "application/x-ndjson",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sidebar-logs-${new Date()
      .toISOString()
      .slice(0, 19)
      .replace(/[:T]/g, "-")}.jsonl`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // 清空与记忆/历史的两段确认同款(危险动作不单击直发)
  const clearLogs = async () => {
    if (!confirmClearLogs) {
      armConfirmClearLogs(true);
      return;
    }
    resetConfirmClearLogs();
    await clearAllLogs();
    setLogCount(0);
  };

  return (
    <>
      <SettingsSection title={t("settings.sectionDiag")}>
        <div className="settings-row">
          <span className="settings-row-label">{t("settings.logs")}</span>
          <span className="font-mono text-[12px] text-on-surface-variant">
            {logCount === null
              ? t("common.loading")
              : logCount < 0
                ? t("common.loadFailed")
                : t("settings.logsUnit", { n: logCount })}
          </span>
        </div>
        <div className="settings-block flex items-center gap-2">
          <button
            type="button"
            onClick={() => void copyAllLogs(copyLogs)}
            className="btn-text"
          >
            {copied ? t("common.copied") : t("settings.copyJsonl")}
          </button>
          <button type="button" onClick={downloadLogs} className="btn-text">
            {t("settings.downloadLogs")}
          </button>
          <button
            type="button"
            onClick={clearLogs}
            className="btn-text danger"
          >
            {confirmClearLogs ? t("common.confirmClear") : t("settings.clearLogs")}
          </button>
        </div>
      </SettingsSection>
      <p className="settings-group-footer mt-2">
        {t("settings.diagFooter")}
      </p>
    </>
  );
}

/** 复制按钮要用同步文本:先取条目序列化,再交给 useCopyFlash 的 copy */
async function copyAllLogs(copy: (text: string) => Promise<void>) {
  const entries = await readAllLogEntries();
  await copy(toJsonl(entries));
}
