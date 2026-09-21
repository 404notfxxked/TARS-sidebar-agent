// MCP 服务器卡片的两个展开态子块:「测试连接」行与工具清单面板。
// 状态各自自带(三态 + 拉取 effect),只在卡片展开时挂载语义由 props 驱动;
// headersKey/committedUrl 由卡片(失焦落盘的提交快照持有方)传入 ——
// 序列化后作依赖、提交才触发重拉的语义在这里兑现。

import { useEffect, useState } from "react";
import type { McpServerEntry } from "../../shared/mcp";
import type { McpToolInfo } from "../../shared/messages";
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
      (e): { ok: boolean; toolCount?: number; era?: string; error?: string } => ({
        ok: false,
        error: errText(e),
      }),
    );
    setTestState("done");
    setTestOk(r.ok);
    setTestMsg(
      r.ok
        ? t("settings.testOk", { n: r.toolCount ?? 0, era: r.era ?? "" })
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

/** 工具清单面板(纯渲染):三态由卡片持有 —— 收起态徽标的「N 个工具」
 *  也读 tools,状态不能离开卡片;拉取 effect(与「测试连接」同一条后台
 *  缓存,提交后的 url/请求头变了就重拉)随之留在卡片。启用前审阅描述 ——
 *  MCP 工具描述是外部文本,这是注入防线的一环 */
export function McpToolsPanel({
  tools,
  toolsLoading,
  toolsError,
}: {
  tools: McpToolInfo[] | null;
  toolsLoading: boolean;
  toolsError: string;
}) {
  const t = useT();

  const toolsTokens =
    tools?.reduce(
      (n, tool) => n + estimateTokens(`${tool.name}${tool.description}`),
      0,
    ) ?? 0;

  return (
    <>
      {toolsLoading && (
        <p className="field-hint">{t("settings.toolsLoading")}</p>
      )}
      {!toolsLoading && (tools || toolsError) && (
        <div className="settings-block">
          <div className="flex items-center justify-between">
            <span className="settings-row-label">
              {t("settings.tools")}{tools ? t("settings.toolsMeta", { n: tools.length, tokens: toolsTokens }) : ""}
            </span>
          </div>
          {toolsError ? (
            <p className="field-hint text-error">{t("settings.toolsLoadFailed", { error: toolsError })}</p>
          ) : (
            <div className="model-list">
              {tools?.map((tool) => (
                <div key={tool.name} className="py-1">
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
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}
