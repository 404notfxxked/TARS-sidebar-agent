// 供应商「获取模型列表」的状态机:三态(fetchState)+ 错误文案 + 在途 abort
// 与 entry 最新值镜像。⚠️ abortRef 的卸载清理与 entryRef 必须随本状态机同生
// 共死 —— fetch 在途时用户可继续增删模型行,resolve 后要合并进「最新」的
// entry.models,而不是闭包里的过期快照(失更新)。
// 错误文案按 fetchModels 的分类(ModelsFetchError.code)映射字典键出可行动
// 提示,原始错误串作诊断后缀;探测命中回退地址(/v1)时给出「一键修正
// Base URL」建议 —— 聊天请求与列表共用同一约定,不修聊天照样 404。

import { useEffect, useRef, useState } from "react";
import type { ProviderEntry } from "../../shared/configStore";
import {
  backfillEntry,
  loadCatalog,
  prefillEntry,
} from "../../shared/modelCatalog";
import {
  fetchModels,
  ModelsFetchError,
} from "../../background/provider";
import type { ModelsErrorCode } from "../../background/provider";
import { ensureOriginAuthorized } from "../permissions";
import { useT } from "../ui/hooks";

export type FetchState = "idle" | "loading" | "error";

/** 错误分类 → 字典键;值必须写字面量(check-i18n 只认字面量键) */
const FETCH_ERROR_HINTS: Record<ModelsErrorCode, string> = {
  auth: "settings.fetchErrAuth",
  missing: "settings.fetchErrMissing",
  shape: "settings.fetchErrShape",
};

export function useProviderFetch(
  entry: ProviderEntry,
  onPatch: (patch: Partial<ProviderEntry>, save?: boolean) => void,
) {
  const t = useT();
  const [fetchState, setFetchState] = useState<FetchState>("idle");
  const [fetchError, setFetchError] = useState("");
  /** 探测命中回退地址时的修正建议({base}/v1);空串 = 无建议 */
  const [fixTo, setFixTo] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);
  // entry 的 ref 镜像:fetchList 在途期间用户可继续增删模型行,resolve 后
  // 必须合并进「最新」的 entry.models,而不是闭包里的过期快照(失更新)
  const entryRef = useRef(entry);
  entryRef.current = entry;

  /** 用该供应商自己的地址与 Key 拉取模型列表,与已有条目按 id 合并 */
  const fetchList = async () => {
    if (fetchState === "loading") return;
    if (!entry.apiKey.trim()) {
      setFetchState("error");
      setFetchError(t("settings.fetchNeedKey"));
      return;
    }
    // Base URL 必填:留空曾经「静默用官方地址」,但适配器并不认这个承诺
    // (空串会拼出相对路径 /chat/completions),所以这里就给出可行动提示,
    // 不再按协议兜底成官方端点
    if (!entry.baseUrl.trim()) {
      setFetchState("error");
      setFetchError(t("settings.baseUrlRequired"));
      return;
    }
    // 按域授权:端点 origin 未授权时借本次点击发起授权请求;拒绝则不白打
    // 一次注定 CORS 失败的请求(聊天用的同一授权,点击即生效)
    const endpoint = entry.baseUrl.trim();
    if (!(await ensureOriginAuthorized(endpoint))) {
      setFetchState("error");
      setFetchError(t("settings.accessDenied"));
      return;
    }
    abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;
    setFetchState("loading");
    setFetchError("");
    setFixTo("");
    try {
      const { ids: list, suggestedBase } = await fetchModels(
        endpoint,
        entryRef.current.apiKey.trim(),
        ctl.signal,
        entryRef.current.kind,
      );
      // 新增条目用 models.dev 快照 + 启发式预填;已有条目回填「从未设置」的
      // 缺失字段——手动设置过/清空过的一律不碰。合并基线取 ref 镜像
      // (fetch 在途时的手动增删已在最新 entry 里)
      const cat = await loadCatalog();
      const map = new Map(entryRef.current.models.map((m) => [m.id, m]));
      for (const id of list) {
        const existing = map.get(id);
        if (!existing) map.set(id, { id, ...prefillEntry(cat, id) });
        else map.set(id, backfillEntry(cat, id, existing));
      }
      const next = [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
      onPatch({ models: next }, true);
      setFixTo(suggestedBase ?? "");
      setFetchState("idle");
    } catch (e) {
      if (ctl.signal.aborted) return;
      setFetchState("error");
      const raw = e instanceof Error ? e.message.slice(0, 120) : String(e);
      // 分类错误:可行动提示在前,原始错误串作诊断后缀(全角括号,见 tests/README 单元测试节)
      const hint =
        e instanceof ModelsFetchError ? t(FETCH_ERROR_HINTS[e.code]) : "";
      setFetchError(hint ? `${hint}（${raw}）` : raw);
    }
  };

  /** 接受修正建议:把 Base URL 改写为实际生效地址并落盘 */
  const applyFix = () => {
    if (!fixTo) return;
    onPatch({ baseUrl: fixTo }, true);
    setFixTo("");
  };

  return {
    fetchState,
    fetchError,
    fetchList,
    fixSuggestion: fixTo,
    applyFix,
  };
}
