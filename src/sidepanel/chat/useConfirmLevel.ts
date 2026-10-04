// composer 档位指示的状态 hook:从存储读 confirmLevel 并订阅变化。
// 设置页每次打开都重挂载,而面板常驻 —— 只有 storage 订阅能让 pill 跟上
// 设置页的改动(写法照 useChatModels 的 storage 订阅)。
// 真话边界:pill 显示存储档,在途 run 用 run 开始时的快照;用户在本轮
// 中途切档,pill 会领先于本轮行为几秒 —— 由 pill 菜单底部的生效时点
// 提示承接(复用 security.confirmLevelHint),hook 不做轮内同步。
import { useEffect, useState } from "react";
import {
  CONFIRM_LEVELS,
  loadConfig,
  saveConfirmLevel,
  type ConfirmLevel,
} from "../../shared/configStore";

export function useConfirmLevel(): {
  level: ConfirmLevel;
  pick: (level: ConfirmLevel) => void;
} {
  const [level, setLevel] = useState<ConfirmLevel>("strict");
  useEffect(() => {
    const onStorage = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area !== "local") return;
      const v = changes.confirmLevel?.newValue;
      if (
        typeof v === "string" &&
        CONFIRM_LEVELS.includes(v as ConfirmLevel)
      ) {
        setLevel(v as ConfirmLevel);
      }
    };
    chrome.storage.onChanged.addListener(onStorage);
    loadConfig()
      .then((c) => setLevel(c.confirmLevel))
      .catch(() => {});
    return () => {
      chrome.storage.onChanged.removeListener(onStorage);
    };
  }, []);
  // 点选即落档(双写 legacy 键走 saveConfirmLevel);off 不经此路径,
  // 只在设置页两步确认
  const pick = (next: ConfirmLevel) => {
    setLevel(next);
    void saveConfirmLevel(next);
  };
  return { level, pick };
}
