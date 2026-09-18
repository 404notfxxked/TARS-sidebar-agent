// 会话来源域白名单推导(纯函数层):web_fetch 的确认门用它区分「本会话的
// 合法研究线索」与「凭空出现的外带目标」。只认三类可信来源,全部从已落盘
// 的会话历史推导 —— 零新存储、SW 被杀不丢(历史即真相)、不碰虚拟上下文
// 不变式(读的是落盘全量,不是裁剪后的 prompt 投影):
//   1. 用户消息 <user-request> 内显式敲的 http(s) URL(用户是授权主体);
//   2. web_search 结果里的 URL(搜索是合法研究通道);
//   3. 本会话已成功执行的 web_fetch 结果里的最终 URL(它执行过 = 白名单
//      放行或用户批准过;被拒绝/失败的工具没有结果 JSON,天然不入集)。
// 刻意不做的:page_read 等页面内容里的 URL 永不提取 —— 页面文本不可信,
// 恶意页在正文里塞一个链接就能把自己洗白进白名单(评审 S4);用户消息里
// 裸写的域名(无 scheme)不提取 —— 正则噪声大,代价是首抓弹一次卡。
// domain 键经 hostKey 归一(lowercase / 去 www. 前缀)。

import type { InternalMsg } from "../provider/types";
import { allowlistDomainOf } from "./outboundGuard";

const USER_REQUEST_RE = /<user-request>([\s\S]*?)<\/user-request>/;
// URL 截断:吃掉空白与常见包裹符号;结尾标点不算 URL 的一部分
const URL_RE = /https?:\/\/[^\s<>"'）)\]}。，、；！？]+/gi;

/** 从会话历史推导 web_fetch 来源域白名单(键 = hostKey 归一后的域名)。
 *  currentUserText:本轮用户输入原文(此刻尚未落盘,历史里还没有它 ——
 *  由调用方显式传入,否则「消息里给了链接的当轮抓取」会误弹卡) */
export function deriveFetchAllowlist(
  history: InternalMsg[],
  currentUserText = "",
): Set<string> {
  const allow = new Set<string>();
  // tool 消息只带 toolCallId:先建 id → 工具名索引,才知道哪条 tool 消息
  // 是搜索结果 / 抓取结果。页面读取结果(page_*)因此被天然排除
  const toolNameById = new Map<string, string>();
  const addFrom = (text: string) => {
    for (const u of text.matchAll(URL_RE)) {
      const d = allowlistDomainOf(u[0]);
      if (d) allow.add(d);
    }
  };
  addFrom(currentUserText);
  for (const m of history) {
    if (m.role === "user") {
      const inner = m.content.match(USER_REQUEST_RE)?.[1];
      // 无包裹 = 伪消息(记忆投影/压缩摘要/截图注记),整体跳过
      if (!inner) continue;
      addFrom(inner);
    } else if (m.role === "assistant") {
      for (const tc of m.toolCalls ?? []) {
        toolNameById.set(tc.id, tc.name);
      }
    } else if (m.role === "tool") {
      const name = toolNameById.get(m.toolCallId);
      if (name !== "web_search" && name !== "web_fetch") continue;
      // 结果被预算截断打过桩 / 坏 JSON 时整条放弃:白名单缺一个域的代价
      // 只是下次多弹一张卡,不能为省卡引入误放行
      try {
        const parsed = JSON.parse(m.content) as {
          url?: unknown;
          results?: { url?: unknown }[];
        };
        if (name === "web_search") {
          for (const r of parsed.results ?? []) {
            if (typeof r?.url === "string") {
              const d = allowlistDomainOf(r.url);
              if (d) allow.add(d);
            }
          }
        } else if (typeof parsed.url === "string") {
          const d = allowlistDomainOf(parsed.url);
          if (d) allow.add(d);
        }
      } catch {
        /* 不可解析的旧结果,跳过 */
      }
    }
  }
  return allow;
}
