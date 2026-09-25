// 聊天空态:品牌标 + 时段定档招呼语 + 快捷提问 chips。
// 标题按本机时段定档(timeGreetKey,挂载时定一次,重渲不跳变);
// chips 从 10 条池里抽 3,「换一批」原地重抽。

import { useState } from "react";
import { useT } from "../ui/hooks";
import { LogoMark, RefreshIcon } from "../ui/icons";
import { timeGreetKey } from "./greeting";

const SUGGESTIONS = [
  "chat.suggestRead",
  "chat.suggestDigest",
  "chat.suggestSearch",
  "chat.suggestForm",
  "chat.suggestTable",
  "chat.suggestExplore",
  "chat.suggestTranslate",
  "chat.suggestSources",
  "chat.suggestRemember",
  "chat.suggestCompare",
] as const;

/** Fisher-Yates 洗牌(纯函数) */
function shuffle<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** 空态:chips 点击即回填输入框并聚焦;从 10 条池里抽 3,「换一批」原地重抽,
 *  不必重开面板 */
export function EmptyState({
  onPick,
}: {
  onPick: (text: string) => void;
}) {
  const t = useT();
  // 挂载时定一次,重渲不重抽(否则流式期间招呼语会跳变)
  const [greetKey] = useState(() => timeGreetKey(new Date().getHours()));
  const [chipKeys, setChipKeys] = useState(() =>
    shuffle(SUGGESTIONS).slice(0, 3),
  );
  return (
    <div className="flex flex-col items-center px-6 pb-10 pt-16 text-center">
      <LogoMark />
      <p className="mt-4 text-[15px] font-medium text-on-surface">
        {t(greetKey)}
      </p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        {chipKeys.map((key) => {
          const label = t(key);
          return (
            <button
              key={key}
              type="button"
              className="empty-chip"
              onClick={() => onPick(label)}
            >
              {label}
            </button>
          );
        })}
        <button
          type="button"
          className="icon-btn h-7 w-7 self-center"
          aria-label={t("chat.suggestShuffle")}
          title={t("chat.suggestShuffle")}
          onClick={() => setChipKeys(shuffle(SUGGESTIONS).slice(0, 3))}
        >
          <RefreshIcon />
        </button>
      </div>
    </div>
  );
}
