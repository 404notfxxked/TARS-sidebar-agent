// 页面交互工具:观察(DOM 语义提取)+ 动作(合成事件)
// 自包含纯 DOM 函数,无 message / chrome 依赖,供 content script 的 runTool 分发调用。
// 设计要点(见计划):
//   - selector 契约:buildSelector 生成绝对 CSS 路径,动作工具 querySelector 解析,无会话态。
//   - 合成事件保真:完整 pointer/mouse 序列 + native setter + keyCode 补全,React 等框架才认。

// ---- 类型 ----

/** 不可见的原因:给模型看的「为什么点不到」,直接映射下一步行动 */
type VisibilityReason =
  | "display-none" // 不在布局里(自身 display:none)—— 去触发显示它的父 UI
  | "opacity-zero" // 自身 opacity:0,开发者意图隐藏(状态控制)
  | "transparent" // opacity 在 (0, 0.1],可能是动画中间帧
  | "pointer-events-none" // 看得见但点不到(click-through)
  | "zero-size" // 无渲染盒 / 零尺寸
  | "ancestor-hidden"; // 自身正常,祖先 display:none / opacity:0

/** 归一化后的元素类型闭集(超出归 null,不给模型无谓噪音) */
export type RoleName =
  | "button"
  | "link"
  | "input"
  | "checkbox"
  | "radio"
  | "switch"
  | "select"
  | "textarea"
  | "contenteditable";

interface VisibilityInfo {
  visible: boolean;
  hidden?: VisibilityReason;
}

interface ElementState {
  disabled?: boolean;
  checked?: boolean;
  selected?: boolean;
  pressed?: boolean;
  expanded?: boolean;
  focused?: boolean;
}

interface ElementSnapshot {
  selector: string;
  tag: string;
  role: RoleName | null;
  label: string | null;
  /** 当前值(input/textarea/select 的 value,截断);对其它元素省略,省 token */
  value?: string;
  state: ElementState;
  visible: boolean;
  hidden?: VisibilityReason;
}

export interface FindOptions {
  /** 按 label/value/textContent 做大小写不敏感子串匹配 */
  text?: string;
  role?: RoleName;
  limit?: number;
}

export interface FindResult {
  /** 过滤后匹配总数(截断前);truncated 时模型据此收窄查询 */
  count: number;
  returned: number;
  truncated: boolean;
  elements: ElementSnapshot[];
}

// ---- 常量 ----

/** 可交互元素集合:标签 + ARIA role + contenteditable + 裸 onclick */
const INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  "input",
  "select",
  "textarea",
  "summary",
  "[contenteditable='true']",
  "[contenteditable='']",
  "[role='button']",
  "[role='link']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='switch']",
  "[role='menuitem']",
  "[role='tab']",
  "[role='option']",
  "[onclick]",
].join(",");

// 文本截断预算(每字段):label 与 value 是模型最常看的信息,但长文本无益
const LABEL_MAX = 120;
const VALUE_MAX = 80;

// ---- 观察:语义提取 ----

/** 生成绝对 CSS 路径:nth-of-type 链,遇合法 id 短路。与 CSS :nth-of-type 语义严格一致(只数同标签兄弟)。 */
function buildSelector(el: Element): string {
  // 合法 id:排除 React 动态 id(`:r1:`)、含空格/引号等不可用 CSS.escape 也无益的 id
  const ID_RE = /^[A-Za-z_][\w-]*$/;
  const path: string[] = [];
  let node: Element | null = el;
  while (node && node !== document.documentElement && node !== document.body) {
    const id = node.id;
    if (id && ID_RE.test(id)) {
      path.unshift(`#${id}`);
      break;
    }
    let seg = node.tagName.toLowerCase();
    const parent: HTMLElement | null = node.parentElement;
    if (parent) {
      // cur 捕获当前非空 node:闭包里直接用 let 变量会丢失 TS 收窄
      const cur = node;
      // :nth-of-type 只数「同 tagName 的兄弟」,须显式 filter,勿用 :nth-child 语义
      const sibs = Array.from(parent.children).filter(
        (s) => s.tagName === cur.tagName,
      );
      if (sibs.length > 1) {
        seg += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
      }
    }
    path.unshift(seg);
    node = parent;
  }
  if (node === document.body) path.unshift("body");
  else if (node === document.documentElement) path.unshift("html");
  return path.join(" > ");
}

