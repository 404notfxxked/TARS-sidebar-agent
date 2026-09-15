// 输入区的模型选择器:当前模型名 pill,点开按供应商分组的 listbox。
// 自含开合状态与「点外/Esc 关闭」;↑↓/Home/End 键盘导航,Enter/Tab 选中
// (焦点保持在触发钮上,高亮项经 aria-activedescendant 桥给读屏)。
// 切换即写回 modelProvider + model 两字段(由 onPick 回调实现),
// 后台每轮 run 重读配置,下一轮生效。

import { useEffect, useMemo, useRef, useState } from "react";
import type { ProviderEntry } from "../../shared/configStore";
import { t } from "../../shared/i18n";

export default function ModelPicker({
  providers,
  modelProvider,
  modelId,
  onPick,
}: {
  providers: ProviderEntry[];
  /** 当前引用(选择器高亮依据) */
  modelProvider: string;
  modelId: string;
  onPick: (providerId: string, modelId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  /** 键盘/悬停共用的当前高亮项(扁平序);打开时落在当前选中模型上 */
  const [activeIdx, setActiveIdx] = useState(0);
  const popRef = useRef<HTMLDivElement | null>(null);

  // 渲染分组带扁平序起点,选项 id/键盘高亮共用同一套下标
  const groups = useMemo(() => {
    const out: { provider: ProviderEntry; start: number }[] = [];
    let n = 0;
    for (const p of providers) {
      if (p.models.length === 0) continue;
      out.push({ provider: p, start: n });
      n += p.models.length;
    }
    return out;
  }, [providers]);
  const total = useMemo(
    () => groups.reduce((acc, g) => acc + g.provider.models.length, 0),
    [groups],
  );

  // document 级监听读最新状态走 ref,监听器只随开关注册一次
  const stateRef = useRef({ groups, total, activeIdx, modelProvider, modelId, onPick });
  stateRef.current = { groups, total, activeIdx, modelProvider, modelId, onPick };

  useEffect(() => {
    if (!open) return;
    // 打开时高亮当前选中模型(引用失效则落首项)
    const { groups: gs, modelProvider: mp, modelId: mid } = stateRef.current;
    let n = 0;
    let sel = 0;
    for (const g of gs) {
      const hit = g.provider.models.findIndex(
        (m) => g.provider.id === mp && m.id === mid,
      );
      if (hit >= 0) {
        sel = n + hit;
        break;
      }
      n += g.provider.models.length;
    }
    setActiveIdx(sel);

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
        if (s.total === 0) return;
        const d = e.key === "ArrowDown" ? 1 : -1;
        setActiveIdx((i) => (i + d + s.total) % s.total);
        return;
      }
      if (e.key === "Home") {
        e.preventDefault();
        setActiveIdx(0);
        return;
      }
      if (e.key === "End") {
        e.preventDefault();
        setActiveIdx(Math.max(s.total - 1, 0));
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && s.total > 0) {
        // 焦点在触发钮上:拦下默认行为(Enter 会再触发钮,Tab 会移走焦点)
        e.preventDefault();
        const pick = optionAt(s.groups, s.activeIdx);
        if (!pick) return;
        setOpen(false);
        s.onPick(pick.providerId, pick.model.id);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // 高亮项移出视口时滚到可见(键盘导航时弹层可能比列表高)
  useEffect(() => {
    if (!open) return;
    popRef.current
      ?.querySelector(`#mp-opt-${activeIdx}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIdx, open]);

  // 引用失效时退回第一个供应商(配置刚写入/被清空的过渡态)
  const curProvider =
    providers.find((p) => p.id === modelProvider) ?? providers[0];
  const curModels = curProvider?.models ?? [];

  return (
    <div ref={popRef} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("chat.selectModel")}
        className="flex items-center gap-1 rounded-full px-2 py-1 text-[12px] font-medium text-on-surface-variant transition-colors duration-150 hover:bg-on-surface/8 hover:text-on-surface"
      >
        <span className="min-w-0 truncate">
          {curModels.find((m) => m.id === modelId)?.alias ||
            modelId ||
            t("chat.selectModel")}
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
          aria-label={t("chat.modelOptions")}
          aria-activedescendant={`mp-opt-${activeIdx}`}
          // tabindex:aria-activedescendant 的容器必须可聚焦(ARIA 规范要求)
          tabIndex={0}
          className="combo-pop combo-pop--up"
        >
          {groups.map(({ provider: p, start }) => (
            // biome-ignore lint/a11y/useSemanticElements: listbox 内的 option 分组无语义等价元素,fieldset 会破坏结构
            <div key={p.id} role="group" aria-label={p.name}>
              <div
                aria-hidden="true"
                className="px-3 pb-0.5 pt-2 text-[10.5px] font-medium uppercase tracking-wide text-on-surface-variant/70 first:pt-1.5"
              >
                {p.name || new URL(p.baseUrl).hostname}
              </div>
              {p.models.map((m, mi) => {
                const idx = start + mi;
                const selected = p.id === curProvider?.id && m.id === modelId;
                return (
                  <button
                    key={`${p.id}/${m.id}`}
                    id={`mp-opt-${idx}`}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    data-active={idx === activeIdx}
                    className="combo-option"
                    title={m.alias ? m.id : undefined}
                    onMouseEnter={() => setActiveIdx(idx)}
                    onClick={() => {
                      setOpen(false);
                      onPick(p.id, m.id);
                    }}
                  >
                    {(m.alias || m.id) + (selected ? " ✓" : "")}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 扁平序 → 选项(供应商分组顺序 × 组内模型顺序,与渲染一致) */
function optionAt(
  groups: { provider: ProviderEntry }[],
  idx: number,
): { providerId: string; model: ProviderEntry["models"][number] } | null {
  let n = 0;
  for (const g of groups) {
    for (const m of g.provider.models) {
      if (n === idx) return { providerId: g.provider.id, model: m };
      n++;
    }
  }
  return null;
}
