// 聊天空态:品牌标 + 时段定档招呼语 + 快捷提问 chips + 每日一句注脚。
// 标题按本机时段定档(timeGreetKey,挂载时定一次,重渲不跳变);
// 副标是每日一句:窥探当日缓存,有就用、没有就用本地池播种条 ——
// 首帧即终帧,补抓只在后台落盘供下次挂载,挂载中文案绝不跳变。
// quote 是内容不是产品话术,不进字典,细节见 greeting.ts 头注。
// chips 仍从 10 条池里抽 3,「换一批」原地重抽。

import { useEffect, useState } from "react";
import { useLocale, useT } from "../ui/hooks";
import { LogoMark, RefreshIcon } from "../ui/icons";
import {
  dayKeyOf,
  localQuote,
  peekDailyQuote,
  QUOTE_SOURCE,
  quoteDisplay,
  quoteSourceHref,
  timeGreetKey,
  warmDailyQuote,
  type Quote,
} from "./greeting";

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

/** 每日一句:出处与内容来源默认隐藏,悬停/键盘聚焦整块显形(.quote-source,
 *  空间常驻不跳布局)。署名只标网络来源(一言):本地池是自家内容,标来源
 *  就是错标 —— 面板靠 quote.src 判断,不靠「有没有 from」猜。 */
function DailyQuote() {
  const locale = useLocale();
  const t = useT();
  const day = dayKeyOf();
  const [quote, setQuote] = useState<Quote>(
    () => peekDailyQuote(locale, day) ?? localQuote(locale, day),
  );
  useEffect(() => {
    // 同步重选(挂载时窥探若尚未成熟,这里补一次;此后不再动):
    // 语言切换/跨天时按当前语言与日期换一条,依旧不做任何异步替换
    setQuote(peekDailyQuote(locale, day) ?? localQuote(locale, day));
    void warmDailyQuote(locale, day);
  }, [locale, day]);
  const q = quoteDisplay(quote, locale);
  // 「来自」是 UI 文案,走字典键;源名是专有名词,与链接同放 QUOTE_SOURCE。
  // 键值形如「来自 {source}」,这里只取占位符前的子串,品牌名由常量补上
  const viaPrefix = t("chat.quoteVia").split("{")[0];
  const credited = quote.src === QUOTE_SOURCE.id;
  return (
    <div className="quote-block">
      <p className="quote-text">{q.text}</p>
      {(q.from || credited) && (
        <p className="quote-source">
          {q.from}
          {q.from && credited ? " · " : null}
          {credited && (
            <>
              {viaPrefix}
              <a
                href={quoteSourceHref(quote)}
                target="_blank"
                rel="noreferrer"
              >
                {QUOTE_SOURCE.name}
              </a>
            </>
          )}
        </p>
      )}
    </div>
  );
}

/** 空态:chips 点击即回填输入框并聚焦;从 10 条池里抽 3,「换一批」原地重抽,
 *  不必重开面板 */
export function EmptyState({
  onPick,
  showQuote,
}: {
  onPick: (text: string) => void;
  showQuote: boolean;
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
      {/* 排序 = Momentum 结构:Hero(标+问候)→ 行动(chips)→ 注脚(quote)。
          quote 是氛围性注脚(出处悬停显形),垫在块尾,空槽溶进块尾留白 */}
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
      {showQuote && <DailyQuote />}
    </div>
  );
}
