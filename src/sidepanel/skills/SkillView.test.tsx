// @vitest-environment jsdom
// SkillView 编辑器新鲜度守卫回归(审计 §1.4):SKILL_RAW 是异步回包,
// 连点两条技能时先点的请求可能后回 —— 迟到的原文若仍回填编辑器,
// 「点 A → 点 B → A 的原文后到」会让 editor.id=B 而 draft=A,
// 点保存即把 A 的内容写进 B,静默写坏用户数据。
// 守卫语义(照 useAgentChannel 的 actionSeq):每次 startEdit 取递增序号,
// 回包时序号过期即丢弃;关闭/切添加也递增,作废全部在途请求。

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { zhCN } from "../../shared/i18n/locales/zh-CN";
import type { SkillInfo } from "../../shared/messages";

const h = vi.hoisted(() => ({
  // startEdit 的 SKILL_RAW 请求在此排队,由用例控制回包顺序
  rawWaiters: [] as { id: string; resolve: (r: { id: string; raw?: string }) => void }[],
  skills: [
    { id: "a", name: "skill-a", description: "A 技能", enabled: true, updatedAt: 1, chars: 10 },
    { id: "b", name: "skill-b", description: "B 技能", enabled: true, updatedAt: 2, chars: 10 },
  ] as SkillInfo[],
  // 列表请求失败开关(REQ-P0-3 用例;仅对 SKILL_LIST 生效,写动作不受影响)
  failList: false,
}));

vi.mock("../clients/skillClient", () => ({
  skillReq: vi.fn((msg: { type?: string }) =>
    h.failList && msg?.type === "skill_list"
      ? Promise.reject(new Error("storage down")) // i18n-ok 测试种子
      : Promise.resolve({ skills: h.skills }),
  ),
  skillRawReq: vi.fn(
    (id: string) =>
      new Promise<{ id: string; raw?: string }>((resolve) => {
        h.rawWaiters.push({ id, resolve });
      }),
  ),
}));

import SkillView from "./SkillView";

const textarea = () => screen.getByRole("textbox") as HTMLTextAreaElement;
/** 行内「编辑技能」钮:先按行名圈定 li,再在行内找(两行各有同名钮) */
const editButtonOf = (name: string) => {
  const row = screen.getByText(name).closest("li");
  if (!row) throw new Error(`row ${name} not found`);
  return within(row).getByRole("button", { name: zhCN.skills.edit });
};
const resolveRaw = async (id: string, raw: string) => {
  const w = h.rawWaiters.find((x) => x.id === id);
  if (!w) throw new Error(`no pending raw request for ${id}`);
  await act(async () => {
    w.resolve({ id, raw });
  });
};

afterEach(() => {
  h.rawWaiters.length = 0;
  h.failList = false;
  cleanup();
});

describe("SkillView 编辑器新鲜度守卫(审计 §1.4 回归)", () => {
  it("连点两条技能且先点的后回包:编辑器内容始终属于 editor.id 指向的那条", async () => {
    const user = userEvent.setup();
    render(<SkillView onBack={() => {}} />);
    await screen.findByText("/skill-a");

    // 点 A(请求在途)→ 点 B(A 的回包还没来)
    await user.click(editButtonOf("/skill-a"));
    await screen.findByRole("dialog");
    expect(h.rawWaiters.map((w) => w.id)).toEqual(["a"]);
    await user.click(editButtonOf("/skill-b"));
    expect(h.rawWaiters.map((w) => w.id)).toEqual(["a", "b"]);

    // B 的原文先回:编辑器属于 B,内容必须是 B 的
    await resolveRaw("b", "RAW-B-CONTENT");
    await waitFor(() => expect(textarea()).toHaveValue("RAW-B-CONTENT"));

    // A 的原文迟到:必须被丢弃,编辑器仍是 B 的内容
    await resolveRaw("a", "RAW-A-CONTENT");
    expect(textarea()).toHaveValue("RAW-B-CONTENT");
    expect(screen.getByRole("dialog")).toHaveAttribute(
      "aria-label",
      zhCN.skills.edit,
    );
  });

  it("关闭编辑器后迟到的原文回包不得把内容带回来", async () => {
    const user = userEvent.setup();
    render(<SkillView onBack={() => {}} />);
    await screen.findByText("/skill-a");
    await user.click(editButtonOf("/skill-a"));
    await screen.findByRole("dialog");
    await user.click(screen.getByRole("button", { name: zhCN.skills.cancel }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await resolveRaw("a", "RAW-A-CONTENT");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("SkillView 列表读取失败(REQ-P0-3 回归)", () => {
  it("列表请求 reject → 错误态 + 重试,而非「还没有安装技能」空态;重试成功后列表恢复", async () => {
    const user = userEvent.setup();
    h.failList = true;
    render(<SkillView onBack={() => {}} />);

    expect(await screen.findByText(zhCN.common.loadFailed)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: zhCN.common.retry }),
    ).toBeInTheDocument();
    expect(screen.queryByText(zhCN.skills.empty)).not.toBeInTheDocument();

    // 重试成功 → 错误态退场,列表出现
    h.failList = false;
    await user.click(screen.getByRole("button", { name: zhCN.common.retry }));
    expect(await screen.findByText("/skill-a")).toBeInTheDocument();
    expect(screen.queryByText(zhCN.common.loadFailed)).not.toBeInTheDocument();
  });
});
