// composer 底行的档位指示 pill:显示当前档,点开快捷菜单可切 strict/auto。
// 菜单刻意不放 off —— 放宽容易、放弃人审麻烦,「从 composer 到不了 off」
// 是结构属性(工单 §0);off 只在设置页(常驻警示 + 两步确认)。
// 真话边界:pill 显示存储档,在途 run 用 run 开始时的快照,中途切档时
// pill 领先于本轮行为几秒 —— 菜单底部常驻一行生效时点提示承接(复用
// security.confirmLevelHint,不新抄一句)。
// 结构照 ThinkingPicker/ModelPicker:pill 触发钮 + 向上 combo-pop,
// 点外/Esc 关闭,↑↓/Home/End 键盘导航,Enter/Tab 选中(焦点保持在
// 触发钮,高亮项经 aria-activedescendant 桥给读屏)。

import { useEffect, useRef, useState } from "react";
import type { ComponentType } from "react";
import type { ConfirmLevel } from "../../shared/configStore";
import { ConfirmIcon, PencilIcon, WarnIcon } from "../ui/icons";
import { useT } from "../ui/hooks";

// 键位表必须写字面量:check-i18n 只收集键形字面量(先例 EFFORT_KEYS)
const LEVEL_SHORT: Record<ConfirmLevel, string> = {
  strict: "chat.confirmPillStrict",
  auto: "chat.confirmPillAuto",
  off: "chat.confirmPillOff",
};
/** aria 与 off 提示用设置页长标:短标是像素预算下的省略,完整陈述由 aria 承载 */
const LEVEL_LONG: Record<ConfirmLevel, string> = {
  strict: "security.confirmLevelStrict",
  auto: "security.confirmLevelAuto",
  off: "security.confirmLevelOff",
};
const LEVEL_ICON: Record<ConfirmLevel, ComponentType> = {
  strict: ConfirmIcon,
  auto: PencilIcon,
  off: WarnIcon,
};
/** 菜单只有 strict 与 auto;off 不进快捷菜单(见头注) */
const MENU_LEVELS: ConfirmLevel[] = ["strict", "auto"];
const LEVEL_DESC: Record<"strict" | "auto", string> = {
  strict: "chat.confirmPillStrictDesc",
  auto: "chat.confirmPillAutoDesc",
};

export default function ConfirmLevelPill({
  level,
  pick,
}: {
  level: ConfirmLevel;
  pick: (level: ConfirmLevel) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  /** 键盘高亮项(扁平序);打开时落在当前选中档上 */
  const [activeIdx, setActiveIdx] = useState(0);
  const popRef = useRef<HTMLDivElement | null>(null);

  // document 级监听读最新状态走 ref(含键盘高亮项),监听器只随开关注册
  // (照 ModelPicker:Enter 读取的是重渲染后同步的最新高亮)
  const stateRef = useRef({ level, pick, activeIdx });
  stateRef.current = { level, pick, activeIdx };

  useEffect(() => {
    if (!open) return;
    setActiveIdx(Math.max(MENU_LEVELS.indexOf(stateRef.current.level), 0));
    const onDown = (e: MouseEvent) => {
      if (!popRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      const s = stateRef.current;
      if (e.key === "Escape") {
        setOpen(false);
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const d = e.key === "ArrowDown" ? 1 : -1;
        const total = MENU_LEVELS.length;
        s.activeIdx = (s.activeIdx + d + total) % total;
        setActiveIdx(s.activeIdx);
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && MENU_LEVELS.length > 0) {
        e.preventDefault();
        const next = MENU_LEVELS[s.activeIdx];
        setOpen(false);
        s.pick(next);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const Icon = LEVEL_ICON[level];

  return (
    <div ref={popRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("chat.confirmPillAria", { level: t(LEVEL_LONG[level]) })}
        className={`flex items-center gap-1 rounded-full px-2 py-1 text-[12px] font-medium transition-colors duration-150 hover:bg-on-surface/8 ${
          level === "off"
            ? "text-error"
            : "text-on-surface-variant hover:text-on-surface"
        }`}
      >
        {/* WarnIcon 自带 mt-0.5(确认卡语境的对齐),pill 里由外层容器统一对齐 */}
        <span className="flex items-center [&>svg]:my-0">
          <Icon />
        </span>
        <span>{t(LEVEL_SHORT[level])}</span>
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
          <path d="m6 3.5 4.5 4.5L6 12.5" />
        </svg>
      </button>
      {open && (
        <div
          role="listbox"
          aria-label={t(LEVEL_LONG[level])}
          aria-activedescendant={`cl-opt-${activeIdx}`}
          tabIndex={0}
          className="combo-pop combo-pop--up"
        >
          {level === "off" && (
            <p className="whitespace-normal px-3 pb-1 pt-2 font-sans text-[11.5px] text-error">
              {t("chat.confirmPillOffCurrent")}
            </p>
          )}
          {MENU_LEVELS.map((l, idx) => {
            const OptionIcon = LEVEL_ICON[l];
            const selected = level === l;
            return (
              <button
                key={l}
                id={`cl-opt-${idx}`}
                type="button"
                role="option"
                aria-selected={selected}
                data-active={idx === activeIdx}
                className="combo-option"
                onMouseEnter={() => setActiveIdx(idx)}
                onClick={() => {
                  setOpen(false);
                  pick(l);
                }}
              >
                <span className="flex items-center gap-1.5 font-sans">
                  <span className="flex items-center [&>svg]:my-0">
                    <OptionIcon />
                  </span>
                  {t(LEVEL_SHORT[l]) + (selected ? " ✓" : "")}
                </span>
                <span className="block whitespace-normal font-sans text-[11px] leading-4 text-on-surface-variant">
                  {/* l 来自 MENU_LEVELS(不含 off),收窄为 desc 表的键 */}
                  {t(LEVEL_DESC[l as "strict" | "auto"])}
                </span>
              </button>
            );
          })}
          <p className="whitespace-normal px-3 pb-2 pt-1.5 font-sans text-[11px] leading-4 text-on-surface-variant/80">
            {t("security.confirmLevelHint")}
          </p>
        </div>
      )}
    </div>
  );
}
