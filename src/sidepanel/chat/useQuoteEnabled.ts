// 空态每日一句展示开关(设置 → 外观):初值随配置,storage 事件实时跟随。

import { useEffect, useState } from "react";
import { loadConfig } from "../../shared/configStore";

export function useQuoteEnabled(): boolean {
  const [quoteEnabled, setQuoteEnabled] = useState(true);
  useEffect(() => {
    const onStorage = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area !== "local") return;
      if (changes.quote && typeof changes.quote.newValue === "boolean") {
        setQuoteEnabled(changes.quote.newValue);
      }
    };
    chrome.storage.onChanged.addListener(onStorage);
    loadConfig().then((c) => setQuoteEnabled(c.quote));
    return () => {
      chrome.storage.onChanged.removeListener(onStorage);
    };
  }, []);
  return quoteEnabled;
}
