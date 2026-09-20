// web_search 失败冷却(限流/不可达后短期跳过):API 通道(webSearch.ts)与
// tab 通道(tabSearch.ts)共用同一张表——被标记的 id 不论走哪条路径都该跳。
// 存 storage.session:浏览器会话内有效,SW 被杀重启也不丢;浏览器重开自动清零。
// 本模块只收口状态读写,不收口日志:两跳的 warn 文案与字段名不同(provider
// vs engine),由调用方各自记录。

// ⚠️ key 字面量是测试契约(tests/verify-web-search.mjs 直接 remove 本 key),不得改
export const COOLDOWN_KEY = "webSearch:engineCooldown";

export type CooldownKind = "blocked" | "unreachable";

/** blocked(限流/拒绝)与 unreachable(超时/不可达)的冷却时长 */
export const COOLDOWN_MS: Record<CooldownKind, number> = {
  blocked: 5 * 60_000,
  unreachable: 10 * 60_000,
};

export interface CooldownEntry {
  until: number;
  kind: CooldownKind;
}

type CooldownMap = Record<string, CooldownEntry>;

/** 读失败 → {}:冷却只是增强信息,存储故障不应放大成搜索故障 */
async function loadCooldowns(): Promise<CooldownMap> {
  try {
    const bag = await chrome.storage.session.get(COOLDOWN_KEY);
    return bag[COOLDOWN_KEY] ?? {};
  } catch {
    return {};
  }
}

/** 写失败静默:冷却写失败无碍,下次会重新尝试 */
async function saveCooldowns(map: CooldownMap): Promise<void> {
  try {
    await chrome.storage.session.set({ [COOLDOWN_KEY]: map });
  } catch {
    /* 冷却写失败无碍,下次会重新尝试 */
  }
}

/** 标记冷却:只写状态、不记日志(两跳 warn 文案/字段不同,由调用方各自记) */
export async function coolDown(id: string, kind: CooldownKind): Promise<void> {
  const map = await loadCooldowns();
  map[id] = { until: Date.now() + COOLDOWN_MS[kind], kind };
  await saveCooldowns(map);
}

/** 冷却中的条目;未冷却或存储读失败 → null(两处旧查询口径一致) */
export async function coolingDownEntry(
  id: string,
): Promise<CooldownEntry | null> {
  const map = await loadCooldowns();
  const hit = map[id];
  return hit?.until > Date.now() ? hit : null;
}

/** 清除该 id 的冷却;该 id 不存在则不写(避免无谓写盘) */
export async function clearCooldown(id: string): Promise<void> {
  const map = await loadCooldowns();
  if (!map[id]) return;
  delete map[id];
  await saveCooldowns(map);
}
