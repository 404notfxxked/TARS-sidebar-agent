// 设置页「安全」分节:页面与网络访问授权 + 写操作确认门 + 任务完成通知。
// 授权行是 optional_host_permissions 模型的总开关:安装零站点授权,
// 页面工具/联网搜索/读取网页都在此显式授权、可随时撤销。
// 确认门是浏览器 agent 的最后一道人审防线(页面内容可能藏注入指令),
// 默认开启;机制细节(覆盖哪些动作、超时语义)按需展开。

import { useEffect, useState } from "react";
import { savePrefs } from "../../shared/configStore";
import { useT } from "../ui/hooks";
import SwitchRow from "../ui/SwitchRow";
import {
  hasPageAccess,
  requestPageAccess,
  revokePageAccess,
} from "../permissions";
import { HintMore, SettingsSection } from "./parts";

export default function SecuritySection({
  initialConfirmActions,
  initialNotifyDone,
  run,
}: {
  initialConfirmActions: boolean;
  initialNotifyDone: boolean;
  run: (p: Promise<void>) => void;
}) {
  const t = useT();
  const [confirmActions, setConfirmActions] = useState(initialConfirmActions);
  const [notifyDone, setNotifyDone] = useState(initialNotifyDone);
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

      <SwitchRow
        id="settings-confirm-actions"
        label={t("security.confirmActions")}
        checked={confirmActions}
        onChange={(next) => {
          setConfirmActions(next);
          run(savePrefs({ confirmActions: next }));
        }}
        hint={t("security.confirmActionsHint")}
      />
      {/* 关闭前的最后一次告知:关掉即放弃人审,值得让用户展开看一眼 */}
      {confirmActions && <HintMore detail={t("security.confirmActionsDetail")} />}

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
