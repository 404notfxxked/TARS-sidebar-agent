// 信息提示(ⓘ):label 旁的小图标,悬停或键盘聚焦时弹出说明气泡,点击供
// 触屏切换。只装「查一次就懂」的定义类短说明;机制/隐私类长说明走
// settings/parts 的 HintMore 折叠,警示类保持明面可见 —— 三层分工见 roadmap。

import { useId, useState } from "react";
import { useT } from "./hooks";

export default function InfoTip({ text }: { text: string }) {
  const t = useT();
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <span className="info-tip">
      <button
        type="button"
        className={`info-tip-btn ${open ? "open" : ""}`}
        aria-label={t("common.moreInfo")}
        aria-describedby={id}
        onClick={() => setOpen((v) => !v)}
        onBlur={() => setOpen(false)}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          aria-hidden="true"
          className="block"
        >
          <circle cx="8" cy="8" r="6.4" />
          <path d="M8 7.2v3.6" />
          <path d="M8 5.1h.01" />
        </svg>
      </button>
      <span role="tooltip" id={id} className="info-tip-pop">
        {text}
      </span>
    </span>
  );
}
