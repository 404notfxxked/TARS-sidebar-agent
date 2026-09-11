// 输入区 / 联想菜单:输入以 / 开头时在输入条上方弹出技能清单。
// 纯展示件:过滤与键盘导航状态由 ChatView 持有(焦点在 textarea,键盘事件
// 必须在它上面拦截);本组件只渲染 浮层 + 选项 + 空态引导。
// 浮层语言复用 combo-pop(M3 menu),选项为双行(名 + 描述截断)。

import { t } from "../../shared/i18n";
import type { SkillInfo } from "../../shared/messages";

export default function SkillMenu({
  skills,
  query,
  activeIndex,
  loading,
  hasAny,
  onPick,
  onHover,
  onManage,
}: {
  /** 已过滤的候选(启用技能按 query 过滤后) */
  skills: SkillInfo[];
  /** "/" 之后的输入:有候选时仅用于 footer 提示外;区分「无技能」与「无匹配」 */
  query: string;
  activeIndex: number;
  /** 清单尚未取回(首次触发后的短暂窗口) */
  loading: boolean;
  /** 装了至少一个启用技能;false = 空态引导去技能页 */
  hasAny: boolean;
  onPick: (name: string) => void;
  onHover: (index: number) => void;
  onManage: () => void;
}) {
  if (loading) {
    return (
      <div role="listbox" aria-label={t("skills.menuLabel")} className="combo-pop skill-pop">
        <p className="skill-pop-note m-0">{t("common.loading")}</p>
      </div>
    );
  }
  if (!hasAny) {
    return (
      <div role="listbox" aria-label={t("skills.menuLabel")} className="combo-pop skill-pop">
        <p className="skill-pop-note m-0">{t("skills.menuEmpty")}</p>
        <button type="button" className="skill-pop-manage" onClick={onManage}>
          {t("skills.menuManage")}
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
          >
            <path d="m6 3.5 4.5 4.5L6 12.5" />
          </svg>
        </button>
      </div>
    );
  }
  if (skills.length === 0) {
    return (
      <div role="listbox" aria-label={t("skills.menuLabel")} className="combo-pop skill-pop">
        <p className="skill-pop-note m-0">{t("skills.menuNoMatch", { query })}</p>
      </div>
    );
  }
  return (
    <div role="listbox" aria-label={t("skills.menuLabel")} className="combo-pop skill-pop">
      {skills.map((s, i) => (
        <button
          key={s.id}
          type="button"
          role="option"
          aria-selected={i === activeIndex}
          data-active={i === activeIndex}
          className="skill-option"
          onMouseEnter={() => onHover(i)}
          onMouseDown={(e) => e.preventDefault()} // 防止点击夺走 textarea 焦点
          onClick={() => onPick(s.name)}
        >
          <span className="skill-option-name">/{s.name}</span>
          <span className="skill-option-desc">{s.description}</span>
        </button>
      ))}
      <p className="skill-pop-note skill-pop-foot">{t("skills.menuHint")}</p>
    </div>
  );
}
