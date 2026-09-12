// 设置页「安全」分节:写操作确认门 + 任务完成通知。
// 确认门是浏览器 agent 的最后一道人审防线(页面内容可能藏注入指令),
// 默认开启;机制细节(覆盖哪些动作、超时语义)按需展开。

import { useState } from "react";
import { savePrefs } from "../../shared/configStore";
import { t } from "../../shared/i18n";
import SwitchRow from "../ui/SwitchRow";
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
  const [confirmActions, setConfirmActions] = useState(initialConfirmActions);
  const [notifyDone, setNotifyDone] = useState(initialNotifyDone);

  return (
    <SettingsSection title={t("settings.sectionSecurity")}>
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
