// set-of-marks 视觉标记层:给视口内的可交互元素画「编号框」,供视觉模型
// 看图定位。设计边界:
// - 标记是纯视觉层(容器 pointer-events:none),不挡真实点击、不留副作用,
//   捕获后必须 clearMarks 摘除;
// - 元素枚举/可见性过滤/selector 构造全部复用 interact 的 findInteractive,
//   保证「图上的号」与 find_elements 的selector 语义一致;
// - 只画视口内(getBoundingClientRect 与视口相交)——截图就是当前视口,
//   视口外的标记是噪音。

import { findInteractive } from "./interact";

const ROOT_ID = "__tars_som_root__";
const MARK_COLOR = "#e0245e";
const MAX_MARKS = 30;

export interface ScreenshotMark {
  n: number;
  selector: string;
  tag: string;
  role: string | null;
  label: string | null;
}

/** 给视口内的可交互元素画编号标记,返回「号 → 元素」映射表。
 *  幂等:先清掉旧标记再画,重复调用不留叠影 */
export function drawMarks(): ScreenshotMark[] {
  clearMarks();
  const { elements } = findInteractive(document, { limit: MAX_MARKS });
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
  document.documentElement.appendChild(root);

  const marks: ScreenshotMark[] = [];
  for (const el of elements) {
    if (!el.visible) continue;
    const node = document.querySelector(el.selector);
    if (!node) continue;
    const r = node.getBoundingClientRect();
    // 与视口不相交的跳过(截图拍不到,标记只会误导)
    if (r.width <= 2 || r.height <= 2) continue;
    if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) continue;

    const n = marks.length + 1;
    const box = document.createElement("div");
    box.style.cssText =
      `position:fixed;left:${r.left - 2}px;top:${r.top - 2}px;` +
      `width:${r.width + 4}px;height:${r.height + 4}px;` +
      `border:2px solid ${MARK_COLOR};border-radius:3px;`;
    const badge = document.createElement("div");
    badge.textContent = String(n);
    badge.style.cssText =
      `position:fixed;left:${Math.max(0, r.left - 2)}px;top:${Math.max(0, r.top - 2)}px;` +
      `background:${MARK_COLOR};color:#fff;font:bold 11px/14px system-ui,sans-serif;` +
      `padding:0 5px;border-radius:7px;`;
    root.append(box, badge);
    marks.push({
      n,
      selector: el.selector,
      tag: el.tag,
      role: el.role,
      label: el.label,
    });
  }
  return marks;
}

/** 摘除标记层(捕获后调用;幂等) */
export function clearMarks(): { cleared: true } {
  document.getElementById(ROOT_ID)?.remove();
  return { cleared: true };
}
