// 跨视图复用的图标。视图私有的图标留在各自文件里,别为「可能复用」上移。

/** 垃圾桶(删除动作):记忆行/会话行同款 */
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
