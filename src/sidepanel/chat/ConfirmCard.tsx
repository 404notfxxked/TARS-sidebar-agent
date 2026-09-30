// 写操作确认卡:后台在执行页面写动作/记忆持久写/受控外链读取/MCP 外部工具
// 调用前停下等答复;展示目标与操作内容,给用户足够信息做「允许 / 拒绝」决定;
// 视觉沿用 combo-pop 浮层语言。键位表必须写字面量(check-i18n 只收集键形字面量)

import type { MSG, AgentEvent } from "../../shared/messages";
import { useT } from "../ui/hooks";
import { ConfirmIcon } from "../ui/icons";
import { toolLabel } from "./toolNames";

type ConfirmRequest = Extract<
  AgentEvent,
  { type: typeof MSG.AGENT_CONFIRM_REQUEST }
>;

/** 按工具族取卡片标题键:页面动作/记忆/外链/MCP 各自有更贴题的说法 */
function confirmTitleKey(name: string): string {
  if (name.startsWith("mcp_")) return "chat.confirmMcpTitle";
  switch (name) {
    case "memory_save":
      return "chat.confirmMemorySaveTitle";
    case "memory_delete":
      return "chat.confirmMemoryDeleteTitle";
    case "web_fetch":
      return "chat.confirmWebFetchTitle";
    default:
      return "chat.confirmTitle";
  }
}

