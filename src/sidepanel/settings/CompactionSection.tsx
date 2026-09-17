// 设置页「上下文压缩」分节:压缩时机档位 + 压缩用模型(从已配 Key 且有
// 模型的供应商里选;压缩只是做摘要,便宜快速的模型就够)。

import { useState } from "react";
import {
  savePrefs,
  COMPACT_LEVELS,
  type CompactLevel,
  type ProviderEntry,
} from "../../shared/configStore";
import { useT } from "../ui/hooks";
import InfoTip from "../ui/InfoTip";
import Segmented from "../ui/Segmented";
import { SettingsSection, hostOf } from "./parts";

/** 同上:分段/下拉的键映射全部字面量化 */
const COMPACT_LABEL_KEYS: Record<CompactLevel, string> = {
  early: "settings.compactEarly",
  standard: "settings.compactStandard",
  late: "settings.compactLate",
};

export default function CompactionSection({
  initialCompact,
  /** 压缩用模型(结构化双字段;null = 跟随当前) */
  initialRef,
  providers,
  run,
}: {
  initialCompact: CompactLevel;
  initialRef: { providerId: string; modelId: string } | null;
  /** 只读:模型下拉的选项来源(供应商域状态在 SettingsView/ModelSection) */
  providers: ProviderEntry[];
  run: (p: Promise<void>) => void;
}) {
  const t = useT();
  const [compact, setCompact] = useState<CompactLevel>(initialCompact);
  const [compactRef, setCompactRef] = useState(initialRef);

  // 下拉的扁平选项表:<option> 的 value 用表内索引,不自制字符串编码
  // (旧实现用 "providerId||modelId" 复合串传值再 indexOf 拆回,易碎)
  const selectableProviders = providers.filter(
    (p) => p.apiKey && p.models.length > 0,
  );
  const selectable = selectableProviders.flatMap((p) =>
    p.models.map((m) => ({ providerId: p.id, modelId: m.id })),
  );
  const selectedIdx = compactRef
    ? selectable.findIndex(
        (o) =>
          o.providerId === compactRef.providerId &&
          o.modelId === compactRef.modelId,
      )
    : -1;

  /** 压缩用模型:索引解码回双字段落盘;空 = 跟随当前模型(两个字段清空) */
  const changeCompactModel = (v: string) => {
    const idx = v === "" ? -1 : Number(v);
    const ref = idx >= 0 ? (selectable[idx] ?? null) : null;
    setCompactRef(ref);
    run(
      savePrefs({
        compactProvider: ref?.providerId ?? "",
        compactModel: ref?.modelId ?? "",
      }),
    );
  };

  return (
    <SettingsSection title={t("settings.sectionCompaction")}>
      <div className="settings-field">
        <span className="field-label">{t("settings.compactTiming")}</span>
        <Segmented
          value={compact}
          options={COMPACT_LEVELS.map((l) => ({
            value: l,
            label: t(COMPACT_LABEL_KEYS[l]),
          }))}
          onChange={(v) => {
            setCompact(v);
            run(savePrefs({ compact: v }));
          }}
          ariaLabel={t("settings.compactTiming")}
        />
        <p className="field-hint">
          {t("settings.compactHint")}
        </p>
      </div>
      <div className="settings-field">
        <div className="field-label-row">
          <label className="field-label" htmlFor="compact-model">
            {t("settings.compactModel")}
          </label>
          <InfoTip text={t("settings.compactModelHint")} />
        </div>
        <select
          id="compact-model"
          value={selectedIdx >= 0 ? String(selectedIdx) : ""}
          onChange={(e) => changeCompactModel(e.target.value)}
          className="field-input"
        >
          <option value="">{t("settings.compactFollow")}</option>
          {selectableProviders.map((p) => (
            <optgroup key={p.id} label={p.name || hostOf(p.baseUrl)}>
              {p.models.map((m) => {
                const idx = selectable.findIndex(
                  (o) => o.providerId === p.id && o.modelId === m.id,
                );
                return (
                  <option key={m.id} value={String(idx)}>
                    {m.alias || m.id}
                  </option>
                );
              })}
            </optgroup>
          ))}
        </select>
      </div>
    </SettingsSection>
  );
}
