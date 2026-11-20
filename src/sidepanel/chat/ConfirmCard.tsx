// 写操作确认卡:后台在执行页面写动作/记忆持久写/受控外链读取/MCP 外部工具
// 调用前停下等答复;展示目标与操作内容,给用户足够信息做「允许 / 拒绝」决定。
// 拒绝可附说明(「拒绝并说明」展开内嵌输入,随 deny 回传作为 feedback 给模型);
// 非输入焦点的 Esc = 一键拒绝(composer 打字/技能菜单/IME 的 Esc 各有归属,
// 不在此吞);标题行按 wire 下发的 category 着色区分风险族(卡体中性,M3
// 列表的图标强调法);超 80 字的写入内容/外发负载默认截断(截断本身是信号),
// 可展开看原文。视觉沿用 combo-pop 浮层语言。键位表必须写字面量(check-i18n)

import { useEffect, useState } from "react";
import type { MSG, AgentEvent } from "../../shared/messages";
import { useT } from "../ui/hooks";
import { ConfirmIcon } from "../ui/icons";
import { toolLabel } from "./toolNames";

type ConfirmRequest = Extract<
  AgentEvent,
  { type: typeof MSG.AGENT_CONFIRM_REQUEST }
>;

/** category → 标题行颜色(类名必须是源码字面量,Tailwind 才生成):
 *  persistent(跨会话持久写)= error;page-nav(跳转/关 tab)= warning;
 *  page-write(页面日常写)= primary;mcp / fetch(数据外发通道)= tertiary。
 *  卡体保持中性,只有图标与标题行着色 —— M3 列表/对话框的惯用强调法;
 *  category 缺席(旧事件/未下发)保持默认色 */
const CATEGORY_HEAD_COLOR: Record<
  NonNullable<ConfirmRequest["category"]>,
  string
> = {
  "page-write": "text-primary",
  "page-nav": "text-warning",
  persistent: "text-error",
  mcp: "text-tertiary",
  fetch: "text-tertiary",
};

/** 按工具族取卡片标题键:页面动作/记忆/外链/MCP/标签页各自有更贴题的说法 */
function confirmTitleKey(name: string): string {
  if (name.startsWith("mcp_")) return "chat.confirmMcpTitle";
  switch (name) {
    case "memory_save":
      return "chat.confirmMemorySaveTitle";
    case "memory_delete":
      return "chat.confirmMemoryDeleteTitle";
    case "web_fetch":
    case "web_fetch_image":
      return "chat.confirmWebFetchTitle";
    case "navigate_tab":
      return "chat.confirmNavigateTitle";
    case "close_tab":
      return "chat.confirmCloseTabTitle";
    default:
      return "chat.confirmTitle";
  }
}

/** 超长原文(写入内容 / MCP 外发负载)展开区的展示块 */
function FullText({ text }: { text: string }) {
  return (
    <p className="mt-1 max-h-40 overflow-y-auto break-all whitespace-pre-wrap rounded-xs bg-surface-container-highest px-2 py-1 font-mono text-[11.5px] leading-4 text-on-surface-variant">
      {text}
    </p>
  );
}

