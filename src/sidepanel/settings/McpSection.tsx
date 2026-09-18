// 设置页「MCP 工具」分节:总开关 + 服务器卡片列表(展开 = 端点/请求头/
// 测试连接/工具清单)。工具清单在展开时拉取,与「测试连接」同一条后台缓存,
// 成功即预热下次 run;描述是外部文本,展开可审阅是注入防线的一环。

import { useEffect, useState } from "react";
import { savePrefs } from "../../shared/configStore";
import type { McpConfig, McpServerEntry } from "../../shared/mcp";
import { estimateTokens } from "../../shared/memory";
import type { McpToolInfo } from "../../shared/messages";
import { mcpListTools, mcpTest } from "../clients/mcpClient";
import { ensureOriginAuthorized } from "../permissions";
import { useConfirmReset, useT } from "../ui/hooks";
import InfoTip from "../ui/InfoTip";
import SwitchRow from "../ui/SwitchRow";
import { ExpandCard, HintMore, SettingsSection, hostOf } from "./parts";

/** 请求头对象 ↔ 文本(每行「名称: 值」;无冒号的行丢弃) */
const headersToText = (h: Record<string, string>): string =>
  Object.entries(h)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
const textToHeaders = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return out;
};

export default function McpSection({
  initial,
  run,
}: {
  initial: McpConfig;
  run: (p: Promise<void>) => void;
}) {
  const t = useT();
  const [mcp, setMcp] = useState<McpConfig>(initial);
  const [expandedSid, setExpandedSid] = useState<string | null>(null);
  const [confirmDelSid, armConfirmDel, resetConfirmDel] =
    useConfirmReset<string>();

  // ── MCP 服务器增删改(整包落盘,同 providers 的保存模式) ──
  const patchServer = (
    id: string,
    patch: Partial<McpServerEntry>,
    save = false,
  ) => {
    const servers = mcp.servers.map((s) =>
      s.id === id ? { ...s, ...patch } : s,
    );
    const next = { ...mcp, servers };
    setMcp(next);
    if (save) run(savePrefs({ mcp: next }));
  };
  const commitServers = () => run(savePrefs({ mcp }));
  const addServer = () => {
    const entry: McpServerEntry = {
      id: crypto.randomUUID(),
      name: "",
      url: "",
      headers: {},
      enabled: true,
    };
    const next = { ...mcp, servers: [...mcp.servers, entry] };
    setMcp(next);
    setExpandedSid(entry.id);
    run(savePrefs({ mcp: next }));
  };
  const removeServer = (id: string) => {
    if (confirmDelSid !== id) {
      armConfirmDel(id);
      return;
    }
    resetConfirmDel();
    const next = { ...mcp, servers: mcp.servers.filter((s) => s.id !== id) };
    setMcp(next);
    if (expandedSid === id) setExpandedSid(null);
    run(savePrefs({ mcp: next }));
  };

  return (
    <SettingsSection title={t("settings.sectionMcp")}>
      <SwitchRow
        id="settings-mcp"
        label={t("settings.mcpEnable")}
        checked={mcp.enabled}
        onChange={(next) => {
          const nextConfig = { ...mcp, enabled: next };
          setMcp(nextConfig);
          run(savePrefs({ mcp: nextConfig }));
        }}
        hint={t("settings.mcpHint")}
      />
      <HintMore detail={t("settings.mcpDetail")} />

      {/* 服务器卡片:工具清单与测试在卡片展开态 */}
      {mcp.enabled && (
        <>
          {mcp.servers.length > 0 ? (
            <div className="model-list">
              {mcp.servers.map((s) => (
                <McpServerCard
                  key={s.id}
                  entry={s}
                  open={expandedSid === s.id}
                  confirming={confirmDelSid === s.id}
                  onToggle={() =>
                    setExpandedSid(expandedSid === s.id ? null : s.id)
                  }
                  onPatch={(patch, save) => patchServer(s.id, patch, save)}
                  onCommit={commitServers}
                  onRemove={() => removeServer(s.id)}
                />
              ))}
            </div>
          ) : (
            <p className="field-hint">
              {t("settings.serverEmpty")}
            </p>
          )}
          <div className="mt-2">
            <button
              type="button"
              onClick={addServer}
              className="settings-btn tonal"
            >
              {t("settings.addServer")}
            </button>
          </div>
          {mcp.servers.length > 0 && (
            <p className="field-hint">
              {t("settings.serverHint")}
            </p>
          )}
        </>
      )}
    </SettingsSection>
  );
}

/** MCP 服务器卡片:收起态 = 名称/主机 + 工具数;展开 = 端点/请求头/测试连接/
 *  工具清单。字段编辑沿用「失焦落盘」模式 */
