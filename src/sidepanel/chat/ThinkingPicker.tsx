// 输入区的思考程度选择器:当前模型「推理」总开关开着且目录有该模型的档位
// 数据时才渲染(可见性由调用侧判)。pill 触发钮 + 向上 combo-pop,与
// ModelPicker 同款交互(点外/Esc 关闭);选择写回该模型的 reasoningEffort
// (持久,聊天里改的是该模型的默认),发送侧由 agent 按总开关门控。

import { useEffect, useRef, useState } from "react";
import type { TFn } from "../../shared/i18n";
import { useT } from "../ui/hooks";

// 键位表必须写字面量:check-i18n 只收集键形字面量,模板拼键直接 FAIL。
// t 由调用方传入(useT 产物):render 期辅助函数自读模块态会被 React
// Compiler 按参数记忆化,语言切换后返回旧文案(先例 toolNames)。
const EFFORT_KEYS: Record<string, string> = {
  default: "chat.thinkDefault",
  off: "chat.thinkOff",
  minimal: "chat.thinkMinimal",
  low: "chat.thinkLow",
  medium: "chat.thinkMedium",
  high: "chat.thinkHigh",
  xhigh: "chat.thinkXhigh",
  max: "chat.thinkMax",
};

/** 档位显示名:内置 token 走字典,未知 token 原样显示(目录新增档位不崩 UI) */
export function effortLabel(t: TFn, token: string): string {
  const key = EFFORT_KEYS[token];
  return key ? t(key) : token;
}

const DEFAULT_TOKEN = "default";

export default function ThinkingPicker({
  options,
  value,
  onPick,
}: {
  /** 档位 token 列表(thinkingOptionsOf 产物,不含「跟随默认」隐式项) */
  options: string[];
  /** 当前 reasoningEffort(undefined = 跟随默认) */
  value: string | undefined;
  onPick: (effort: string | undefined) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const popRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef({ options, value, onPick });
  stateRef.current = { options, value, onPick };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!popRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = value ?? DEFAULT_TOKEN;

  return (
    <div ref={popRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("chat.thinkingLevel")}
        className="flex items-center gap-1 rounded-full px-2 py-1 text-[12px] font-medium text-on-surface-variant transition-colors duration-150 hover:bg-on-surface/8 hover:text-on-surface"
      >
        <span>
          {t("chat.thinking")} · {effortLabel(t, current)}
        </span>
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
          className="shrink-0"
        >
          <path d="m3 6 5 5-5 5" />
        </svg>
      </button>
      {open && (
        <div
          role="listbox"
          aria-label={t("chat.thinkingLevel")}
          className="combo-pop combo-pop--up"
        >
          {[DEFAULT_TOKEN, ...options].map((token) => {
            const selected = current === token;
            return (
              <button
                key={token}
                type="button"
                role="option"
                aria-selected={selected}
                className="combo-option"
                onClick={() => {
                  setOpen(false);
                  stateRef.current.onPick(
                    token === DEFAULT_TOKEN ? undefined : token,
                  );
                }}
              >
                {effortLabel(t, token) + (selected ? " ✓" : "")}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
