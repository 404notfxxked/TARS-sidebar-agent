// @vitest-environment jsdom
// MemoryView 列表新鲜度守卫回归(审计 §1.4):MEM_* 写动作的回包是
// 「全量列表快照」,两个在途写请求的回包乱序时,迟到的旧快照若仍整体
// 替换列表,会让置顶/删除/新增互相回滚(已删的行复活、新加的行消失)。
// 守卫语义(硬规则 10,同 useAgentChannel 的 actionSeq):每次请求取
// 递增序号,回包时序号过期即丢弃;乐观本地变更同样递增作废在途请求。

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { zhCN } from "../../shared/i18n/locales/zh-CN";
import type { MemoryItem } from "../../shared/messages";

const h = vi.hoisted(() => ({
  // memReq 请求在此排队(带原始 msg 便于按操作类型回包),由用例控制顺序
  waiters: [] as { msg: Record<string, unknown>; resolve: (r: unknown) => void }[],
}));

vi.mock("../clients/memoryClient", () => ({
  memReq: vi.fn(
    (msg: Record<string, unknown>) =>
      new Promise((resolve) => {
        h.waiters.push({ msg, resolve });
      }),
  ),
}));

import MemoryView from "./MemoryView";

const item = (id: string, text: string, pinned = false): MemoryItem => ({
  id,
  text,
  createdAt: 1,
  updatedAt: 1,
  pinned,
  source: "user",
});

const memByType = (type: string) => h.waiters.find((w) => w.msg.type === type);
const pinButton = () => screen.getByRole("button", { name: zhCN.memory.pin });

afterEach(() => {
  h.waiters.length = 0;
  cleanup();
});

describe("MemoryView 列表新鲜度守卫(审计 §1.4 回归)", () => {
  it("两个在途写请求回包乱序:迟到的旧快照不得覆盖更新的列表", async () => {
    const user = userEvent.setup();
    render(<MemoryView onBack={() => {}} />);

    // 首屏 MEM_LIST 在途 → 回:1 条未置顶记忆
    const listReq = memByType("mem_list");
    expect(listReq).toBeTruthy();
    await act(async () => {
      listReq!.resolve({ memories: [item("m1", "旧记忆")] });
    });
    await screen.findByText("旧记忆");

    // 动作 1:置顶 m1(在途)
    await user.click(pinButton());
    // 动作 2:新增一条(在途)
    await user.type(screen.getByLabelText(zhCN.memory.add), "新记忆");
    await user.click(screen.getByRole("button", { name: zhCN.memory.addBtn }));

    // 动作 2 的回包先到:置顶 + 新增都在
    await act(async () => {
      memByType("mem_add")!.resolve({
        memories: [item("m1", "旧记忆", true), item("m2", "新记忆")],
      });
    });
    await screen.findByText("新记忆");

    // 动作 1 的回包(旧快照,无新行、未置顶)迟到:必须整体丢弃,
    // 否则新行消失、置顶被回滚
    await act(async () => {
      memByType("mem_pin")!.resolve({ memories: [item("m1", "旧记忆")] });
    });
    expect(screen.getByText("新记忆")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: zhCN.memory.unpin }),
    ).toBeInTheDocument();
  });
});