export function ConfirmCard({
  req,
  onAnswer,
}: {
  req: ConfirmRequest;
  onAnswer: (outcome: "allow_once" | "deny", text?: string) => void;
}) {
  const t = useT();
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [expanded, setExpanded] = useState(false);
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
  const fillTruncated = isFill && typeof args.text === "string" && args.text.length > 80;
  // 记忆/外链族的操作对象也必须上卡(与 fill 的写入内容同一条信息纪律)
  const memSaveText =
    req.name === "memory_save" && typeof args.content === "string"
      ? args.content.slice(0, 80)
      : "";
  const memDeleteMatch =
    req.name === "memory_delete" && typeof args.match === "string"
      ? args.match.slice(0, 80)
      : "";
  /** 链接行只展示 host + 路径:这族门的意义是「看清将要外发什么」,而外泄
   *  负载恰好藏在长查询串里 —— 查询串不逐字展示,另起一行只报长度,让
   *  「截断」本身成为信号 */
  const fetchRawUrl =
    (req.name === "web_fetch" || req.name === "web_fetch_image") &&
    typeof args.url === "string"
      ? args.url
      : "";
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
  /** MCP 族:调用的是外部服务器而非本机页面,页签信息无意义不上卡;目标行
   *  显示服务器名(displayName「服务器 · 工具」前段,mcpManager 构造),缺
   *  displayName 就整行不渲染 —— wire 名拆不出可靠服务器名,宁缺勿错 */
  const isMcp = req.name.startsWith("mcp_");
  const mcpServer = isMcp ? req.displayName?.split(" · ")[0] : undefined;
  /** 页面跳转族:操作对象是目标 URL 而不是当前标签页(尤其 newTab 场景),
   *  页签信息行不上卡,只展示要跳去的地方 */
  const isNavigate = req.name === "navigate_tab";
  const navUrl = isNavigate && typeof args.url === "string" ? args.url : "";
  /** MCP 入参即外发负载,与记忆族同一条「操作对象上卡」纪律;超 80 截断,
   *  让「截断」本身成为信号(与 web_fetch 查询串同款),可展开看原文 */
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
  const headColor = req.category
    ? CATEGORY_HEAD_COLOR[req.category]
    : "text-on-surface";

  // Esc 快捷拒绝:焦点不在文本输入时生效(composer 打字/技能菜单导航/IME
  // 组词的 Esc 各有归属,不在此吞);说明框内的 Esc 由其自身 onKeyDown
  // 收起说明框并阻断冒泡,到不了这里
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return;
      const el = e.target;
      if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement)
        return;
      onAnswer("deny");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onAnswer]);

  return (
    <div
      role="alertdialog"
      aria-label={t(titleKey)}
      className="mx-auto mb-2 w-[calc(100%-24px)] max-w-[560px] rounded-lg bg-surface-container-high p-3 shadow-2"
    >
      <p className={`flex items-center gap-1.5 text-[13px] font-medium ${headColor}`}>
        <ConfirmIcon />
        {toolLabel(t, req.name, req.displayName)} · {t(titleKey)}
      </p>
      {!isMcp && !isNavigate && targetLabel && (
        <p className="mt-1 truncate text-[12px] text-on-surface-variant">
          {t("chat.confirmTarget", { title: targetLabel })}
        </p>
      )}
      {navUrl && (
        <p className="mt-1 break-all font-mono text-[11.5px] text-on-surface-variant">
          {t("chat.confirmNavigateUrl", { url: navUrl.slice(0, 120) })}
          {navUrl.length > 120 ? "…" : ""}
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
          {mcpArgsTruncated && !expanded ? "…" : ""}
        </p>
      )}
      {mcpArgsTruncated && expanded && <FullText text={mcpArgsRaw} />}
      {fillText && (
        <p className="mt-1 break-all text-[12px] text-on-surface-variant">
          {t("chat.confirmFillText", { text: fillText })}
          {fillTruncated && !expanded ? "…" : ""}
        </p>
      )}
      {fillTruncated && expanded && typeof args.text === "string" && (
        <FullText text={args.text} />
      )}
      {(fillTruncated || mcpArgsTruncated) && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? t("chat.confirmCollapse") : t("chat.confirmExpand")}
          className="btn-text h-7 px-1"
        >
          {expanded ? t("chat.confirmCollapse") : t("chat.confirmExpand")}
        </button>
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
      {reasonOpen && (
        <div className="mt-2">
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                // 说明框内的 Esc 只收起说明框,不冒泡触发快捷拒绝
                e.stopPropagation();
                setReasonOpen(false);
                return;
              }
              // Enter 提交与 composer 同款:Shift+Enter 换行,IME 组词不发送
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing &&
                reason.trim()
              ) {
                e.preventDefault();
                onAnswer("deny", reason.trim());
              }
            }}
            rows={2}
            // biome-ignore lint/a11y/noAutofocus: 点开「拒绝并说明」后聚焦输入是明确交互结果,非表单页抢焦点
            autoFocus
            placeholder={t("chat.confirmFeedbackPlaceholder")}
            aria-label={t("chat.confirmFeedbackPlaceholder")}
            className="block w-full resize-none rounded-xs bg-surface-container-highest px-2 py-1.5 text-[12.5px] leading-relaxed text-on-surface outline-none placeholder:text-on-surface-variant"
          />
          <div className="mt-1 flex justify-end">
            <button
              type="button"
              disabled={!reason.trim()}
              onClick={() => onAnswer("deny", reason.trim())}
              aria-label={t("chat.confirmFeedbackSend")}
              className="btn-text h-7"
            >
              {t("chat.confirmFeedbackSend")}
            </button>
          </div>
        </div>
      )}
      <div className="mt-2.5 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => setReasonOpen((v) => !v)}
          aria-label={t("chat.confirmDenyWithReason")}
          className="btn-text"
        >
          {t("chat.confirmDenyWithReason")}
        </button>
        <button
          type="button"
          onClick={() => onAnswer("deny")}
          aria-label={t("chat.confirmDeny")}
          className="btn-text"
        >
          {t("chat.confirmDeny")}
        </button>
        <button
          type="button"
          onClick={() => onAnswer("allow_once")}
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