// role 别名表:把页面常见的冗余 role 归一到闭集,减少模型要处理的枚举
const ROLE_ALIAS: Record<string, RoleName> = {
  button: "button",
  link: "link",
  textbox: "input",
  searchbox: "input",
  combobox: "select",
  listbox: "select",
  slider: "input",
  spinbutton: "input",
  checkbox: "checkbox",
  radio: "radio",
  switch: "switch",
  menuitem: "button",
  menuitemcheckbox: "checkbox",
  menuitemradio: "radio",
  tab: "button",
  option: "select",
  textarea: "textarea",
};

/** 参数字符串 → RoleName 闭集(用于 find_elements 的 role 过滤参数校验)。无效返回 null。 */
export function normalizeRole(raw: string): RoleName | null {
  return ROLE_ALIAS[raw.toLowerCase()] ?? null;
}

/** 归一化角色:显式 role 属性优先(经别名表),无则按 tag+type 推导 */
function getRole(el: Element): RoleName | null {
  const explicit = el.getAttribute("role");
  if (explicit) return normalizeRole(explicit);

  const tag = el.tagName.toLowerCase();
  if (tag === "button") return "button";
  if (tag === "a" && el.hasAttribute("href")) return "link";
  if (tag === "input") {
    const type = (el as HTMLInputElement).type;
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "button" || type === "submit" || type === "reset") return "button";
    return "input";
  }
  if (tag === "select") return "select";
  if (tag === "textarea") return "textarea";
  if (
    el.getAttribute("contenteditable") === "true" ||
    el.getAttribute("contenteditable") === ""
  ) {
    return "contenteditable";
  }
  return null;
}

/** 可访问标签:aria-label → aria-labelledby → <label for> → button 类 input 的 value/alt → 自身文本。截 120。 */
function getLabel(el: Element): string | null {
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) return ariaLabel.trim().slice(0, LABEL_MAX);

  const labelledby = el.getAttribute("aria-labelledby");
  if (labelledby) {
    const parts = labelledby
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim())
      .filter(Boolean);
    if (parts.length) return parts.join(" ").slice(0, LABEL_MAX);
  }

  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  ) {
    // el.labels 覆盖 <label for> 和包裹 <label>(select 的 option 文字会混入,跳过 label 文本)
    if (!(el instanceof HTMLSelectElement) && el.labels?.length) {
      const t = Array.from(el.labels)
        .map((l) => l.textContent?.trim())
        .filter(Boolean)
        .join(" ");
      if (t) return t.slice(0, LABEL_MAX);
    }
    if (el instanceof HTMLInputElement) {
      if (el.type === "button" || el.type === "submit" || el.type === "reset") {
        if (el.value) return el.value.slice(0, LABEL_MAX);
      }
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (el.placeholder) return el.placeholder.trim().slice(0, LABEL_MAX);
    }
  }

  const alt = el.getAttribute("alt");
  if (alt) return alt.trim().slice(0, LABEL_MAX);

  const tag = el.tagName.toLowerCase();
  if (tag === "button" || tag === "a" || el.getAttribute("role") === "button") {
    const t = (el.textContent ?? "").trim();
    if (t) return t.slice(0, LABEL_MAX);
  }
  return null;
}

