// 输入区的模型/思考选择:摘要栏待在工具条里(当前模型名 · 档位,贴发送键),
// 点开在工具条上方弹出「模型/思考程度」两行面板(标签左、值右;容器右缘
// 对齐锚点,窄面板不越右缘),选完自动收起,点外/Esc 也收起。动机:三个
// 文字 pill 挤工具条在窄面板下曾被压到逐字竖排;摘要栏一行 + 浮层面板让
// 任何宽度都不挤,且浮层不占布局、输入区高度稳定。两行的弹层交互各自内聚
// 在 ModelPicker/ThinkingPicker,本组件只管面板开合与选完收起。

import { useEffect, useRef, useState } from "react";
import type { ProviderEntry } from "../../shared/configStore";
import ModelPicker, { currentModelAlias } from "./ModelPicker";
import ThinkingPicker, { effortLabel } from "./ThinkingPicker";
import { useT } from "../ui/hooks";

export default function ModelThinkingBar({
  providers,
  modelProvider,
  modelId,
  onPickModel,
  showThinking,
  thinkingOptions,
  thinkingDefault,
  reasoningEffort,
  onPickThinking,
}: {
  providers: ProviderEntry[];
  modelProvider: string;
  modelId: string;
  onPickModel: (providerId: string, modelId: string) => void;
  showThinking: boolean;
  /** 档位 token 列表(null = 目录无数据,思考行整体不出现) */
  thinkingOptions: string[] | null;
  thinkingDefault?: string;
  reasoningEffort?: string;
  onPickThinking: (effort: string | undefined) => void;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // 展开期间点面板外/Esc 收起(与各 picker 的「点外关闭」同款 document
  // 监听;经 ref 读最新状态,监听器只随开关注册一次)
  useEffect(() => {
    if (!expanded) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setExpanded(false);
    };
    const onKey = (e: KeyboardEvent) => {
      // 面板内有二级列表打开时,Esc 归列表(第一层收列表,第二层才收面板)
      if (e.key === "Escape") {
        if (wrapRef.current?.querySelector("[role='listbox']")) return;
        setExpanded(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [expanded]);

  // 无可用模型:整区不渲染(工具条右簇只剩发送)
  if (!providers.some((p) => p.models.length > 0)) return null;
  const alias = currentModelAlias(providers, modelProvider, modelId, t);
  // 未设置时实际生效的档:已存档位优先,退默认档,再退「关」或首档 ——
  // 显示与实际发送永远一致
  const effortValue =
    reasoningEffort ??
    thinkingDefault ??
    (thinkingOptions?.includes("off") ? "off" : thinkingOptions?.[0]);

  return (
    // min-w-0 + flex-1:窄面板下摘要栏是工具条里的可收缩项 —— 按钮(fit-
    // content)的固有宽度被别名单词托底,必须让包裹层按簇内剩余空间定宽
    // (上限 180),pill w-full 跟随,别名截断兜底
    <div ref={wrapRef} className="min-w-0 max-w-[180px] flex-1 relative">
      {expanded && (
        <div className="combo-pop combo-pop--up combo-pop--up-right combo-pop--menu">
          <ModelPicker
            providers={providers}
            modelProvider={modelProvider}
            modelId={modelId}
            onPick={(p, id) => {
              onPickModel(p, id);
              setExpanded(false);
            }}
          />
          {showThinking && thinkingOptions && effortValue !== undefined && (
            <ThinkingPicker
              options={thinkingOptions}
              value={effortValue}
              onPick={(v) => {
                onPickThinking(v);
                setExpanded(false);
              }}
            />
          )}
        </div>
      )}
      <button
        type="button"
        onClick={() => setExpanded((o) => !o)}
        aria-expanded={expanded}
        aria-label={t("chat.modelThinkingAria")}
        className="composer-pill flex w-full items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[12px] transition-colors duration-150 hover:bg-on-surface/8"
      >
        <span className="min-w-0 truncate text-on-surface">{alias}</span>
        {showThinking && thinkingOptions && effortValue !== undefined && (
          <span className="shrink-0 text-on-surface-variant">
            {effortLabel(t, effortValue)}
          </span>
        )}
        <svg
          width="10"
          height="10"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className={`shrink-0 text-on-surface-variant transition-transform duration-150 ${
            expanded ? "rotate-180" : ""
          }`}
        >
          <path d="m3.5 6 4.5 4.5L12.5 6" />
        </svg>
      </button>
    </div>
  );
}
