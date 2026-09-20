// 近底跟随:流式新内容只在用户本就位于底部附近时才拽底;上翻回看即暂停
// (scroll 事件解除 pinned),滚回底部自动恢复跟随。展开收起思考行/工具行
// 不再经过 runSegs,不会触发这里。atBottom 是同阈值的渲染态:离开底部时
// 展示「回到最新」悬浮钮。

import { useEffect, useRef, useState, type RefObject } from "react";
import type { ChatMsg } from "./useAgentChannel";
import type { RunSegment } from "./useRunSegments";

interface FollowDeps {
  messages: ChatMsg[];
  runSegs: RunSegment[];
  status: string;
}

export function useAutoScroll(
  listRef: RefObject<HTMLDivElement | null>,
  follow: FollowDeps,
) {
  const { messages, runSegs, status } = follow;
  const pinnedRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  // 「回到最新」点击后的跟随意图:平滑滚动途中内容继续增长时,平滑重定标到
  // 新底而不是停在点击时刻的旧底;到底即清,用户主动上滚(scrollTop 回退)也清
  const followIntentRef = useRef(0);
  const lastTopRef = useRef(0);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onScroll = () => {
      const near = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      if (el.scrollTop < lastTopRef.current) followIntentRef.current = 0;
      lastTopRef.current = el.scrollTop;
      if (near) followIntentRef.current = 0;
      pinnedRef.current =
        near || Date.now() - followIntentRef.current < 2000;
      setAtBottom(near);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [listRef]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 随内容增长重跑,实现近底跟随
  useEffect(() => {
    const el = listRef.current;
    if (!el || !pinnedRef.current) return;
    // 跟随意图窗口内(刚点过「回到最新」)平滑重定标,日常流式仍直接贴底
    if (Date.now() - followIntentRef.current < 2000) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, runSegs, status]);

  // 「回到最新」:平滑滚回底部,滚动途中内容增长由跟随意图接手
  const scrollToLatest = () => {
    const el = listRef.current;
    if (!el) return;
    followIntentRef.current = Date.now();
    pinnedRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  return { atBottom, scrollToLatest };
}
