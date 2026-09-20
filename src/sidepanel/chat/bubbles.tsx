// 对话气泡与 markdown 渲染:用户/助手/错误/系统提示四类气泡、压缩分隔条、
// 气泡内图片、代码块容器。markdown 配置(插件引用、语言子集)收在本文件;
// React Compiler 自动记忆化取代了手写 memo:props 不变的气泡元素由编译器
// 缓存,历史消息不因无关状态重渲染/重解析。

import {
  isValidElement,
  useEffect,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import ReactMarkdown, {
  type Options as MarkdownOptions,
} from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
// 常用语言子集,替代 rehype-highlight 默认的全量 common 集(37 种),控制产物体积;
// 各语法自带的别名(js/ts/py/sh…)仍随注册生效,未注册语言的代码块保持纯文本
import bash from "highlight.js/lib/languages/bash";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import type { ImageMeta } from "../../shared/messages";
import { useCopyFlash, useT } from "../ui/hooks";
import { ArchiveIcon, CheckIcon, CopyIcon, RefreshIcon } from "../ui/icons";
import { peekImgUrl, requestImgUrl } from "./images";

// markdown 渲染配置:引用保持稳定,配合 memo 让历史消息不因无关状态重渲染/重解析
const MD_REMARK: NonNullable<MarkdownOptions["remarkPlugins"]> = [remarkGfm];
const MD_REHYPE: NonNullable<MarkdownOptions["rehypePlugins"]> = [
  [
    rehypeHighlight,
    {
      languages: {
        bash,
        cpp,
        css,
        diff,
        go,
        java,
        javascript,
        json,
        python,
        rust,
        sql,
        typescript,
        xml,
        yaml,
      },
    },
  ],
];
const MD_COMPONENTS: NonNullable<MarkdownOptions["components"]> = {
  pre: CodeBlock,
};

export function UserBubble({
  text,
  images,
}: {
  text: string;
  images?: ImageMeta[];
}) {
  return (
    <div className="msg-in ml-auto flex w-fit max-w-[86%] flex-col items-end gap-1.5">
      {images && images.length > 0 && (
        <div className="flex max-w-full flex-wrap justify-end gap-1.5">
          {images.map((im) => (
            <ChatImage key={im.id} meta={im} />
          ))}
        </div>
      )}
      {text && (
        <div className="whitespace-pre-wrap break-words rounded-md rounded-br-sm bg-primary-container px-3.5 py-2 text-[13px] leading-relaxed text-on-primary-container">
          {text}
        </div>
      )}
    </div>
  );
}

export function AssistantBubble({
  text,
  actions,
  onRegenerate,
}: {
  text: string;
  /** 动作行:缺省不渲染(流式中);copy = 复制;copy-regen = 复制+重新生成(仅末条答案) */
  actions?: "copy" | "copy-regen";
  onRegenerate?: () => void;
}) {
  // 动作行文案走字典:useT 订阅 locale,语言切换即重算(编译器把 t 身份当依赖)
  const t = useT();
  const [copied, copy] = useCopyFlash();
  return (
    <div className="markdown msg-bubble msg-in pl-3 text-[13px] leading-relaxed">
      <ReactMarkdown
        remarkPlugins={MD_REMARK}
        rehypePlugins={MD_REHYPE}
        components={MD_COMPONENTS}
      >
        {text}
      </ReactMarkdown>
      {actions && (
        <div className={`msg-actions${copied ? " is-copied" : ""}`}>
          <button
            type="button"
            className="icon-btn"
            aria-label={copied ? t("common.copied") : t("common.copy")}
            onClick={() => copy(text)}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </button>
          {actions === "copy-regen" && onRegenerate && (
            <button
              type="button"
              className="icon-btn"
              aria-label={t("chat.regenerate")}
              title={t("chat.regenerate")}
              onClick={onRegenerate}
            >
              <RefreshIcon />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** 错误气泡:onRetry 挂在末条错误上(= regenerate,同问重跑);
 *  三段式文案(发生了什么/为什么/下一步)需要后台错误分类,当前只做恢复动作 */
export function ErrorBubble({
  text,
  onRetry,
}: {
  text: string;
  onRetry?: () => void;
}) {
  const t = useT();
  return (
    <div className="msg-in flex w-full items-start gap-2 rounded-md bg-error-container px-3.5 py-2.5 text-[13px] leading-relaxed text-on-error-container">
      <WarnIcon />
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
        {text}
      </span>
      {onRetry && (
        <button type="button" className="error-retry-btn" onClick={onRetry}>
          {t("chat.retry")}
        </button>
      )}
    </div>
  );
}

/** 系统运行提示条(非错误):步数耗尽/连接中断/输出截断等状态说明,视觉层级低于错误 */
export function NoticeBubble({
  kind,
}: {
  kind?: "max-turns" | "disconnected" | "truncated";
}) {
  const t = useT();
  const text =
    kind === "disconnected"
      ? t("chat.disconnectNotice")
      : kind === "truncated"
        ? t("chat.truncatedNotice")
        : t("chat.maxTurnsNotice");
  return (
    <div className="msg-in flex w-full items-start gap-2 rounded-md bg-surface-container-high px-3.5 py-2.5 text-[12.5px] leading-relaxed text-on-surface-variant">
      <InfoIcon />
      <span className="min-w-0 flex-1">{text}</span>
    </div>
  );
}

/** 压缩分隔条:标记「此处之前的历史已压成摘要」(原文仍在库里,模型只看摘要)。
 *  解释 AI 为何可能不记得很早的细节 —— 静默压缩会显得像无故失忆 */
export function CompactionDivider() {
  const t = useT();
  return (
    <div className="ctx-divider" role="note" aria-label={t("chat.compactionNote")}>
      <span className="ctx-divider-line" />
      <span className="ctx-divider-label">
        <ArchiveIcon /> {t("chat.compactionDivider")}
      </span>
      <span className="ctx-divider-line" />
    </div>
  );
}

/** 气泡里的图片:优先 objectURL 缓存(刚发送的已在),缺失时向后台取字节;
 *  取不到(随会话被清理)显示失效占位。点击原图新开查看 */
export function ChatImage({ meta }: { meta: ImageMeta }) {
  const t = useT();
  const [url, setUrl] = useState<string | null>(() => peekImgUrl(meta.id));
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (url) return;
    let alive = true;
    requestImgUrl(meta.id).then((u) => {
      if (!alive) return;
      if (u) setUrl(u);
      else setFailed(true);
    });
    return () => {
      alive = false;
    };
  }, [meta.id, url]);
  if (failed) {
    return (
      <div className="flex h-20 w-28 items-center justify-center rounded-md bg-surface-container-high text-[12px] text-on-surface-variant">
        {t("chat.imageExpired")}
      </div>
    );
  }
  if (!url) {
    return (
      <div className="h-20 w-28 animate-pulse rounded-md bg-surface-container-high" />
    );
  }
  return (
    <a href={url} target="_blank" rel="noreferrer">
      <img
        src={url}
        alt={t("chat.imageAlt", { w: meta.w, h: meta.h })}
        className="max-h-48 rounded-md object-contain"
        // URL 失效(已被回收/字节被清理)时退到失效占位:否则是破图 + 点开
        // 死链(气泡缓存里的 blob URL 会随会话切换回收)
        onError={() => setFailed(true)}
      />
    </a>
  );
}

/** 代码块容器:顶部条(语言 + 复制)+ 横向滚动代码体。
 *  容器锁 max-width,长行靠 pre 的 overflow-x 滚动,不再撑破消息宽度 */
function CodeBlock({
  node: _node,
  children,
  ...rest
}: ComponentPropsWithoutRef<"pre"> & { node?: unknown }) {
  const t = useT();
  const first = Array.isArray(children) ? children[0] : children;
  const lang = isValidElement(first)
    ? (/language-([\w+-]+)/.exec(
        String((first.props as { className?: string }).className ?? ""),
      )?.[1] ?? "")
    : "";
  const [copied, copy] = useCopyFlash();
  return (
    <figure className="code-block">
      <figcaption className="code-block-head">
        <span>{lang || t("chat.code.plain")}</span>
        <button
          type="button"
          onClick={() => copy(nodeText(children))}
          className="code-copy-btn"
        >
          {copied ? t("common.copied") : t("common.copy")}
        </button>
      </figcaption>
      <pre {...rest}>{children}</pre>
    </figure>
  );
}

/** ReactNode → 纯文本(复制代码块用,穿透 hljs 的高亮 span 树) */
function nodeText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number")
    return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement(node)) {
    return nodeText((node.props as { children?: ReactNode }).children);
  }
  return "";
}

/** 信息圆标(系统提示条) */
function InfoIcon() {
  return (
    <svg
      className="mt-0.5 shrink-0"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 7.5v3.2" />
      <path d="M8 5h.01" />
    </svg>
  );
}

/** 警示三角(错误消息) */
function WarnIcon() {
  return (
    <svg
      className="mt-0.5 shrink-0"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 2.2 14.6 13.4H1.4L8 2.2Z" />
      <path d="M8 6.4v3" />
      <path d="M8 11.7h.01" />
    </svg>
  );
}
