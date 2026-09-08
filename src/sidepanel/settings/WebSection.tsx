// 设置页「联网」分节:联网搜索总开关 + 搜索方式与各家服务的 Key/中转地址。
// key/中转地址按服务商分槽各存一格(savePrefs({ search }) 整包),切换互不串。

import { useState } from "react";
import {
  savePrefs,
  SEARCH_PROVIDER_IDS,
  type SearchConfig,
  type SearchProviderSetting,
  type SearchServiceEntry,
} from "../../shared/configStore";
import { t } from "../../shared/i18n";
import SwitchRow from "../ui/SwitchRow";
import { SettingsSection } from "./parts";

/** 同上:分段/下拉的键映射全部字面量化 */
const SEARCH_PROVIDER_LABEL_KEYS: Record<SearchProviderSetting, string> = {
  auto: "settings.searchProviderAuto",
  tavily: "settings.searchProviderTavily",
  bocha: "settings.searchProviderBocha",
  brave: "settings.searchProviderBrave",
};

export default function WebSection({
  initialWebSearch,
  initialSearch,
  run,
}: {
  initialWebSearch: boolean;
  initialSearch: SearchConfig;
  run: (p: Promise<void>) => void;
}) {
  const [webSearch, setWebSearch] = useState(initialWebSearch);
  const [search, setSearch] = useState<SearchConfig>(initialSearch);

  // ── 搜索服务:key/中转地址按家各存一格,切换搜索方式各读各的,互不串 ──
  const activeService =
    search.provider === "auto" ? null : search.services[search.provider];
  /** 改当前选中服务的配置;save=false 只改本地态(输入中),true 连带落盘(失焦) */
  const patchService = (patch: Partial<SearchServiceEntry>, save: boolean) => {
    const id = search.provider;
    if (id === "auto") return;
    const next: SearchConfig = {
      ...search,
      services: { ...search.services, [id]: { ...search.services[id], ...patch } },
    };
    setSearch(next);
    if (save) run(savePrefs({ search: next }));
  };

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

      {webSearch && (
        <>
          <div className="settings-field">
            <label className="field-label" htmlFor="search-provider">
              {t("settings.searchProvider")}
            </label>
            <select
              id="search-provider"
              value={search.provider}
              onChange={(e) => {
                const next = {
                  ...search,
                  provider: e.target.value as SearchProviderSetting,
                };
                setSearch(next);
                run(savePrefs({ search: next }));
              }}
              className="field-input"
            >
              {(SEARCH_PROVIDER_IDS as readonly SearchProviderSetting[]).map(
                (id) => (
                  <option key={id} value={id}>
                    {t(SEARCH_PROVIDER_LABEL_KEYS[id])}
                  </option>
                ),
              )}
            </select>
          </div>

          {activeService ? (
            <>
              <div className="settings-field">
                <label className="field-label" htmlFor="search-baseurl">
                  {t("settings.searchBaseUrl")}
                </label>
                <input
                  id="search-baseurl"
                  type="text"
                  value={activeService.baseUrl}
                  onChange={(e) =>
                    patchService({ baseUrl: e.target.value }, false)
                  }
                  onBlur={(e) =>
                    patchService({ baseUrl: e.target.value.trim() }, true)
                  }
                  placeholder={t("settings.searchBaseUrlPlaceholder")}
                  autoComplete="off"
                  spellCheck={false}
                  className="field-input font-mono"
                />
              </div>

              <div className="settings-field">
                <label className="field-label" htmlFor="search-apikey">
                  {t("settings.apiKey")}
                </label>
                <input
                  id="search-apikey"
                  type="password"
                  value={activeService.apiKey}
                  onChange={(e) =>
                    patchService({ apiKey: e.target.value }, false)
                  }
                  onBlur={(e) =>
                    patchService({ apiKey: e.target.value.trim() }, true)
                  }
                  placeholder={t("settings.searchApiKeyPlaceholder")}
                  autoComplete="off"
                  spellCheck={false}
                  className="field-input font-mono"
                />
                <p className="field-hint">
                  {activeService.apiKey.trim()
                    ? t("settings.searchKeyConfigured")
                    : t("settings.searchKeyMissing")}
                </p>
              </div>
            </>
          ) : (
            <p className="field-hint">
              {t("settings.searchFreeMode")}
            </p>
          )}
        </>
      )}
    </SettingsSection>
  );
}
