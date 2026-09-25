// 空态问候:标题按本机时段定档(5 档)。问候语是 UI 文案,走 i18n 字典
// (chat.greet*),本模块只负责「小时 → 键」的纯映射。

/** 本机时段 → 问候键(hour 为 new Date().getHours()) */
export function timeGreetKey(hour: number): string {
  if (hour >= 5 && hour < 11) return "chat.greetMorning";
  if (hour >= 11 && hour < 13) return "chat.greetNoon";
  if (hour >= 13 && hour < 18) return "chat.greetAfternoon";
  if (hour >= 18 && hour < 23) return "chat.greetEvening";
  return "chat.greetLateNight";
}
