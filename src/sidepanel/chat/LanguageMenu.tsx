// 首页顶栏语言快捷切换:icon-btn + 两项单选菜单。英文用户首开落在中文
// 界面时不必读懂「设置 → 外观」就能自救;与设置页 #ui-locale 下拉同一
// 落盘出口(savePrefs locale),内存态经 setLocale 广播整树重渲染。
// 弹层与溢出菜单同款(combo-pop--down + scrim,Esc 关菜单不冒泡)。

import { useState } from "react";
import { savePrefs, type LocalePref } from "../../shared/configStore";
import { setLocale } from "../../shared/i18n";
import { createLogger } from "../../shared/logger";
import { useLocale, useT } from "../ui/hooks";
import { CheckIcon } from "../ui/icons";

const log = createLogger({ ctx: "panel" });

/** 语言选项:标签是各语言「本名」(设置页同款键),不随界面语言翻译 */
const OPTIONS: { id: LocalePref; labelKey: "settings.languageZh" | "settings.languageEn" }[] = [
  { id: "zh-CN", labelKey: "settings.languageZh" },
  { id: "en-US", labelKey: "settings.languageEn" },
];

export default function LanguageMenu() {
  const t = useT();
  const locale = useLocale();
  const [open, setOpen] = useState(false);

  const pick = (next: LocalePref) => {
    setOpen(false);
    if (next === locale) return;
    setLocale(next);
    savePrefs({ locale: next }).catch((e) => {
      log.error("chat", "语言保存失败", { err: String(e) });
    });
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Esc 拦截容器:焦点在菜单内按钮上时按键在此捕获,收起不冒泡(溢出菜单同款)
    <div
      className="relative"
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation(); // 只关菜单,不冒泡(Esc 语义与溢出菜单一致)
          setOpen(false);
        }
      }}
    >
      {/* 「文A」是语言符号不是文案:两种界面语言下同形,不加字典键 */}
      <button
        type="button"
        aria-label={t("chat.switchLanguage")}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("chat.switchLanguage")}
        onClick={() => setOpen((v) => !v)}
        className="icon-btn text-[11px] font-semibold"
      >
        文A
      </button>
      {open && (
        <>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: 菜单垫层(scrim),标准模式 */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: 垫层仅服务指针,键盘经 Esc 关闭 */}
          <div
            className="fixed inset-0 z-10"
            onClick={() => setOpen(false)}
          />
          <div className="combo-pop combo-pop--down z-20" role="menu">
            {OPTIONS.map(({ id, labelKey }) => {
              const label = t(labelKey);
              const current = locale === id;
              return (
                <button
                  key={id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={current}
                  onClick={() => pick(id)}
                  className={`flex w-full items-center gap-1.5 rounded-none px-3 py-1.5 text-left text-[12.5px] transition-colors duration-150 ${
                    current
                      ? "font-medium text-primary"
                      : "text-on-surface hover:bg-on-surface/8"
                  }`}
                >
                  <span className="w-3.5 shrink-0">
                    {current && <CheckIcon />}
                  </span>
                  {label}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
