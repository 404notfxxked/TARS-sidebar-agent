// 设置页「联网」分节:联网搜索总开关(唯一闸)。
// 搜索通道按协议分派:chat-completions 走后台真实搜索引擎标签页(引擎按健康表
// 自动排序,读完即关),说明放在开关 hint 里;anthropic-messages 走服务商服务端
// 搜索(不读结果页、不需要网页授权,故两条相关说明对它不显示)。搜索服务 Key
// 配置的 UI 已移除(API 通道代码保留,storage 手动配置仍生效)。
// tab 通道读结果页依赖「页面与网络访问」授权:开着却没授权时,开关下方就地给出
// 授权入口,不用等搜索失败再去安全设置里找。

import { useEffect, useState } from "react";
import { savePrefs } from "../../shared/configStore";
import { useT } from "../ui/hooks";
import SwitchRow from "../ui/SwitchRow";
import {
  hasPageAccess,
  requestPageAccess,
} from "../permissions";
import { HintMore, SettingsSection } from "./parts";

export default function WebSection({
  initialWebSearch,
  serverSearch,
  run,
}: {
  initialWebSearch: boolean;
  /** 当前供应商在联网开时走服务端搜索(anthropic-messages):此路径不读搜索
   *  结果页,故未授权页面访问也照常可用 —— 授权提示只对标签页通道显示 */
  serverSearch: boolean;
  run: (p: Promise<void>) => void;
}) {
  const t = useT();
  const [webSearch, setWebSearch] = useState(initialWebSearch);
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

      {/* 引擎机制细节(含「搜索词会发给搜索引擎」的隐私披露)按需展开。
          服务端搜索时搜索词发给模型服务商、不读结果页,这段说明仅对标签页通道成立 */}
      {webSearch && !serverSearch && <HintMore detail={t("settings.searchHow")} />}

      {/* 开着却没授权:就地给授权入口,搜索现在必然失败,别让用户撞墙。
          服务端搜索(anthropic-messages)不读结果页,不需要该授权,不误报 */}
      {webSearch && !serverSearch && pageAccess === false && (
        <div className="flex items-center justify-between gap-2">
          <span className="field-hint text-error">
            {t("settings.webNeedAccess")}
          </span>
          <button
            type="button"
            className="settings-btn tonal shrink-0"
            onClick={() => {
              void requestPageAccess().then(setPageAccess);
            }}
          >
            {t("security.hostAccessGrant")}
          </button>
        </div>
      )}
    </SettingsSection>
  );
}
