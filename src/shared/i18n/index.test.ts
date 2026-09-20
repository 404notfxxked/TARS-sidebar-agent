// i18n 单测:zh/en 字典键位一致 + 占位符一致(此前人工比对,现自动化)
// + t() 插值/回落/订阅。键位缺漏另有 satisfies Dict 的
// 编译期校验和 scripts/check-i18n.mjs 的静态扫描,这里守运行时行为。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getLocale, setLocale, subscribeLocale, t } from "./index";
import { zhCN } from "./locales/zh-CN";
import { enUS } from "./locales/en-US";

type DictTree = Record<string, unknown>;

function leaves(tree: unknown, prefix = "", out: Map<string, string> = new Map()) {
  for (const [key, value] of Object.entries(tree as DictTree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object") leaves(value, path, out);
    else out.set(path, String(value));
  }
  return out;
}

const zh = leaves(zhCN);
const en = leaves(enUS);

/** 从字典里找带 {var} 占位符的键(找不到就跳过对应断言,防字典全改成无插值) */
function findKeyWithVar(leavesMap: Map<string, string>): [string, string] | null {
  for (const [path, value] of leavesMap) {
    if (/\{\w+\}/.test(value)) return [path, value];
  }
  return null;
}

beforeEach(() => setLocale("zh-CN"));

describe("字典键位与占位符", () => {
  it("en-US 与 zh-CN 键位完全一致", () => {
    expect([...en.keys()].sort()).toEqual([...zh.keys()].sort());
  });

  it("每个键的占位符集合两边一致(漏占位符 = 运行时亮 {n} 裸键)", () => {
    const varsOf = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    const diffs: string[] = [];
    for (const [path, zhValue] of zh) {
      const enValue = en.get(path);
      if (!enValue) continue; // 键位一致性上一条已管
      if (JSON.stringify(varsOf(zhValue)) !== JSON.stringify(varsOf(enValue))) {
        diffs.push(`${path}: zh=[${varsOf(zhValue)}] en=[${varsOf(enValue)}]`);
      }
    }
    expect(diffs).toEqual([]);
  });
});

describe("t()", () => {
  it("取当前语言的文案", () => {
    const [path, value] = findKeyWithVar(zh) ?? ["", null];
    if (!path) return;
    setLocale("zh-CN");
    expect(t(path)).toBe(value);
  });

  it("切语言后取 en-US 文案", () => {
    const [path] = findKeyWithVar(zh) ?? ["", null];
    if (!path) return;
    setLocale("en-US");
    expect(t(path)).toBe(en.get(path));
  });

  it("插值 {var} 被替换", () => {
    const found = findKeyWithVar(zh);
    if (!found) return;
    const [path, value] = found;
    const varName = value.match(/\{(\w+)\}/)![1];
    expect(t(path, { [varName]: "7" })).toContain("7");
    expect(t(path, { [varName]: "7" })).not.toContain(`{${varName}}`);
  });

  it("未知变量名保持占位符原样(方便发现传参拼错)", () => {
    const found = findKeyWithVar(zh);
    if (!found) return;
    const [path] = found;
    expect(t(path, { wrongVar: "x" })).toMatch(/\{\w+\}/);
  });

  it("缺键回落键名本身并告警(不亮裸崩溃)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(t("common.does-not-exist.anywhere")).toBe(
      "common.does-not-exist.anywhere",
    );
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("locale 订阅", () => {
  it("setLocale 通知订阅者,同值不通知,退订生效", () => {
    const fired: string[] = [];
    const unsub = subscribeLocale(() => fired.push(getLocale()));
    setLocale("en-US");
    setLocale("en-US"); // 同值:不重复通知
    expect(fired).toEqual(["en-US"]);
    unsub();
    setLocale("zh-CN");
    expect(fired).toEqual(["en-US"]);
    expect(getLocale()).toBe("zh-CN");
  });
});
