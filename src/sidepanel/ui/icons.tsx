// 跨视图复用的图标。收拢自各视图的本地副本(ChatView/trace/bubbles/
// ConfirmCard/MemoryView);新图标有第二使用方时才进这里,单视图私有的
// 仍留在视图文件(如 trace 的 MarkOk/MarkError 带轨迹域样式钩子)。

/** 垃圾桶(删除动作):记忆行/会话行同款 */
export function GlobeIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="block"
    >
      <circle cx="8" cy="8" r="6.3" />
      <path d="M1.7 8h12.6" />
      <ellipse cx="8" cy="8" rx="3.1" ry="6.3" />
    </svg>
  );
}

export function PencilIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="block"
    >
      <path d="M11.1 2.6a1.7 1.7 0 0 1 2.4 2.4l-7.6 7.6-3.2.8.8-3.2 7.6-7.6Z" />
    </svg>
  );
}

export function TrashIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="block"
    >
      <path d="M2.5 4h11M6.5 2h3M4 4l.7 9a1.5 1.5 0 0 0 1.5 1.3h3.6a1.5 1.5 0 0 0 1.5-1.3L12 4M6.5 7v4M9.5 7v4" />
    </svg>
  );
}

/** 归档盒:压缩分隔条与「已写入 N 条记忆」轻提示共用 */
export function ArchiveIcon() {
  return (
    <svg
      className="inline-block align-[-2px]"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="3" width="20" height="5" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
      <path d="M10 12h4" />
    </svg>
  );
}

/** 复制(双层方片) */
export function CopyIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="block"
    >
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 3.5H4A1.5 1.5 0 0 0 2.5 5v6.5" />
    </svg>
  );
}

/** 对勾(复制成功反馈) */
export function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="block"
    >
      <path d="m3 8.5 3.2 3L13 4.5" />
    </svg>
  );
}

/** 循环双箭头(重新生成/换一批,rotate 语义) */
export function RefreshIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="block"
    >
      <path d="M12.5 2.5v3h-3" />
      <path d="M3.2 6.2a5 5 0 0 1 8.6-0.4l0.7 0.9" />
      <path d="M3.5 13.5v-3h3" />
      <path d="M12.8 9.8a5 5 0 0 1-8.6 0.4l-0.7-0.9" />
    </svg>
  );
}

/** TARS 品牌标(源:public/icons/icon.svg 的黑白分段气泡):
 *  底板换 primary-container、气泡换 on-primary-container,分段镂空露底板色,
 *  跟随重点色。空态等大面积品牌位用 */
export function LogoMark({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 128 128" aria-hidden="true">
      <rect
        width="128"
        height="128"
        rx="28"
        fill="var(--md-sys-color-primary-container)"
      />
      <path
        d="M42 28h44a18 18 0 0 1 18 18v36a18 18 0 0 1-18 18H62L42 104V82a18 18 0 0 1-18-18V46a18 18 0 0 1 18-18Z"
        fill="var(--md-sys-color-on-primary-container)"
      />
      <g fill="var(--md-sys-color-primary-container)">
        <rect x="36" y="44" width="10" height="26" rx="5" />
        <rect x="52" y="44" width="10" height="26" rx="5" />
        <rect x="68" y="44" width="10" height="26" rx="5" />
        <rect x="84" y="44" width="10" height="26" rx="5" />
      </g>
    </svg>
  );
}

// ---- 以下收拢自 ChatView ----

export function PlusIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <line x1="8" y1="3" x2="8" y2="13" />
      <line x1="3" y1="8" x2="13" y2="8" />
    </svg>
  );
}

/** 发送箭头(填充圆底上光学居中:杆长略短于几何高) */
export function ArrowUpIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 13V3.8" />
      <path d="m3.9 7.9 4.1-4.1 4.1 4.1" />
    </svg>
  );
}

/** 停止方砖(运行中):36px 圆底上取 13px,太小没有「可点停」的存在感 */
export function StopIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 10 10"
      fill="currentColor"
      aria-hidden="true"
    >
      <rect x="1.5" y="1.5" width="7" height="7" rx="1.2" />
    </svg>
  );
}

export function HistoryIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="5.8" />
      <path d="M8 4.8V8l2.3 1.6" />
    </svg>
  );
}

export function SettingsIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      aria-hidden="true"
    >
      <line x1="2.5" y1="4" x2="13.5" y2="4" />
      <circle cx="6" cy="4" r="1.7" fill="currentColor" stroke="none" />
      <line x1="2.5" y1="8" x2="13.5" y2="8" />
      <circle cx="10.5" cy="8" r="1.7" fill="currentColor" stroke="none" />
      <line x1="2.5" y1="12" x2="13.5" y2="12" />
      <circle cx="5" cy="12" r="1.7" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function ImageIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="2.5" width="12" height="11" rx="2" />
      <circle cx="5.8" cy="6.3" r="1.2" />
      <path d="m2.5 11.5 3-3 2.5 2.5 2-2 3.5 3.5" />
    </svg>
  );
}

/** 回到最新:实心下箭头(滚回列表底部) */
export function ArrowDownIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 2.8v10.4" />
      <path d="m3.6 9 4.4 4.2L12.4 9" />
    </svg>
  );
}

// ---- 以下收拢自 trace ----

/** 四角星(SF Symbols sparkle 风):思考过程的图标 */
export function SparkleIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 2.75C8.6 5.4 10.6 7.4 13.25 8 10.6 8.6 8.6 10.6 8 13.25 7.4 10.6 5.4 8.6 2.75 8 5.4 7.4 7.4 5.4 8 2.75Z" />
    </svg>
  );
}

/** 三横线(文本段):中间文案行的图标 */
export function LinesIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 4.5h10M3 8h10M3 11.5h6.5" />
    </svg>
  );
}

/** 折叠指示箭头:单个 SVG,开合沿同一路径旋转(CSS 接管 transform) */
export function ChevronIcon() {
  return (
    <svg
      className="trace-chevron"
      width="10"
      height="10"
      viewBox="0 0 12 12"
      aria-hidden="true"
    >
      <path d="M4.5 2.75 8.25 6 4.5 9.25" />
    </svg>
  );
}

// ---- 以下收拢自 bubbles / ConfirmCard / MemoryView ----

/** 信息圆标(系统提示条) */
export function InfoIcon() {
  return (
    <svg
      className="mt-0.5 shrink-0"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 7.5v3.2" />
      <path d="M8 5h.01" />
    </svg>
  );
}

/** 警示三角(错误消息) */
export function WarnIcon() {
  return (
    <svg
      className="mt-0.5 shrink-0"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 2.2 14.6 13.4H1.4L8 2.2Z" />
      <path d="M8 6.4v3" />
      <path d="M8 11.7h.01" />
    </svg>
  );
}

export function ConfirmIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      <path d="M8 1.8 13.5 4v4.2c0 3.1-2.3 5.3-5.5 6.2-3.2-.9-5.5-3.1-5.5-6.2V4L8 1.8Z" />
      <path d="m5.6 8 1.7 1.7 3.1-3.3" strokeLinecap="round" />
    </svg>
  );
}

export function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
      aria-hidden="true"
      className="block"
    >
      <path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.2L8 11.5l-3.8 2 .7-4.2-3.1-3 4.3-.6L8 1.8z" />
    </svg>
  );
}
