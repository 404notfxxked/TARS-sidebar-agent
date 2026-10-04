// composer 档位指示的状态 hook:从存储读 confirmLevel 并订阅变化。
// 档位呈现已收口到 pill(T7 撤设置页字段),storage 订阅仍必要:多个
// 浏览器窗口可各开一个侧栏面板,一窗切档另一窗要跟上;直写 storage 的
// 来源同理跟上(写法照 useChatModels 的 storage 订阅)。
// 真话边界:pill 显示存储档,在途 run 用 run 开始时的快照;用户在本轮
// 中途切档,已起的那一轮仍按旧档走完(run 结束即对齐)—— 生效时点提示已
// 随 2026-10-04 减噪决策移除,该边界只在头注陈述。落库与展示的顺序见
// pick 的注释:先写存储再改本地态,不给「点完立刻发消息」留旧档窗口。
import { useEffect, useState } from "react";
import {
  CONFIRM_LEVELS,
  loadConfig,
  saveConfirmLevel,
  type ConfirmLevel,
} from "../../shared/configStore";

export function useConfirmLevel(): {
  level: ConfirmLevel;
  /** 落库完成后才 resolve(见下方 pick 注释),调用侧可 await 当同步点 */
  pick: (level: ConfirmLevel) => Promise<void>;
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
  // 含 off(2026-10-04 决策,off 以 pill 的 warning 色常驻标示)。
  // 先落库、后改本地态:pill 文案得是「存储已改」的判据 —— UI 抢在写前面
  // 跳时,用户点完立刻发消息,后台 run 快照可能仍读到旧档(旧档是 strict
  // 就等于把这条消息的门又关上了),e2e 也拿不到稳定的同步点
  const pick = async (next: ConfirmLevel) => {
    await saveConfirmLevel(next);
    setLevel(next);
  };
  return { level, pick };
}
