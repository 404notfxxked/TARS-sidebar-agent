// composer 档位指示的状态 hook:从存储读 confirmLevel 并订阅变化。
// 档位呈现已收口到 pill(T7 撤设置页字段),storage 订阅仍必要:多个
// 浏览器窗口可各开一个侧栏面板,一窗切档另一窗要跟上;直写 storage 的
// 来源同理跟上(写法照 useChatModels 的 storage 订阅)。
// 真话边界:pill 显示存储档,在途 run 用 run 开始时的快照;用户在本轮
// 中途切档,pill 会领先于本轮行为几秒(run 结束即对齐),hook 不做轮内
// 同步 —— 生效时点提示已随 2026-10-04 减噪决策移除,该边界只在头注陈述。
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
  // 点选即落档(双写 legacy 键走 saveConfirmLevel);三档同权经此路径,
  // 含 off(2026-10-04 决策,off 以 pill 的 warning 色常驻标示)
  const pick = (next: ConfirmLevel) => {
    setLevel(next);
    void saveConfirmLevel(next);
  };
  return { level, pick };
}
