// MCP 服务器卡片的两个展开态子块:「测试连接」行与工具清单面板。
// 状态各自自带(三态 + 拉取 effect),只在卡片展开时挂载语义由 props 驱动;
// headersKey/committedUrl 由卡片(失焦落盘的提交快照持有方)传入 ——
// 序列化后作依赖、提交才触发重拉的语义在这里兑现。

import { useEffect, useState } from "react";
import type { McpServerEntry } from "../../shared/mcp";
import type { McpToolInfo, McpEra } from "../../shared/messages";
import { estimateTokens } from "../../shared/memory";
import { errText } from "../../shared/errors";
import { mcpTest } from "../clients/mcpClient";
import { ensureOriginAuthorized } from "../permissions";
import { useT } from "../ui/hooks";

/** 测试连接行:按钮 + 三态结果文案。端点或鉴权头变了,上一次的结果就不再
 *  成立,静默复位(依赖即触发条件本身:url + 序列化后的 headers)。 */
export function McpTestRow({
  entry,
  headersKey,
}: {
  entry: McpServerEntry;
  /** 序列化后的 headers(JSON 串),代替 entry 引用作依赖 —— 提交才触发复位 */
  headersKey: string;
}) {
  const t = useT();
  const [testState, setTestState] = useState<"idle" | "loading" | "done">("idle");
  const [testMsg, setTestMsg] = useState("");
  const [testOk, setTestOk] = useState(false);

  // 端点或鉴权头变了,上一次的连接测试结果就不再成立,静默复位
  // biome-ignore lint/correctness/useExhaustiveDependencies: 依赖即触发条件本身(url + 序列化后的 headers)
  useEffect(() => {
    setTestState("idle");
    setTestMsg("");
  }, [entry.url, headersKey]);

  const runTest = async () => {
    if (testState === "loading") return;
    setTestState("loading");
    // 按域授权:借本次点击为服务器 origin 发起授权请求(与聊天调用共用
    // 同一授权);拒绝时直接以失败呈现在测试结果里,不白连一次
    if (!(await ensureOriginAuthorized(entry.url))) {
      setTestState("done");
      setTestOk(false);
      setTestMsg(t("settings.accessDenied"));
      return;
    }
    const r = await mcpTest(entry).catch(
      (e): { ok: boolean; toolCount?: number; era?: McpEra; error?: string } => ({
        ok: false,
        error: errText(e),
      }),
    );
    setTestState("done");
    setTestOk(r.ok);
    setTestMsg(
      r.ok
        ? t("settings.testOk", {
            n: r.toolCount ?? 0,
            // era 是机器值,展示文案按键映射(硬规则 1);未知/缺省不显示空段
            era:
              r.era === "modern"
                ? t("settings.eraModern")
                : r.era === "legacy"
                  ? t("settings.eraLegacy")
                  : t("settings.eraUnknown"),
          })
        : r.error ?? t("settings.testFailed"),
    );
  };

  return (
    <div className="mb-1 flex items-center gap-2">
      <button
        type="button"
        onClick={runTest}
        disabled={testState === "loading" || !entry.url.trim()}
        className="btn-text"
      >
        {testState === "loading" ? t("settings.testing") : t("settings.testConnection")}
      </button>
      {testState === "done" && (
        <span
          className={`text-[11.5px] ${testOk ? "text-on-surface-variant" : "text-error"}`}
        >
          {testMsg}
        </span>
      )}
    </div>
  );
}

/** 工具清单面板:三态(loading/清单/错误)由卡片持有;筛选是视图本地态留在
 *  本组件。每行带启停开关 —— 禁用集落盘在 entry.disabledTools(服务器侧
 *  原名,经卡片 onPatch 整包提交),开关拨动即时落盘。启用前审阅描述 ——
 *  MCP 工具描述是外部文本,这是注入防线的一环 */
export function McpToolsPanel({
  tools,
  toolsLoading,
  toolsError,
  disabledTools,
  onToggleTool,
}: {
  tools: McpToolInfo[] | null;
  toolsLoading: boolean;
  toolsError: string;
  /** 禁用的工具名(服务器侧原名);行置灰与 token 估算按它判定 */
  disabledTools: string[];
  /** 拨动某工具的启停(卡片落盘) */
  onToggleTool: (toolName: string) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const disabledSet = new Set(disabledTools);
  const isEnabled = (tool: McpToolInfo) => !disabledSet.has(tool.name);

  const toolsTokens =
    tools?.reduce(
      (n, tool) =>
        isEnabled(tool) ? n + estimateTokens(`${tool.name}${tool.description}`) : n,
      0,
    ) ?? 0;
  const enabledCount = tools?.filter(isEnabled).length ?? 0;

  const q = query.trim().toLowerCase();
  const visible =
    tools?.filter(
      (tool) =>
        !q ||
        tool.name.toLowerCase().includes(q) ||
        tool.description.toLowerCase().includes(q),
    ) ?? [];

  return (
    <>
      {toolsLoading && (
        <p className="field-hint">{t("settings.toolsLoading")}</p>
      )}
      {!toolsLoading && (tools || toolsError) && (
        <div className="settings-block">
          <div className="flex items-center justify-between">
            <span className="settings-row-label">
              {t("settings.tools")}
              {tools
                ? t("settings.toolsMeta", { n: enabledCount, tokens: toolsTokens })
                : ""}
            </span>
          </div>
          {toolsError ? (
            <p className="field-hint text-error">{t("settings.toolsLoadFailed", { error: toolsError })}</p>
          ) : (
            <>
              {tools && tools.length > 0 && (
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("settings.toolsFilterPlaceholder")}
                  autoComplete="off"
                  spellCheck={false}
                  className="field-input mt-2 mb-1"
                />
              )}
              <div className="model-list">
                {visible.map((tool) => {
                  const enabled = isEnabled(tool);
                  return (
                    <div
                      key={tool.name}
                      className="flex items-center justify-between gap-2 py-1"
                    >
                      <div className={`min-w-0${enabled ? "" : " opacity-50"}`}>
                        <p className="m-0 font-mono text-[12px] text-on-surface" title={tool.name}>
                          {tool.name}
                        </p>
                        <p
                          className="m-0 text-[12px] leading-snug text-on-surface-variant"
                          title={tool.description}
                        >
                          {tool.description.slice(0, 120)}
                          {tool.description.length > 120 ? "…" : ""}
                        </p>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={enabled}
                        aria-label={tool.name}
                        onClick={() => onToggleTool(tool.name)}
                        className="switch shrink-0"
                      >
                        <span className="switch-knob" />
                      </button>
                    </div>
                  );
                })}
                {visible.length === 0 && q && (
                  <p className="field-hint">{t("settings.toolsNoMatch")}</p>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
