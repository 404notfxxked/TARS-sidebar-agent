// 设置页「安全」分节:页面与网络访问授权 + 确认档位 + 任务完成通知。
// 授权行是 optional_host_permissions 模型的总开关:安装零站点授权,
// 页面工具/联网搜索/读取网页都在此显式授权、可随时撤销。
// 确认档位(strict/auto/off)决定写操作确认门的松紧 —— 结构照
// CompactionSection(settings-field + Segmented,硬规则 14 不私造样式);
// off 档切换走两步确认(第一击 arm 只改提示行,不落 prefs 不改选中段;
// 8s 超窗自动复位)。auto 档的说明必须让用户知情:免问范围是任何已授权
// 页面、提交类动作同样免问(方案 Q1/P0-2)。

import { useEffect, useState } from "react";
import {
  saveConfirmLevel,
  savePrefs,
  CONFIRM_LEVELS,
  type ConfirmLevel,
} from "../../shared/configStore";
import { useConfirmReset, useT } from "../ui/hooks";
import Segmented from "../ui/Segmented";
import SwitchRow from "../ui/SwitchRow";
import {
  hasPageAccess,
  requestPageAccess,
  revokePageAccess,
} from "../permissions";
import { HintMore, SettingsSection } from "./parts";

/** 分段标签的键映射(字面量化,check-i18n 纪律,照 COMPACT_LABEL_KEYS 先例) */
const CONFIRM_LABEL_KEYS: Record<ConfirmLevel, string> = {
  strict: "security.confirmLevelStrict",
  auto: "security.confirmLevelAuto",
  off: "security.confirmLevelOff",
};

/** off 档两步确认的 arm 窗口:默认 3s 对「放弃人审」这类告知太短,显式加长 */
const OFF_ARM_MS = 8000;

export default function SecuritySection({
  initialConfirmLevel,
  initialNotifyDone,
  run,
}: {
  initialConfirmLevel: ConfirmLevel;
  initialNotifyDone: boolean;
  run: (p: Promise<void>) => void;
}) {
  const t = useT();
  // null = 授权态查询中(避免首帧误闪「未授权」)
  const [pageAccess, setPageAccess] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    void hasPageAccess().then((ok) => {
      if (alive) setPageAccess(ok);
    });
    return () => {
      alive = false;
    };
  }, []);
  // 档位 value 刻意不乐观更新:armed 态下仍显示旧档,第二击(点或方向键)
  // 才解析到 off 并落档 —— 键盘「连按两次」依赖这一点
  const [confirmLevel, setConfirmLevel] = useState(initialConfirmLevel);
  const [armed, arm, reset] = useConfirmReset<ConfirmLevel>(OFF_ARM_MS);
  const [notifyDone, setNotifyDone] = useState(initialNotifyDone);

  const pick = (v: ConfirmLevel) => {
    if (v === "off" && armed !== "off") {
      arm("off"); // 第一击:只显示「再点一次确认全部免问」,不落 prefs
      return;
    }
    // 选任何非 off 档都先 reset:防陈旧 arm 让下一次 off 一击落档
    reset();
    setConfirmLevel(v);
    run(saveConfirmLevel(v));
  };

  return (
    <SettingsSection title={t("settings.sectionSecurity")}>
      {/* 站点授权总开关:读页/搜索/读网页的通行证,行内即时授予或撤销 */}
      <div className="flex items-center justify-between gap-2">
        <span className="settings-row-label">{t("security.hostAccess")}</span>
        {pageAccess !== null &&
          (pageAccess ? (
            <div className="flex items-center gap-2">
              <span className="text-[12px] text-on-surface-variant">
                {t("security.hostAccessOn")}
              </span>
              <button
                type="button"
                className="btn-text"
                onClick={() => {
                  setPageAccess(false);
                  run(revokePageAccess().then(() => undefined));
                }}
              >
                {t("security.hostAccessRevoke")}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="settings-btn tonal"
              onClick={() => {
                void requestPageAccess().then(setPageAccess);
              }}
            >
              {t("security.hostAccessGrant")}
            </button>
          ))}
      </div>
      <p className="field-hint">{t("security.hostAccessHint")}</p>
      {pageAccess === false && (
        <HintMore detail={t("security.hostAccessDetail")} />
      )}

      {/* 确认档位:strict = 一切写动作过卡;auto = 页面操作免问(记忆写/
          MCP/可疑出站仍问);off = 全部免问(两步确认) */}
      <div className="settings-field">
        <span className="field-label">{t("security.confirmLevel")}</span>
        <Segmented
          value={confirmLevel}
          options={CONFIRM_LEVELS.map((l) => ({
            value: l,
            label: t(CONFIRM_LABEL_KEYS[l]),
          }))}
          onChange={pick}
          ariaLabel={t("security.confirmLevel")}
        />
        <p className="field-hint">
          {armed === "off"
            ? t("security.confirmLevelArm")
            : t("security.confirmLevelHint")}
        </p>
        {confirmLevel === "auto" && (
          <>
            <p className="field-hint">{t("security.confirmLevelScope")}</p>
            <p className="field-hint">{t("security.confirmLevelSubmit")}</p>
          </>
        )}
        {confirmLevel === "off" && (
          <p className="field-hint text-error">
            {t("security.confirmLevelOffWarning")}
          </p>
        )}
      </div>

      <SwitchRow
        id="settings-notify-done"
        label={t("security.notifyDone")}
        checked={notifyDone}
        onChange={(next) => {
          setNotifyDone(next);
          run(savePrefs({ notifyDone: next }));
        }}
        hint={t("security.notifyDoneHint")}
      />
    </SettingsSection>
  );
}
