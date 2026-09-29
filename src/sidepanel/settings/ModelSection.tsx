// 设置页「模型服务」分节:供应商卡片列表(展开配端点/Key/拉取列表)+
// 卡内逐模型配置行。供应商域状态(providers + 当前引用)在 SettingsView
// 持有 —— 压缩用模型下拉也要读它;本组件负责编辑与落盘,经 onChange 回写。

import { useState } from "react";
import {
  savePrefs,
  type ModelEntry,
  type ProviderEntry,
} from "../../shared/configStore";
import { useConfirmReset, useT } from "../ui/hooks";
import InfoTip from "../ui/InfoTip";
import { EyeIcon } from "../ui/icons";
import { ExpandCard, SettingsSection, hostOf } from "./parts";
import { useProviderFetch } from "./useProviderFetch";

/** 数字输入 → 非负整数(0 = 未设置):负数/Infinity/NaN 一律按 0 处理。
 *  裸 `Number(x) || 0` 会把 -500 当真值直通,负 max_tokens 原样发给 API、
 *  负 contextTokens 让压缩可用窗口变负 */
function coerceTokenCount(raw: string): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export interface ModelDomain {
  providers: ProviderEntry[];
  /** 当前对话引用:供应商 id + wire 模型名 */
  modelProvider: string;
  model: string;
}

export default function ModelSection({
  domain,
  onChange,
  run,
}: {
  domain: ModelDomain;
  /** 整域回写(编辑中也会每键回写,父级只存态不落盘) */
  onChange: (next: ModelDomain) => void;
  /** 统一保存出口:成功闪「已保存」,失败亮红(见 SettingsView) */
  run: (p: Promise<void>) => void;
}) {
  const t = useT();
  const { providers, modelProvider, model } = domain;
  const [expandedPid, setExpandedPid] = useState<string | null>(null);
  // 两段确认删除:首点进入待确认,3 秒未跟进自动复位
  const [confirmDelPid, armConfirmDel, resetConfirmDel] =
    useConfirmReset<string>();

  /** 供应商局部更新;save=true 即时落盘。当前供应商的默认模型被删时回落到
   *  该供应商的第一个模型,避免对话侧拿着悬空引用 */
  const patchProvider = (
    id: string,
    patch: Partial<ProviderEntry>,
    save = false,
  ) => {
    const next = providers.map((p) => (p.id === id ? { ...p, ...patch } : p));
    onChange({ ...domain, providers: next });
    if (!save) return;
    const ops: Promise<void>[] = [savePrefs({ providers: next })];
    const affected = next.find((p) => p.id === id);
    if (
      id === modelProvider &&
      affected &&
      !affected.models.some((m) => m.id === model)
    ) {
      const fallback = affected.models[0]?.id ?? "";
      onChange({ providers: next, modelProvider, model: fallback });
      ops.push(savePrefs({ model: fallback }));
    }
    run(Promise.all(ops).then(() => {}));
  };
  const commitProviders = () => run(savePrefs({ providers }));

  const addProvider = () => {
    const entry: ProviderEntry = {
      id: crypto.randomUUID(),
      name: "",
      baseUrl: "",
      apiKey: "",
      models: [],
    };
    const next = [...providers, entry];
    onChange({ ...domain, providers: next });
    setExpandedPid(entry.id);
    run(savePrefs({ providers: next }));
  };

  /** 两段确认删除;删的是当前供应商时,回落到剩余第一个供应商及其首个模型 */
  const removeProvider = (id: string) => {
    if (confirmDelPid !== id) {
      armConfirmDel(id);
      return;
    }
    resetConfirmDel();
    const next = providers.filter((p) => p.id !== id);
    const ops: Promise<void>[] = [savePrefs({ providers: next })];
    if (modelProvider === id) {
      const fb = next[0];
      onChange({
        providers: next,
        modelProvider: fb?.id ?? "",
        model: fb?.models[0]?.id ?? "",
      });
      ops.push(
        savePrefs({
          modelProvider: fb?.id ?? "",
          model: fb?.models[0]?.id ?? "",
        }),
      );
    } else {
      onChange({ ...domain, providers: next });
    }
    run(Promise.all(ops).then(() => {}));
  };

  /** 设当前对话模型(供应商 + wire 模型名) */
  const selectModel = (pid: string, mid: string) => {
    onChange({ ...domain, modelProvider: pid, model: mid });
    run(savePrefs({ modelProvider: pid, model: mid }));
  };

  return (
    <SettingsSection title={t("settings.sectionModel")} first>
      {providers.length > 0 ? (
        <div className="model-list">
          {providers.map((p) => (
            <ProviderCard
              key={p.id}
              entry={p}
              isCurrent={p.id === modelProvider}
              currentModelId={p.id === modelProvider ? model : ""}
              open={expandedPid === p.id}
              confirming={confirmDelPid === p.id}
              onToggle={() =>
                setExpandedPid(expandedPid === p.id ? null : p.id)
              }
              onPatch={(patch, save) => patchProvider(p.id, patch, save)}
              onCommit={commitProviders}
              onRemove={() => removeProvider(p.id)}
              onSelectModel={(mid) => selectModel(p.id, mid)}
            />
          ))}
        </div>
      ) : (
        <p className="field-hint">{t("settings.providerEmpty")}</p>
      )}
      <div className="mt-2">
        <button
          type="button"
          onClick={addProvider}
          className="settings-btn tonal"
        >
          {t("settings.addProvider")}
        </button>
      </div>
      <p className="field-hint">{t("settings.providerHint")}</p>
    </SettingsSection>
  );
}

