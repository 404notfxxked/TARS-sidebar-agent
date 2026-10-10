// 重点色清单的跨源一致性:同一份清单在四个文件里各有一份副本 ——
// 真源 scripts/generate-m3.mjs 的 ACCENTS(id + 源色 hex);configStore 的
// AccentPref 类型 + ACCENT_IDS(存储读校验);AppearanceSection 的
// ACCENT_COLORS(hex 副本)+ ACCENT_LABEL_KEYS(键完整性由 TS Record 保证);
// tests/shot-m3 的试色 id 清单。generate-m3 顶层有写文件副作用、shot-m3
// 顶层起浏览器,都不能 import;本文件在 src/ 内也不便引 node:fs
// (tsconfig types 只有 chrome)。故用 vite 的 ?raw 转换期取源文本解析,
// 新增重点色漏改任何一处,这里红。

/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { ACCENT_IDS } from "./configStore";

// ?raw 转换期取源文本;import.meta.glob 只收字面量 pattern,三个文件各写一处
const rawGenerator = Object.values(
  import.meta.glob("../../scripts/generate-m3.mjs", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
)[0] as string;
const rawAppearance = Object.values(
  import.meta.glob("../../src/sidepanel/settings/AppearanceSection.tsx", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
)[0] as string;
const rawShot = Object.values(
  import.meta.glob("../../tests/shot-m3.mjs", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
)[0] as string;

/** 副本数组的源文本切片:起点锚到「const X = [」,裸前缀会先命中
 *  ACCENTS_ONLY 一类同名变量,其头注里的「名];」又会把块尾提前 */
const arrayBlock = (text: string, decl: string): string => {
  const start = text.indexOf(decl);
  if (start < 0) throw new Error(`源文本里找不到 ${decl}`);
  return text.slice(start, text.indexOf("];", start));
};

/** 真源:generate-m3.mjs 的 ACCENTS(id → 源色 hex) */
function parseGenerator(): Map<string, string> {
  const block = arrayBlock(rawGenerator, "const ACCENTS = [");
  const out = new Map<string, string>();
  for (const m of block.matchAll(
    /id: "(\w+)", label: "[^"]*", source: "(#[0-9a-fA-F]{6})"/g,
  )) {
    out.set(m[1]!, m[2]!);
  }
  return out;
}

/** AppearanceSection.tsx 的 ACCENT_COLORS hex 副本(id → hex) */
function parseAppearanceHex(): Map<string, string> {
  const block = arrayBlock(rawAppearance, "const ACCENT_COLORS");
  const out = new Map<string, string>();
  for (const m of block.matchAll(/\["(\w+)", "(#[0-9a-fA-F]{6})"\]/g)) {
    out.set(m[1]!, m[2]!);
  }
  return out;
}

/** tests/shot-m3.mjs 的试色 id 清单([id, label] 对的 id 列) */
function parseShotIds(): string[] {
  const block = arrayBlock(rawShot, "const ACCENTS = [");
  return [...block.matchAll(/\["(\w+)"/g)].map((m) => m[1]!);
}

const sorted = (xs: readonly string[]) => [...xs].sort();
const fromGenerator = parseGenerator();
const generatorIds = [...fromGenerator.keys()];

describe("重点色清单跨源一致(副本对齐真源)", () => {
  it("configStore.ACCENT_IDS 与真源 id 清单一致", () => {
    expect(sorted(ACCENT_IDS)).toEqual(sorted(generatorIds));
  });

  it("AppearanceSection 的 hex 副本与真源逐色相等(色板排序允许不同)", () => {
    const hex = parseAppearanceHex();
    expect(sorted([...hex.keys()])).toEqual(sorted(generatorIds));
    for (const [id, source] of fromGenerator) {
      expect(hex.get(id), `${id} 的 hex 副本与真源不等`).toBe(source); // i18n-ok:断言消息,非 UI 文案断言
    }
  });

  it("shot-m3 的试色 id 清单与真源一致", () => {
    expect(sorted(parseShotIds())).toEqual(sorted(generatorIds));
  });
});
