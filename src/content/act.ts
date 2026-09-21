// 页面交互·动作侧:合成指针/鼠标事件序列、native setter 写值、回车序列。
// 真实浏览器序列与 composed 穿透等保真要点见各函数注;selector 生成与
// 可见性语义在 observe.ts。

import { buildSelector } from "./observe";

/** 目标元素的中心坐标(须先 scrollIntoView 再取,否则滚动前坐标点错位置)。
 *  behavior 必须显式 instant:默认值会尊重页面 CSS 的 scroll-behavior:smooth,
 *  滚动变成异步动画,紧接着取的 rect 是中间态坐标,遮挡校验全歪 */
function pointOf(el: Element): { x: number; y: number } {
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/**
 * 完整指针/鼠标事件序列。现代框架(React 合成事件、Radix、Floating UI、canvas)把处理器
 * 拆在 PointerEvent 与 MouseEvent 里并读 clientX/Y 做命中测试——只发 el.click() 会漏掉大部分。
 * 真实浏览器序列:mousedown → pointerdown 顺序在各实现有差异,这里按 pointer → mouse 成对发。
 * buttons 掩码:down 阶段=按下位(1),up 阶段=0(拖拽检测库依赖 up 时 buttons===0)。
 * composed:true 穿透 shadow DOM。pointerenter/mouseenter 不冒泡,其余 bubbles:true。
 */
function dispatchPointerSequence(
  el: Element,
  point: { x: number; y: number },
): void {
  const base: MouseEventInit & PointerEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    button: 0,
    buttons: 0,
    detail: 1,
    clientX: point.x,
    clientY: point.y,
  };
  const pDown: PointerEventInit = {
    ...base,
    buttons: 1,
    pressure: 0.5,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    width: 1,
    height: 1,
  };
  const pUp: PointerEventInit = { ...base, buttons: 0, pressure: 0, pointerId: 1, pointerType: "mouse", isPrimary: true, width: 1, height: 1 };
  const mDown: MouseEventInit = { ...base, buttons: 1 };
  const mUp: MouseEventInit = { ...base, buttons: 0 };

  const pointer = typeof PointerEvent !== "undefined";
  if (pointer) el.dispatchEvent(new PointerEvent("pointerover", pUp));
  el.dispatchEvent(new MouseEvent("mouseover", mUp));
  if (pointer) el.dispatchEvent(new PointerEvent("pointerenter", { ...pUp, bubbles: false }));
  el.dispatchEvent(new MouseEvent("mouseenter", { ...mUp, bubbles: false }));

  if (pointer) el.dispatchEvent(new PointerEvent("pointerdown", pDown));
  el.dispatchEvent(new MouseEvent("mousedown", mDown));

  if (pointer) el.dispatchEvent(new PointerEvent("pointerup", pUp));
  el.dispatchEvent(new MouseEvent("mouseup", mUp));
  el.dispatchEvent(new MouseEvent("click", mUp));
}

/** 点击元素:滚动到中心 → 遮挡校验(中心点元素不是目标/后代则抛「被遮罩覆盖」)→ 事件序列。 */
export function clickElement(el: Element): void {
  const point = pointOf(el);
  // 遮挡校验:中心点被遮罩/覆盖时 elementFromPoint 返回别的元素,硬点会点错目标
  const top = document.elementFromPoint(point.x, point.y);
  if (top && top !== el && !el.contains(top)) {
    throw new Error(
      `元素 ${buildSelector(el)} 当前被其它元素(${buildSelector(top)})遮挡,点击会命中错误目标。请先关闭遮罩/浮层,或换一个可见的目标元素。`,
    );
  }
  dispatchPointerSequence(el, point);
}

/** 原生 value setter 写入:绕过 React/Vue 对 value 的拦截,受控组件才能感知。 */
function setNativeValue(
  el: HTMLInputElement | HTMLTextAreaElement,
  text: string,
): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, text);
  else el.value = text; // 兜底:拿不到 setter(极端环境)时退化直接赋值
}

/** 向输入控件写文本。input/textarea → native setter + input/change;select → 按 value/文本选 option;contenteditable → execCommand。 */
export function fillElement(el: Element, text: string): void {
  el.scrollIntoView({ block: "center", inline: "center" });
  (el as HTMLElement).focus();

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    setNativeValue(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }

  if (el instanceof HTMLSelectElement) {
    const option = Array.from(el.options).find(
      (o) => o.value === text || o.text.trim() === text,
    );
    if (!option) {
      throw new Error(
        `下拉框 ${buildSelector(el)} 中没有 value 或文字为 "${text}" 的选项。请用 find_elements 重新确认。`,
      );
    }
    el.value = option.value;
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }

  if (
    el.getAttribute("contenteditable") === "true" ||
    el.getAttribute("contenteditable") === ""
  ) {
    // 富文本标准手法:先全选再插入。execCommand 虽 deprecated,Chrome 仍可用(无等价替代)。
    // execCommand 成功时浏览器自己派发 input 事件(inputType=insertText,React 原生感知),
    // 不能再手动补发 —— 双发会让计数/防抖型监听器行为失真
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    const ok = document.execCommand("insertText", false, text);
    if (!ok) {
      // deprecated 命令可能被拒(极旧实现):退化手动派发,至少让框架感知
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          composed: true,
          inputType: "insertText",
          data: text,
        }),
      );
    }
    return;
  }

  throw new Error(
    `元素 ${buildSelector(el)} 不是可输入控件(input/textarea/select/contenteditable),无法填写。请用 find_elements 重新定位正确的输入框。`,
  );
}

/** 回车按键序列。注意:new KeyboardEvent 构造器不接受 keyCode/which,必须构造后 defineProperty,否则 e.keyCode===13 判不到。 */
export function dispatchEnter(el: Element): void {
  const make = (type: string) => {
    const ev = new KeyboardEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      key: "Enter",
      code: "Enter",
    });
    Object.defineProperty(ev, "keyCode", { value: 13 });
    Object.defineProperty(ev, "which", { value: 13 });
    return ev;
  };
  el.dispatchEvent(make("keydown"));
  el.dispatchEvent(make("keypress")); // 已废弃但部分旧页监听;Enter 各引擎都保留
  el.dispatchEvent(make("keyup"));
}
