// 设置页「诊断」分节(极简形态):运行日志条数 + 复制/下载两个导出入口。
// 面向普通用户:出问题时把日志随问题描述一并发出去;开发者自己排查走
// DevTools console(logger 双写),不依赖这套 UI。

import { useEffect, useState } from "react";
import { readAllLogEntries, toJsonl } from "../../shared/logger";
import { useCopyFlash, useT } from "../ui/hooks";
import { SettingsSection } from "./parts";

export default function DiagnosticsSection() {
  const t = useT();
  const [logCount, setLogCount] = useState<number | null>(null);
  const [copied, copyLogs] = useCopyFlash();

  useEffect(() => {
    readAllLogEntries()
      .then((es) => setLogCount(es.length))
      .catch(() => setLogCount(-1));
  }, []);

  // 导出前未捕获的 rejection 会静默失败(按钮无任何反馈),失败态就地示错
  const [exportFailed, setExportFailed] = useState(false);
  const downloadLogs = async () => {
    try {
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
      setExportFailed(false);
    } catch {
      setExportFailed(true);
    }
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
          {exportFailed && (
            <span className="text-[12px] text-error">
              {t("settings.exportFailed")}
            </span>
          )}
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
