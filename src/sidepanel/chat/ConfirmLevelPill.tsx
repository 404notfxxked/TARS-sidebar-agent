// composer 底行的档位指示 pill:显示当前档,点开快捷菜单可切 strict/auto/off。
// 三档同权、单击落档(2026-10-04 产品决策:撤销「composer 到不了 off」的
// 结构属性 —— 业界主流是审批模式就在输入区单键切换,不做重复二次确认);
// off 的知情由菜单 desc 一行承载(范围写全:记忆读写、MCP、私网与陌生
// 链接),危险态以固定琥珀 warning 色常驻标示(error 留给失败/破坏性语义)。
// 真话边界:pill 显示存储档(点选等落库完成才换文案,见 useConfirmLevel);
// 在途 run 用 run 开始时的快照,已起的那一轮仍按旧档走完。off 的无人审
// 风险由用户知情拍板接受,pill 的 warning 色是唯一常驻警示。
// 结构照 ThinkingPicker/ModelPicker:pill 触发钮 + 向上 combo-pop,
// 点外/Esc 关闭,↑↓ 循环移动高亮,Enter/Tab 选中(焦点保持在触发钮,
// 高亮项经 aria-activedescendant 桥给读屏)。

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
/** aria 长标用设置页措辞:短标是像素预算下的省略,完整陈述由 aria 承载 */
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
/** 菜单三档同权(off 排尾,见头注);off 的知情由 desc 全量承载 */
const MENU_LEVELS: ConfirmLevel[] = ["strict", "auto", "off"];
const LEVEL_DESC: Record<ConfirmLevel, string> = {
  strict: "chat.confirmPillStrictDesc",
  auto: "chat.confirmPillAutoDesc",
  off: "chat.confirmPillOffDesc",
};

export default function ConfirmLevelPill({
  level,
  pick,
}: {
  level: ConfirmLevel;
  /** 落库完成后才 resolve(契约同 ComposerConfirm.pick);组件侧不消费返回值,
   *  fire-and-forget —— 菜单选项与键盘选中路径都只负责发起落档 */
  pick: (level: ConfirmLevel) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  /** 键盘高亮项(扁平序);打开时落在当前选中档上 */
  const [activeIdx, setActiveIdx] = useState(0);
  const popRef = useRef<HTMLDivElement | null>(null);
  /** 菜单水平收偏:combo-pop--up 锚定锚点左缘向右伸(max-content 封顶
   *  280px),而底行 pill 离面板左缘远(附件钮/模型 chip/思考 picker 都在
   *  左边),窄侧栏下右侧放不下 —— 打开时量锚点位置,把菜单向左收,
   *  右缘贴视口(留 8px),左缘不低于 8px。0 = 不收(空间充足时维持左对齐) */
  const [shiftX, setShiftX] = useState(0);

  // document 级监听读最新状态走 ref(含键盘高亮项),监听器只随开关注册
  // (照 ModelPicker:Enter 读取的是重渲染后同步的最新高亮)
  const stateRef = useRef({ level, pick, activeIdx });
  stateRef.current = { level, pick, activeIdx };

  useEffect(() => {
    if (!open) return;
    setActiveIdx(Math.max(MENU_LEVELS.indexOf(stateRef.current.level), 0));
    const anchor = popRef.current?.querySelector("button");
    const vw = window.innerWidth;
    const left = anchor?.getBoundingClientRect().left ?? 0;
    const overflow = left + 280 + 8 - vw; // 右伸会超出的量(280 = combo-pop--up 的宽度封顶)
    setShiftX(Math.max(8 - left, Math.min(0, -overflow)));
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
      if (e.key === "Enter" || e.key === "Tab") {
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
            ? "text-warning"
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
          className="combo-pop combo-pop--up combo-pop--list"
          style={shiftX !== 0 ? { left: shiftX } : undefined}
        >
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
                <span
                  className={`flex items-center gap-1.5 font-sans ${
                    l === "off" ? "text-warning" : ""
                  }`}
                >
                  <span className="flex items-center [&>svg]:my-0">
                    <OptionIcon />
                  </span>
                  {t(LEVEL_SHORT[l]) + (selected ? " ✓" : "")}
                </span>
                <span className="block whitespace-normal font-sans text-[11px] leading-4 text-on-surface-variant">
                  {t(LEVEL_DESC[l])}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