export function ConfirmCard({
  req,
  onAnswer,
}: {
  req: ConfirmRequest;
  onAnswer: (approved: boolean) => void;
}) {
  const t = useT();
  const args = (req.args ?? {}) as {
    selector?: string;
    text?: string;
    pressEnterAfter?: boolean;
    content?: string;
    match?: string;
    url?: string;
  };
  const host = (() => {
    try {
      return req.tabUrl ? new URL(req.tabUrl).hostname : "";
    } catch {
      return "";
    }
  })();
  const targetLabel = req.tabTitle
    ? host
      ? `${req.tabTitle}（${host}）`
      : req.tabTitle
    : host;
  const isFill = req.name === "fill_input";
  const fillText =
    isFill && typeof args.text === "string" ? args.text.slice(0, 80) : "";
  // 记忆/外链族的操作对象也必须上卡(与 fill 的写入内容同一条信息纪律)
  const memSaveText =
    req.name === "memory_save" && typeof args.content === "string"
      ? args.content.slice(0, 80)
      : "";
  const memDeleteMatch =
    req.name === "memory_delete" && typeof args.match === "string"
      ? args.match.slice(0, 80)
      : "";
  // 链接行只展示 host + 路径:这族门的意义是「看清将要外发什么」,而外泄
  // 负载恰好藏在长查询串里 —— 查询串不逐字展示,另起一行只报长度,让
  // 「截断」本身成为信号
  const fetchRawUrl =
    req.name === "web_fetch" && typeof args.url === "string" ? args.url : "";
  const fetchTarget = (() => {
    if (!fetchRawUrl) return null;
    try {
      return new URL(fetchRawUrl);
    } catch {
      return null;
    }
  })();
  const fetchPathRaw = fetchTarget ? fetchTarget.pathname : "";
  const fetchLabel = fetchTarget
    ? `${fetchTarget.host}${fetchPathRaw === "/" ? "" : fetchPathRaw.slice(0, 80)}`
    : fetchRawUrl.slice(0, 120);
  const fetchTruncated =
    !fetchTarget || fetchTarget.search.length > 1 || fetchPathRaw.length > 80;
  const fetchQueryChars = fetchTarget ? fetchTarget.search.length - 1 : 0;
  // MCP 族:调用的是外部服务器而非本机页面,页签信息无意义不上卡;目标行
  // 显示服务器名(displayName「服务器 · 工具」前段,mcpManager 构造),缺
  // displayName 就整行不渲染 —— wire 名拆不出可靠服务器名,宁缺勿错
  const isMcp = req.name.startsWith("mcp_");
  const mcpServer = isMcp ? req.displayName?.split(" · ")[0] : undefined;
  // MCP 入参即外发负载,与记忆族同一条「操作对象上卡」纪律;超 80 截断,
  // 让「截断」本身成为信号(与 web_fetch 查询串同款)
  const mcpArgsRaw =
    isMcp &&
    typeof req.args === "object" &&
    req.args !== null &&
    Object.keys(req.args).length > 0
      ? JSON.stringify(req.args)
      : "";
  const mcpArgsText = mcpArgsRaw.slice(0, 80);
  const mcpArgsTruncated = mcpArgsRaw.length > 80;
  const titleKey = confirmTitleKey(req.name);
  return (
    <div
      role="alertdialog"
      aria-label={t(titleKey)}
      className="mx-auto mb-2 w-[calc(100%-24px)] max-w-[560px] rounded-lg bg-surface-container-high p-3 shadow-2"
    >
      <p className="flex items-center gap-1.5 text-[13px] font-medium text-on-surface">
        <ConfirmIcon />
        {toolLabel(t, req.name, req.displayName)} · {t(titleKey)}
      </p>
      {!isMcp && targetLabel && (
        <p className="mt-1 truncate text-[12px] text-on-surface-variant">
          {t("chat.confirmTarget", { title: targetLabel })}
        </p>
      )}
      {isMcp && mcpServer && (
        <p className="mt-1 truncate text-[12px] text-on-surface-variant">
          {t("chat.confirmMcpTarget", { name: mcpServer })}
        </p>
      )}
      {mcpArgsText && (
        <p className="mt-1 break-all text-[12px] text-on-surface-variant">
          {t("chat.confirmMcpArgs", { args: mcpArgsText })}
          {mcpArgsTruncated ? "…" : ""}
        </p>
      )}
      {fillText && (
        <p className="mt-1 break-all text-[12px] text-on-surface-variant">
          {t("chat.confirmFillText", { text: fillText })}
          {args.text && args.text.length > 80 ? "…" : ""}
        </p>
      )}
      {isFill && args.pressEnterAfter && (
        <p className="mt-1 text-[12px] text-error">
          {t("chat.confirmSubmitHint")}
        </p>
      )}
      {memSaveText && (
        <p className="mt-1 break-all text-[12px] text-on-surface-variant">
          {t("chat.confirmMemorySaveText", { text: memSaveText })}
          {(args.content?.length ?? 0) > 80 ? "…" : ""}
        </p>
      )}
      {memDeleteMatch && (
        <p className="mt-1 break-all text-[12px] text-on-surface-variant">
          {t("chat.confirmMemoryDeleteText", { match: memDeleteMatch })}
        </p>
      )}
      {fetchRawUrl && (
        <>
          <p className="mt-1 break-all font-mono text-[11.5px] text-on-surface-variant">
            {t("chat.confirmWebFetchUrl", { url: fetchLabel })}
            {fetchTruncated ? "…" : ""}
          </p>
          {fetchTarget && fetchQueryChars > 0 && (
            <p className="mt-1 break-all text-[12px] text-on-surface-variant">
              {t("chat.confirmWebFetchQuery", { n: String(fetchQueryChars) })}
            </p>
          )}
        </>
      )}
      {typeof args.selector === "string" && args.selector && (
        <p className="mt-1 truncate font-mono text-[11.5px] text-on-surface-variant">
          {t("chat.confirmSelectorLabel", { selector: args.selector })}
        </p>
      )}
      <div className="mt-2.5 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => onAnswer(false)}
          aria-label={t("chat.confirmDeny")}
          className="btn-text"
        >
          {t("chat.confirmDeny")}
        </button>
        <button
          type="button"
          onClick={() => onAnswer(true)}
          aria-label={t("chat.confirmAllow")}
          className="icon-btn-filled ml-2 h-9 px-3 font-medium leading-none"
        >
          {t("chat.confirmAllow")}
        </button>
      </div>
      {/* 超时口径明示:后台 120s 未答复即按拒绝结算,不写出来用户无从得知
          挂起卡片 ≠ 安全中立。数值随载荷下发;缺省兜底镜像
          confirmations.ts 的 CONFIRM_TIMEOUT_MS,改超时要同步两处 */}
      <p className="mt-2 text-[11.5px] leading-4 text-on-surface-variant/80">
        {t("chat.confirmTimeoutHint", {
          n: String(Math.round((req.timeoutMs ?? 120_000) / 1000)),
        })}
      </p>
    </div>
  );
}
