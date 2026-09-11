// 设置页「联网」分节:联网搜索总开关。
// 搜索方式只有一种:后台新开真实搜索引擎标签页(引擎按健康表自动排序,
// 读完即关),说明放在开关 hint 里;搜索服务 Key 配置的 UI 已移除
// (API 通道代码保留,storage 手动配置仍生效)。

import { useState } from "react";
import { savePrefs } from "../../shared/configStore";
import { t } from "../../shared/i18n";
import SwitchRow from "../ui/SwitchRow";
import { HintMore, SettingsSection } from "./parts";

export default function WebSection({
  initialWebSearch,
  run,
}: {
  initialWebSearch: boolean;
  run: (p: Promise<void>) => void;
}) {
  const [webSearch, setWebSearch] = useState(initialWebSearch);

  return (
    <SettingsSection title={t("settings.sectionWeb")}>
      <SwitchRow
        id="settings-web-search"
        label={t("settings.webSearch")}
        checked={webSearch}
        onChange={(next) => {
          setWebSearch(next);
          run(savePrefs({ webSearch: next }));
        }}
        hint={t("settings.webSearchHint")}
      />

      {/* 引擎机制细节(含「搜索词会发给搜索引擎」的隐私披露)按需展开 */}
      {webSearch && <HintMore detail={t("settings.searchHow")} />}
    </SettingsSection>
  );
}
