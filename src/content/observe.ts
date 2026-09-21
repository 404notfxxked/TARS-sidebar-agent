// 页面交互·观察侧:DOM 语义提取(角色/标签/状态/可见性)与可交互元素查找。
// 自包含纯 DOM 函数,无 message / chrome 依赖;动作侧见 act.ts(经 barrel
// interact.ts 暴露)。selector 契约:buildSelector 生成绝对 CSS 路径,动作
// 工具 querySelector 解析,无会话态。

// ---- 类型 ----

/** 不可见的原因:给模型看的「为什么点不到」,直接映射下一步行动 */
type VisibilityReason =
  | "display-none" // 不在布局里(自身 display:none)—— 去触发显示它的父 UI
  | "visibility-hidden" // 自身 visibility:hidden(占布局但不可见,须显式显现)
  | "opacity-zero" // 自身 opacity:0,开发者意图隐藏(状态控制)
  | "transparent" // opacity 在 (0, 0.1],可能是动画中间帧
  | "pointer-events-none" // 看得见但点不到(click-through)
  | "zero-size" // 无渲染盒 / 零尺寸
  | "ancestor-hidden"; // 自身正常,祖先 display:none / visibility:hidden / opacity:0

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
export function buildSelector(el: Element): string {
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

// role 归一表:页面冗余 role 属性归一到闭集,同时是 find_elements 的
// role 过滤参数校验表——模型会回显结果字段里的 role 值来查询,所以闭集
// 本身必须逐值可直行(下面前 9 行),ARIA 别名只是额外便利;否则就会出现
// 「报错说支持 input、传 input 却被拒」的自相矛盾(2026-09-17 真机踩中)
const ROLE_ALIAS: Record<string, RoleName> = {
  button: "button",
  link: "link",
  input: "input",
  checkbox: "checkbox",
  radio: "radio",
  switch: "switch",
  select: "select",
  textarea: "textarea",
  contenteditable: "contenteditable",
  textbox: "input",
  searchbox: "input",
  combobox: "select",
  listbox: "select",
  slider: "input",
  spinbutton: "input",
  menuitem: "button",
  menuitemcheckbox: "checkbox",
  menuitemradio: "radio",
  tab: "button",
  option: "select",
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

  // visibility:hidden 不脱布局,元素仍有渲染盒 —— 有盒路径必须补查 visibility,
  // 否则 find_elements 误报可见、click 在错误坐标报遮挡。
  // 只查自身:visibility 是继承属性,computed style 里已是继承后的结果,祖先链
  // 只是多走一遍 style 计算;而且它会把「祖先 hidden + 自身 visibility:visible」
  // 的合法写法误判成不可见(实测该子元素 computed 为 visible、elementFromPoint
  // 命中它、click 正常派发),findInteractive 恰会丢弃 ancestor-hidden 一类
  const cs = getComputedStyle(el);
  if (cs.visibility === "hidden") {
    return { visible: false, hidden: "visibility-hidden" };
  }
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