function McpServerCard({
  entry,
  open,
  confirming,
  onToggle,
  onPatch,
  onCommit,
  onRemove,
}: {
  entry: McpServerEntry;
  open: boolean;
  confirming: boolean;
  onToggle: () => void;
  onPatch: (patch: Partial<McpServerEntry>, save?: boolean) => void;
  onCommit: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const [testState, setTestState] = useState<"idle" | "loading" | "done">("idle");
  const [testMsg, setTestMsg] = useState("");
  const [testOk, setTestOk] = useState(false);
  const [tools, setTools] = useState<McpToolInfo[] | null>(null);
  const [toolsLoading, setToolsLoading] = useState(false);
  const [toolsError, setToolsError] = useState("");
  const [headersText, setHeadersText] = useState(headersToText(entry.headers));

  const displayName = entry.name || hostOf(entry.url) || t("settings.serverUnnamed");
  /** headers 逐行编辑、失焦整包提交,序列化后作依赖:提交才触发重拉
   *  (不能直接依赖 entry —— 每次按键 onChange 都换对象身份) */
  const headersKey = JSON.stringify(entry.headers);

  // 端点或鉴权头变了,上一次的连接测试结果就不再成立,静默复位
  // biome-ignore lint/correctness/useExhaustiveDependencies: 依赖即触发条件本身(url + 序列化后的 headers)
  useEffect(() => {
    setTestState("idle");
    setTestMsg("");
  }, [entry.url, headersKey]);

  // 展开时拉工具清单(与「测试连接」同一条后台缓存,成功即预热下次 run);
  // url 或请求头变了就重拉。失败只标注在工具清单区,不挡其他字段的编辑
  // biome-ignore lint/correctness/useExhaustiveDependencies: headersKey(JSON 串)代替 entry 引用 —— 仅当提交过的鉴权头真变了才重拉,勿让自动修复改写此数组
  useEffect(() => {
    if (!open || !entry.url.trim()) {
      setToolsLoading(false);
      setToolsError("");
      return;
    }
    let alive = true;
    setToolsLoading(true);
    setToolsError("");
    mcpListTools(entry)
      .then((list) => {
        if (alive) {
          setTools(list);
          setToolsLoading(false);
        }
      })
      .catch((e) => {
        if (alive) {
          setTools(null);
          setToolsError(e instanceof Error ? e.message : String(e));
          setToolsLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [open, entry.url, headersKey]);

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
        error: e instanceof Error ? e.message : String(e),
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

  const toolsTokens =
    tools?.reduce(
      (n, tool) => n + estimateTokens(`${tool.name}${tool.description}`),
      0,
    ) ?? 0;

  return (
    <ExpandCard
      open={open}
      onToggle={onToggle}
      label={displayName}
      badge={!entry.enabled && (
        <span className="model-badge">{t("common.disabled")}</span>
      )}
      meta={
        tools?.length != null
          ? t("settings.toolCount", { n: tools.length })
          : hostOf(entry.url)
      }
    >
      <div className="flex items-center justify-between">
        <span className="settings-row-label">{t("common.enabled")}</span>
        <button
          type="button"
          role="switch"
          aria-checked={entry.enabled}
          aria-label={`${displayName} ${t("common.enabled")}`}
          onClick={() => onPatch({ enabled: !entry.enabled }, true)}
          className="switch"
        >
          <span className="switch-knob" />
        </button>
      </div>
      <div className="settings-field">
        <label className="field-label" htmlFor={`mcp-name-${entry.id}`}>
          {t("settings.serverName")}<span className="font-normal text-on-surface-variant">{t("common.optional")}</span>
        </label>
        <input
          id={`mcp-name-${entry.id}`}
          type="text"
          value={entry.name}
          onChange={(e) => onPatch({ name: e.target.value })}
          onBlur={onCommit}
          placeholder={t("settings.serverNamePlaceholder")}
          autoComplete="off"
          spellCheck={false}
          className="field-input"
        />
      </div>
      <div className="settings-field">
        <div className="field-label-row">
          <label className="field-label" htmlFor={`mcp-url-${entry.id}`}>
            {t("settings.serverUrl")}
          </label>
          <InfoTip text={t("settings.serverUrlHint")} />
        </div>
        <input
          id={`mcp-url-${entry.id}`}
          type="text"
          value={entry.url}
          onChange={(e) => onPatch({ url: e.target.value }, false)}
          onBlur={(e) => onPatch({ url: e.target.value.trim() }, true)}
          placeholder={t("settings.serverUrlPlaceholder")}
          autoComplete="off"
          spellCheck={false}
          className="field-input font-mono"
        />
      </div>
      <div className="settings-field">
        <div className="field-label-row">
          <label className="field-label" htmlFor={`mcp-headers-${entry.id}`}>
            {t("settings.headers")}<span className="font-normal text-on-surface-variant">{t("common.optional")}</span>
          </label>
          <InfoTip text={t("settings.headersHint")} />
        </div>
        <textarea
          id={`mcp-headers-${entry.id}`}
          value={headersText}
          onChange={(e) => setHeadersText(e.target.value)}
          onBlur={() => {
            onPatch({ headers: textToHeaders(headersText) }, true);
          }}
          placeholder={t("settings.headersPlaceholder")}
          rows={2}
          autoComplete="off"
          spellCheck={false}
          className="field-input font-mono"
        />
      </div>

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

      {/* 工具清单:启用前审阅描述 —— MCP 工具描述是外部文本,这是注入防线的一环 */}
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

      <div className="danger-divider mb-1">
        <button
          type="button"
          className={`model-row-action model-row-action-danger${
            confirming ? " confirming" : ""
          }`}
          onClick={onRemove}
        >
          {confirming ? t("settings.confirmDeleteServer") : t("settings.deleteServer")}
        </button>
      </div>
    </ExpandCard>
  );
}