/** 交互状态:disabled 恒返回(可用/不可用是关键决策信息);checked 等仅 true 或 aria 显式 false 时返回。缺省 key 不序列化,省 token。 */
function getState(el: Element): ElementState {
  const state: ElementState = {};
  const tag = el.tagName.toLowerCase();

  const isFormControl = ["button", "input", "select", "textarea"].includes(tag);
  if (isFormControl) {
    const disabled =
      (el as HTMLInputElement).disabled ||
      el.getAttribute("aria-disabled") === "true";
    state.disabled = !!disabled;
  }

  if (el instanceof HTMLInputElement) {
    if (el.checked) state.checked = true;
  }
  if (el instanceof HTMLOptionElement && el.selected) {
    state.selected = true;
  }
  // aria 显式 false 也返回:模型需要区分「没设置」和「明确为否」
  if (el.getAttribute("aria-selected") === "false") state.selected = false;
  if (el.getAttribute("aria-checked") === "true") state.checked = true;
  else if (el.getAttribute("aria-checked") === "mixed") state.checked = true;
  else if (el.getAttribute("aria-checked") === "false") state.checked = false;
  if (el.getAttribute("aria-pressed") === "true") state.pressed = true;
  else if (el.getAttribute("aria-pressed") === "false") state.pressed = false;
  if (el.getAttribute("aria-expanded") === "true") state.expanded = true;
  else if (el.getAttribute("aria-expanded") === "false") state.expanded = false;
  if (el === document.activeElement) state.focused = true;

  return state;
}

/** 可见性分析:visible=false 语义 = 「不可被 click/fill 命中」,hidden 给出原因供模型决策。 */
function getVisibility(el: Element): VisibilityInfo {
  // getClientRects().length===0 是「当前无渲染盒」的最可靠判据(覆盖自身/祖先 display:none、visibility:hidden)
  if (el.getClientRects().length === 0) {
    // 逐级查具体原因,回填精确的 hidden
    let cur: Element | null = el;
    while (cur) {
      const cs = getComputedStyle(cur);
      if (cs.display === "none" || cs.visibility === "hidden") {
        const reason: VisibilityReason =
          cur === el ? "display-none" : "ancestor-hidden";
        return { visible: false, hidden: reason };
      }
      if (parseFloat(cs.opacity) === 0) {
        const reason: VisibilityReason =
          cur === el ? "opacity-zero" : "ancestor-hidden";
        return { visible: false, hidden: reason };
      }
      cur = cur.parentElement;
    }
    return { visible: false, hidden: "zero-size" };
  }

  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return { visible: false, hidden: "zero-size" };
  }

  const cs = getComputedStyle(el);
  if (cs.pointerEvents === "none") {
    return { visible: false, hidden: "pointer-events-none" };
  }
  const op = parseFloat(cs.opacity);
  if (op === 0) return { visible: false, hidden: "opacity-zero" };
  if (op > 0 && op <= 0.1) return { visible: false, hidden: "transparent" };

  return { visible: true };
}

/** 单元素快照:组合上述语义。label/value 截断,state 缺省 key 不出现。 */
function snapshotElement(el: Element): ElementSnapshot {
  const out: ElementSnapshot = {
    selector: buildSelector(el),
    tag: el.tagName.toLowerCase(),
    role: getRole(el),
    label: getLabel(el),
    state: getState(el),
    visible: true,
  };

  const vis = getVisibility(el);
  out.visible = vis.visible;
  if (vis.hidden) out.hidden = vis.hidden;

  // 表单值:仅输入类才有,截断
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const v = el.value ?? "";
    if (v) out.value = v.slice(0, VALUE_MAX);
  } else if (el instanceof HTMLSelectElement) {
    const v = el.value ?? "";
    if (v) out.value = v.slice(0, VALUE_MAX);
  }

  return out;
}

// ---- 观察:查找 ----

/**
 * 查找可交互元素。
 * 默认跳过「无盒」元素(display-none/ancestor-hidden/zero-size —— 点不到,不浪费模型 token);
 * 保留 pointer-events-none/opacity-zero/transparent(「看着在但点不到」是给模型的信号)。
 */
