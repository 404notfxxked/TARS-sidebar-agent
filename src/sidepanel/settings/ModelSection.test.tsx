// @vitest-environment jsdom
// ModelSection:模型漂移标记与供应商级一键清理。「获取列表」把本地独有模型
// 标为「不在官方列表」(写入逻辑在 mergeFetchedModels,纯函数单测另覆盖),
// 这里盖 UI 层:行首警示图标 + 展开说明的呈现、清理的两段确认、默认模型被
// 清时的回落(挂到 patchProvider 的兜底,清理经 onPatch save=true 触发)。
// savePrefs 打桩记写入,文案断言一律整值取字典键(check-test-strings 纪律)。

import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { zhCN } from "../../shared/i18n/locales/zh-CN";
import type { ProviderEntry } from "../../shared/configStore";
import type { ModelDomain } from "./ModelSection";

const h = vi.hoisted(() => ({
  prefWrites: [] as Record<string, unknown>[],
}));

vi.mock("../../shared/configStore", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  savePrefs: vi.fn((prefs: Record<string, unknown>) => {
    h.prefWrites.push(prefs);
    return Promise.resolve();
  }),
}));

import ModelSection from "./ModelSection";

afterEach(() => {
  h.prefWrites.length = 0;
  cleanup();
});

const provider = (models: ProviderEntry["models"]): ProviderEntry => ({
  id: "prov-1",
  name: "TestProv",
  baseUrl: "https://api.test.example.com/v1",
  apiKey: "sk-test",
  models,
});

/** 域状态持在父级(同 SettingsView 的真实形态):onChange 回写后重渲染,
 *  清理后的「徽标/提示行消失」才有断言依据 */
function Harness({ initial }: { initial: ModelDomain }) {
  const [domain, setDomain] = useState(initial);
  return <ModelSection domain={domain} onChange={setDomain} run={() => {}} />;
}

function renderSection() {
  render(
    <Harness
      initial={{
        providers: [
          provider([{ id: "kept-model" }, { id: "old-model", unlisted: true }]),
        ],
        modelProvider: "prov-1",
        // 默认模型落在漂移模型上:清理须触发回落(patchProvider 兜底)
        model: "old-model",
      }}
    />,
  );
}

describe("模型漂移标记与一键清理", () => {
  it("未收录模型行头部有警示图标,正常行没有", () => {
    renderSection();
    const mark = screen.getByRole("img", { name: zhCN.settings.unlistedMark });
    expect(mark).toBeInTheDocument();
    // 只标在漂移行:图标 + 行名同现于一个头部按钮
    const head = mark.closest("button");
    expect(head).not.toBeNull();
    expect(head).toHaveTextContent("old-model");
    expect(head).not.toHaveTextContent("kept-model");
  });

  it("展开未收录行显示成因说明(可能已下线/重新获取即更新)", async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(screen.getByText("old-model").closest("button")!);
    expect(screen.getByText(zhCN.settings.unlistedHint)).toBeInTheDocument();
  });

  it("一键清理首点只进入待确认,不写盘", async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(
      screen.getByRole("button", { name: zhCN.settings.cleanUnlisted }),
    );
    expect(
      screen.getByText(zhCN.settings.confirmCleanUnlisted),
    ).toBeInTheDocument();
    expect(h.prefWrites).toEqual([]);
  });

  it("再点确认:移除全部未收录模型并写盘;默认模型被清回落到剩余首个", async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(
      screen.getByRole("button", { name: zhCN.settings.cleanUnlisted }),
    );
    await user.click(
      screen.getByRole("button", { name: zhCN.settings.confirmCleanUnlisted }),
    );
    const providersWrite = h.prefWrites.find((p) => "providers" in p);
    expect(providersWrite).toBeDefined();
    expect(
      (providersWrite as { providers: ProviderEntry[] }).providers[0].models.map(
        (m) => m.id,
      ),
    ).toEqual(["kept-model"]);
    // 当前默认被清:回落写盘,对话侧不持悬空引用
    expect(h.prefWrites).toContainEqual({ model: "kept-model" });
  });

  it("清理后警示图标与提示行消失(域回写后重渲染)", async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(
      screen.getByRole("button", { name: zhCN.settings.cleanUnlisted }),
    );
    await user.click(
      screen.getByRole("button", { name: zhCN.settings.confirmCleanUnlisted }),
    );
    expect(
      screen.queryByRole("img", { name: zhCN.settings.unlistedMark }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        zhCN.settings.unlistedNotice.replace("{n}", "1"),
      ),
    ).not.toBeInTheDocument();
  });

  it("无漂移模型:不出现提示行与清理入口", () => {
    render(
      <Harness
        initial={{
          providers: [provider([{ id: "kept-model" }])],
          modelProvider: "prov-1",
          model: "kept-model",
        }}
      />,
    );
    expect(
      screen.queryByRole("button", { name: zhCN.settings.cleanUnlisted }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("img", { name: zhCN.settings.unlistedMark }),
    ).not.toBeInTheDocument();
  });

  it("提示行文案按漂移数插值", () => {
    renderSection();
    expect(
      screen.getByText(zhCN.settings.unlistedNotice.replace("{n}", "1")),
    ).toBeInTheDocument();
  });
});