/** 模型行:收起态 = 别名/ID + 默认标记 + chevron,点击展开每模型配置 */
function ModelRow({
  entry,
  kind,
  isDefault,
  open,
  confirming,
  onToggle,
  onPatch,
  onCommit,
  onSetDefault,
  onRemove,
}: {
  entry: ModelEntry;
  /** 所属供应商的 API 协议:决定行内字段可见性(maxTokensField 仅
   *  chat-completions 有意义;anthropic 必填 max_tokens) */
  kind: ProviderEntry["kind"];
  isDefault: boolean;
  open: boolean;
  confirming: boolean;
  onToggle: () => void;
  onPatch: (patch: Partial<ModelEntry>, save?: boolean) => void;
  onCommit: () => void;
  onSetDefault: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  return (
    <ExpandCard
      open={open}
      onToggle={onToggle}
      label={entry.alias || entry.id}
      badge={isDefault && (
        <span className="model-badge">{t("common.default")}</span>
      )}
    >
      {entry.alias && <p className="model-row-id">{entry.id}</p>}
      <label className="field-label" htmlFor={`model-alias-${entry.id}`}>
        {t("settings.alias")}<span className="font-normal text-on-surface-variant">{t("common.optional")}</span>
      </label>
      <input
        id={`model-alias-${entry.id}`}
        type="text"
        value={entry.alias ?? ""}
        onChange={(e) => onPatch({ alias: e.target.value })}
        onBlur={onCommit}
        placeholder={t("settings.aliasPlaceholder")}
        autoComplete="off"
        spellCheck={false}
        className="field-input"
      />
      <div className="mt-2.5 flex items-center justify-between">
        {/* 行文本入 label(点击同开关):热区与 SwitchRow 一致,不只开关本体 */}
        <label
          htmlFor={`model-vision-${entry.id}`}
          className="text-[12.5px] font-medium text-on-surface"
        >
          {t("settings.vision")}
        </label>
        <button
          id={`model-vision-${entry.id}`}
          type="button"
          role="switch"
          aria-checked={!!entry.vision}
          aria-label={`${entry.alias || entry.id} ${t("settings.vision")}`}
          onClick={() => onPatch({ vision: !entry.vision }, true)}
          className="switch"
        >
          <span className="switch-knob" />
        </button>
      </div>
      <div className="mt-1 grid grid-cols-2 gap-2">
        <div>
          <label className="field-label" htmlFor={`model-ctx-${entry.id}`}>
            {t("settings.contextTokens")}
          </label>
          <input
            id={`model-ctx-${entry.id}`}
            type="number"
            value={entry.contextTokens || ""}
            onChange={(e) =>
              onPatch({ contextTokens: coerceTokenCount(e.target.value) })
            }
            onBlur={onCommit}
            placeholder={t("settings.ctxPlaceholder")}
            autoComplete="off"
            className="field-input font-mono"
          />
        </div>
        <div>
          <div className="field-label-row">
            <label className="field-label" htmlFor={`model-max-${entry.id}`}>
              {t("settings.maxTokens")}
            </label>
            {kind === "anthropic-messages" && (
              <InfoTip text={t("settings.maxTokensAnthropicHint")} />
            )}
          </div>
          <input
            id={`model-max-${entry.id}`}
            type="number"
            value={entry.maxTokens || ""}
            onChange={(e) =>
              onPatch({ maxTokens: coerceTokenCount(e.target.value) })
            }
            onBlur={onCommit}
            placeholder={t("settings.maxPlaceholder")}
            autoComplete="off"
            className="field-input font-mono"
          />
        </div>
      </div>
      {kind !== "anthropic-messages" && (
        <div className="mt-1">
          <div className="field-label-row">
            <label className="field-label" htmlFor={`model-mtf-${entry.id}`}>
              {t("settings.maxTokensField")}
            </label>
            <InfoTip text={t("settings.maxTokensFieldHint")} />
          </div>
          <select
            id={`model-mtf-${entry.id}`}
            value={entry.maxTokensField ?? ""}
            onChange={(e) =>
              onPatch(
                {
                  maxTokensField: (e.target.value ||
                    undefined) as ModelEntry["maxTokensField"],
                },
                true,
              )
            }
            className="field-input"
          >
            <option value="">{t("settings.maxTokensAuto")}</option>
            <option value="max_tokens">{t("settings.maxTokensCompat")}</option>
            <option value="max_completion_tokens">
              {t("settings.maxTokensReasoning")}
            </option>
          </select>
        </div>
      )}
      <div className="mb-1 mt-2 flex items-center gap-3">
        {!isDefault && (
          <button
            type="button"
            className="model-row-action"
            onClick={onSetDefault}
          >
            {t("settings.setDefault")}
          </button>
        )}
        <button
          type="button"
          className={`model-row-action model-row-action-danger${
            confirming ? " confirming" : ""
          }`}
          onClick={onRemove}
        >
          {confirming ? t("common.confirmDelete") : t("common.delete")}
        </button>
      </div>
    </ExpandCard>
  );
}

/** 供应商卡片:收起态 = 名称/主机/模型数概要 + 当前标记;点击展开该供应商
 *  及其模型配置的细节(端点、Key、拉取列表、逐模型配置)。编辑即时落盘:
 *  文本输入失焦保存,「获取列表/添加/删除模型」等动作型操作即时保存 */
function ProviderCard({
  entry,
  isCurrent,
  currentModelId,
  open,
  confirming,
  onToggle,
  onPatch,
  onCommit,
  onRemove,
  onSelectModel,
}: {
  entry: ProviderEntry;
  isCurrent: boolean;
  currentModelId: string;
  open: boolean;
  confirming: boolean;
  onToggle: () => void;
  onPatch: (patch: Partial<ProviderEntry>, save?: boolean) => void;
  onCommit: () => void;
  onRemove: () => void;
  onSelectModel: (modelId: string) => void;
}) {
  const t = useT();
  const [newId, setNewId] = useState("");
  const [openModelId, setOpenModelId] = useState<string | null>(null);
  // API Key 明文回显(核对已存 Key 用;缺省 password 形态,不因卡片展开泄漏)
  const [showKey, setShowKey] = useState(false);
  // 模型筛选(>12 才出现:一屏放得下的量不用筛;拉取列表动辄上百条,
  // 靠它定位模型 —— 同 MCP 工具清单筛选的先例,语义取 id/别名包含)
  const [modelQuery, setModelQuery] = useState("");
  const [confirmModelId, armConfirmModel, resetConfirmModel] =
    useConfirmReset<string>();
  const { fetchState, fetchError, fetchList, fixSuggestion, applyFix } =
    useProviderFetch(entry, onPatch);

  const displayName = entry.name || hostOf(entry.baseUrl) || t("settings.providerUnnamed");

  const mq = modelQuery.trim().toLowerCase();
  const visibleModels = mq
    ? entry.models.filter(
        (m) =>
          m.id.toLowerCase().includes(mq) ||
          (m.alias?.toLowerCase().includes(mq) ?? false),
      )
    : entry.models;

  /** 供应商内某个模型条目的局部更新;save=true 即时落盘 */
  const patchModel = (mid: string, patch: Partial<ModelEntry>, save = false) =>
    onPatch(
      {
        models: entry.models.map((m) => (m.id === mid ? { ...m, ...patch } : m)),
      },
      save,
    );
  const addModel = () => {
    const id = newId.trim();
    if (!id || entry.models.some((m) => m.id === id)) return;
    setNewId("");
    onPatch(
      {
        models: [...entry.models, { id }].sort((a, b) =>
          a.id.localeCompare(b.id),
        ),
      },
      true,
    );
  };
  const removeModel = (mid: string) => {
    if (confirmModelId !== mid) {
      armConfirmModel(mid);
      return;
    }
    resetConfirmModel();
    onPatch({ models: entry.models.filter((m) => m.id !== mid) }, true);
  };

  return (
    <ExpandCard
      open={open}
      onToggle={onToggle}
      label={displayName}
      badge={isCurrent && (
        <span className="model-badge">{t("common.current")}</span>
      )}
      meta={
        entry.models.length > 0
          ? t("settings.modelCount", { n: entry.models.length })
          : t("settings.modelEmpty")
      }
    >
      <div className="settings-field">
        <label className="field-label" htmlFor={`p-name-${entry.id}`}>
          {t("settings.providerName")}<span className="font-normal text-on-surface-variant">{t("common.optional")}</span>
        </label>
        <input
          id={`p-name-${entry.id}`}
          type="text"
          value={entry.name}
          onChange={(e) => onPatch({ name: e.target.value })}
          onBlur={onCommit}
          placeholder={t("settings.namePlaceholder")}
          autoComplete="off"
          spellCheck={false}
          className="field-input"
        />
      </div>
      <div className="settings-field">
        <div className="field-label-row">
          <label className="field-label" htmlFor={`p-baseurl-${entry.id}`}>
            {t("settings.providerUrl")}
          </label>
          <InfoTip
            text={t(
              entry.kind === "anthropic-messages"
                ? "settings.providerUrlHintAnthropic"
                : "settings.providerUrlHint",
            )}
          />
        </div>
        <input
          id={`p-baseurl-${entry.id}`}
          type="text"
          value={entry.baseUrl}
          onChange={(e) => onPatch({ baseUrl: e.target.value })}
          onBlur={(e) => {
            // 失焦即归一(去首尾空白与尾斜杠)—— 粘贴带 / 的地址不归一
            // 会拼出 //chat/completions;client.ts 另有兜底,这里是输入侧
            const normalized = e.target.value.trim().replace(/\/+$/, "");
            if (normalized !== entry.baseUrl) onPatch({ baseUrl: normalized });
            onCommit();
          }}
          placeholder={t(
            entry.kind === "anthropic-messages"
              ? "settings.providerUrlPlaceholderAnthropic"
              : "settings.providerUrlPlaceholder",
          )}
          autoComplete="off"
          spellCheck={false}
          className="field-input font-mono"
        />
      </div>
      <div className="settings-field">
        <label className="field-label" htmlFor={`p-format-${entry.id}`}>
          {t("settings.providerFormat")}
        </label>
        <select
          id={`p-format-${entry.id}`}
          value={entry.kind ?? "chat-completions"}
          onChange={(e) =>
            // 只切协议,不覆写已填的 baseUrl;协议决定认证头与端点路径,
            // 立即落盘(影响下一次请求)
            onPatch(
              {
                kind: (e.target.value || undefined) as ProviderEntry["kind"],
              },
              true,
            )
          }
          className="field-input"
        >
          <option value="chat-completions">
            {t("settings.formatChatCompletions")}
          </option>
          <option value="anthropic-messages">
            {t("settings.formatAnthropicMessages")}
          </option>
        </select>
      </div>
      <div className="settings-field">
        <label className="field-label" htmlFor={`p-apikey-${entry.id}`}>
          {t("settings.apiKey")}
        </label>
        <div className="relative">
          <input
            id={`p-apikey-${entry.id}`}
            type={showKey ? "text" : "password"}
            value={entry.apiKey}
            onChange={(e) => onPatch({ apiKey: e.target.value })}
            onBlur={onCommit}
            placeholder="sk-…"
            // new-password:off 在部分浏览器不拦「保存密码」气泡,这个更稳
            autoComplete="new-password"
            spellCheck={false}
            className="field-input has-eye font-mono"
          />
          <button
            type="button"
            className="settings-eye-btn"
            aria-label={showKey ? t("settings.hideKey") : t("settings.showKey")}
            onClick={() => setShowKey((v) => !v)}
          >
            <EyeIcon />
          </button>
        </div>
      </div>

      <div className="settings-block">
        <div className="flex items-center justify-between">
          <span className="settings-row-label">{t("settings.models")}</span>
          <button
            type="button"
            onClick={fetchList}
            disabled={fetchState === "loading"}
            className="btn-text"
          >
            {fetchState === "loading" ? t("settings.fetching") : t("settings.fetchModels")}
          </button>
        </div>
        {fetchState === "error" && (
          <p className="field-hint text-error">{t("settings.fetchFailed", { error: fetchError })}</p>
        )}
        {fixSuggestion && (
          <>
            <p className="field-hint">
              {t("settings.fetchSuggestFix", { url: fixSuggestion })}
            </p>
            <div className="mt-1 mb-1">
              <button type="button" className="settings-btn tonal" onClick={applyFix}>
                {t("settings.fetchApplyFix")}
              </button>
            </div>
          </>
        )}
        {entry.models.length > 12 && (
          <input
            type="text"
            value={modelQuery}
            onChange={(e) => setModelQuery(e.target.value)}
            placeholder={t("settings.modelsFilterPlaceholder")}
            aria-label={t("settings.modelsFilterLabel")}
            autoComplete="off"
            spellCheck={false}
            className="field-input mt-2 mb-1"
          />
        )}
        {entry.models.length > 0 ? (
          <div className="model-list">
            {visibleModels.map((m) => (
              <ModelRow
                key={m.id}
                entry={m}
                kind={entry.kind}
                isDefault={isCurrent && currentModelId === m.id}
                open={openModelId === m.id}
                confirming={confirmModelId === m.id}
                onToggle={() =>
                  setOpenModelId(openModelId === m.id ? null : m.id)
                }
                onPatch={(patch, save) => patchModel(m.id, patch, save)}
                onCommit={onCommit}
                onSetDefault={() => onSelectModel(m.id)}
                onRemove={() => removeModel(m.id)}
              />
            ))}
            {visibleModels.length === 0 && (
              <p className="field-hint">{t("settings.modelsNoMatch")}</p>
            )}
          </div>
        ) : (
          <p className="field-hint">
            {t("settings.modelEmptyHint")}
          </p>
        )}

        <div className="mt-2 flex items-center gap-2">
          <input
            type="text"
            value={newId}
            onChange={(e) => setNewId(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addModel();
              }
            }}
            placeholder={t("settings.modelIdPlaceholder")}
            aria-label={t("settings.modelIdLabel")}
            autoComplete="off"
            spellCheck={false}
            className="field-input font-mono"
          />
          <button type="button" onClick={addModel} className="settings-btn">
            {t("common.add")}
          </button>
        </div>
        {entry.models.length > 0 && (
          <p className="field-hint">
            {t("settings.modelRowHint")}
          </p>
        )}
      </div>

      <div className="danger-divider mb-1">
        <button
          type="button"
          className={`model-row-action model-row-action-danger${
            confirming ? " confirming" : ""
          }`}
          onClick={onRemove}
        >
          {confirming ? t("settings.confirmDeleteProvider") : t("settings.deleteProvider")}
        </button>
      </div>
    </ExpandCard>
  );
}