export function findInteractive(
  root: ParentNode,
  opts: FindOptions = {},
): FindResult {
  const { text, role, limit = 20 } = opts;
  const cappedLimit = Math.max(1, Math.min(limit, 50)); // 硬上限 50,防爆 token
  const needle = text?.toLowerCase();

  const matches: ElementSnapshot[] = [];
  const seen = new Set<Element>(); // 去重:同元素可能命中多个 selector([role] 与 [onclick] 重叠)

  root.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR).forEach((el) => {
    if (seen.has(el)) return;
    if (role && getRole(el) !== role) return;
    if (needle) {
      const label = getLabel(el)?.toLowerCase() ?? "";
      const value = el instanceof HTMLInputElement ? (el.value ?? "").toLowerCase() : "";
      const txt = (el.textContent ?? "").toLowerCase();
      if (!label.includes(needle) && !value.includes(needle) && !txt.includes(needle)) {
        return;
      }
    }
    const snap = snapshotElement(el);
    if (
      snap.visible === false &&
      (snap.hidden === "display-none" ||
        snap.hidden === "ancestor-hidden" ||
        snap.hidden === "zero-size")
    ) {
      return; // 无盒,跳过
    }
    seen.add(el);
    matches.push(snap);
  });

  const total = matches.length;
  const elements = matches.slice(0, cappedLimit);
  return {
    count: total,
    returned: elements.length,
    truncated: total > elements.length,
    elements,
  };
}

// ---- 动作:合成事件 ----

/** 目标元素的中心坐标(须先 scrollIntoView 再取,否则滚动前坐标点错位置) */
function pointOf(el: Element): { x: number; y: number } {
  el.scrollIntoView({ block: "center", inline: "center" });
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
    // 富文本标准手法:先全选再插入。execCommand 虽 deprecated,Chrome 仍可用(无等价替代)
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    document.execCommand("insertText", false, text);
    el.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: "insertText",
        data: text,
      }),
    );
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

// ---- 滚动 ----

export type ScrollDirection = "up" | "down" | "top" | "bottom";

export interface ScrollOptions {
  direction?: ScrollDirection;
  /** 滚动量,视口高的倍数(默认 1,上限 10) */
  pages?: number;
  /** 给定 selector:滚到该元素进视口(direction 被忽略) */
  selector?: string;
}

/** 页面几何:滚动原语的返回,也是 find_elements 的观察字段 ——
 *  模型据此判断「下面还有没有内容」「截图拍到的是哪一段」 */
export interface PageGeometry {
  scroll_y: number;
  scroll_height: number;
  viewport_height: number;
  at_bottom: boolean;
}

export function pageGeometry(): PageGeometry {
  const doc = document.documentElement;
  const scrollY = Math.round(window.scrollY);
  const scrollHeight = Math.max(doc?.scrollHeight ?? 0, document.body?.scrollHeight ?? 0);
  const viewportHeight = window.innerHeight;
  return {
    scroll_y: scrollY,
    scroll_height: scrollHeight,
    viewport_height: viewportHeight,
    at_bottom: scrollY + viewportHeight >= scrollHeight - 2,
  };
}

/**
 * 滚动。无 selector:window 按视口倍数滚(direction=up/down,top/bottom 跳转);
 * 有 selector:该元素滚入视口中心(scrollIntoView 原生处理内滚容器)。
 * 程序化滚动同步生效,返回时读到的就是落点几何。滚动监听器对程序化滚动
 * 照常触发,惰性加载能被正确喂到。
 */
export function scrollPage(opts: ScrollOptions = {}): PageGeometry {
  if (opts.selector) {
    const el = document.querySelector(opts.selector);
    if (!el) {
      throw new Error(
        `元素未找到:${opts.selector}。请用 find_elements 重新定位后再滚动到它。`,
      );
    }
    el.scrollIntoView({ block: "center", inline: "center" });
    return pageGeometry();
  }
  const dir: ScrollDirection = opts.direction ?? "down";
  const pages = Math.max(1, Math.min(opts.pages ?? 1, 10));
  const vh = window.innerHeight;
  if (dir === "top") {
    window.scrollTo(0, 0);
  } else if (dir === "bottom") {
    window.scrollTo(0, document.documentElement.scrollHeight);
  } else {
    window.scrollBy(0, (dir === "down" ? 1 : -1) * pages * vh);
  }
  return pageGeometry();
}
