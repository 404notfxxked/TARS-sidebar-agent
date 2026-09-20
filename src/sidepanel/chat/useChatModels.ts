// 模型选择与思考档位:providers / modelProvider / modelId 三元 + 能力目录
// 派生的视觉门控与思考选项;切换即写回 storage —— 后台每轮 run 重读配置,
// 下一轮生效。配置变更靠 storage 事件实时同步(设置页悬浮关闭后不重挂)。

import { useEffect, useState } from "react";
import {
  loadConfig,
  savePrefs,
  type ProviderEntry,
} from "../../shared/configStore";
import {
  defaultThinkingEffort,
  loadCatalog,
  thinkingOptionsOf,
  type Catalog,
} from "../../shared/modelCatalog";
import { createLogger } from "../../shared/logger";

const log = createLogger({ ctx: "panel" });

export function useChatModels() {
  // ---- 模型选择:按供应商分组展示,切换即写回 modelProvider + model 两字段 ----
  const [providers, setProviders] = useState<ProviderEntry[]>([]);
  const [modelProvider, setModelProvider] = useState("");
  const [modelId, setModelId] = useState("");
  /** 当前供应商(选择器与视觉门控都基于它;引用失效时退回第一个) */
  const curProvider =
    providers.find((p) => p.id === modelProvider) ?? providers[0];
  const curModels = curProvider?.models ?? [];
  /** 当前模型是否支持视觉:图片入口的门控依据 */
  const visionOk = !!curModels.find((m) => m.id === modelId)?.vision;

  // ---- 思考程度:条目被标记为推理模型且目录给出档位时,输入行出选择器
  // (设置页已无推理总开关,见 CHANGELOG「思考程度选择器」) ----
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  useEffect(() => {
    loadCatalog()
      .then(setCatalog)
      .catch(() => {}); // 目录层缺失不算错误,按钮不出现即可
  }, []);
  const curModelEntry = providers
    .find((p) => p.id === modelProvider)
    ?.models.find((m) => m.id === modelId);
  const thinkingOptions =
    catalog && curModelEntry
      ? thinkingOptionsOf(catalog, curModelEntry.id)
      : null;
  // 未设置时显示与实际发送一致的折中默认档(defaultThinkingEffort)
  const thinkingDefault =
    catalog && curModelEntry
      ? defaultThinkingEffort(catalog, curModelEntry.id)
      : undefined;
  const showThinking = curModelEntry?.reasoning === true && !!thinkingOptions;
  const setThinkingEffort = (effort: string | undefined) => {
    const p = providers.find((x) => x.id === modelProvider);
    if (!p) return;
    const nextProviders = providers.map((x) =>
      x.id === p.id
        ? {
            ...x,
            models: x.models.map((m) =>
              m.id === modelId ? { ...m, reasoningEffort: effort } : m,
            ),
          }
        : x,
    );
    setProviders(nextProviders);
    savePrefs({ providers: nextProviders }).catch((err) =>
      log.warn("chat", "save thinking effort failed", { error: String(err) }),
    );
  };

  // 挂载:读配置。设置页悬浮关闭后不重挂,配置变更靠 storage 事件同步模型列表
  useEffect(() => {
    const onStorage = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area !== "local") return;
      if (changes.providers && Array.isArray(changes.providers.newValue)) {
        setProviders(
          (changes.providers.newValue as ProviderEntry[]).filter(
            (p) => p && typeof p.id === "string" && Array.isArray(p.models),
          ),
        );
      }
      if (
        changes.modelProvider &&
        typeof changes.modelProvider.newValue === "string"
      ) {
        setModelProvider(changes.modelProvider.newValue);
      }
      if (changes.model && typeof changes.model.newValue === "string") {
        setModelId(changes.model.newValue);
      }
    };
    chrome.storage.onChanged.addListener(onStorage);
    loadConfig().then((c) => {
      setProviders(c.providers);
      setModelProvider(c.modelProvider);
      setModelId(c.model);
    });
    return () => {
      chrome.storage.onChanged.removeListener(onStorage);
    };
  }, []);

  /** 切换默认模型:写供应商 + 模型两个字段,后台每轮 run 重读配置,下一轮生效 */
  const pickModel = (providerId: string, id: string) => {
    setModelProvider(providerId);
    setModelId(id);
    savePrefs({ modelProvider: providerId, model: id }).catch((err) =>
      log.warn("chat", "save model pref failed", { error: String(err) }),
    );
  };

  return {
    providers,
    modelProvider,
    modelId,
    curProvider,
    curModels,
    visionOk,
    curModelEntry,
    thinkingOptions,
    thinkingDefault,
    showThinking,
    setThinkingEffort,
    pickModel,
  };
}
