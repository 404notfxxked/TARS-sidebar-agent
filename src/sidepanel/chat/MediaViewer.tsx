// 媒体放大查看器:图表(mermaid SVG)与图片的面板内全屏查看。侧栏不支持
// 原生 Fullscreen API,这个覆盖层是「放大看」的主通道;真全屏走「新标签页
// 打开」。交互:滚轮向光标缩放(50–300%)、拖拽平移、双击/点百分数复位、
// 底部 ± 步进缩放胶囊(步进 25 个百分点)、点按空白处关闭(lightbox 惯例,
// 与拖拽平移以位移阈值区分)、Esc 关闭。经 portal 挂
// document.body——消息列表祖先链上任何 transform 都会改变 fixed 的包含块,
// portal 到根才能保证覆盖层铺满面板。图标单视图私有,不上移 icons.tsx
// (其收拢约定:有第二使用方才进公共层)。

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../ui/hooks";

export type MediaContent =
  | { kind: "svg"; html: string; dark?: boolean }
  | { kind: "image"; url: string; alt: string; mime?: string };

const MIN_SCALE = 0.5;
const MAX_SCALE = 3;
/** 底部胶囊的步进(绝对百分点):加减可预测(100→125→150),滚轮保持乘性 */
const ZOOM_STEP = 0.25;

interface Transform {
  x: number;
  y: number;
  s: number;
}
const IDENTITY: Transform = { x: 0, y: 0, s: 1 };

const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/** 点按与拖拽的分界:位移不超过该值算点按(点按空白处关闭用) */
const CLICK_MAX_MOVE = 5;

/** SVG 新开标签页:不能开裸 SVG——mermaid 的 htmlLabels 会在图里嵌未闭合
 *  的 <br>/<p> 等 HTML 片段,注入 DOM 走 HTML 解析器无碍,但标签页把
 *  image/svg+xml 按严格 XML 解析,标签不匹配直接报错页。包一层 HTML 文档
 *  走 HTML 解析器,底色随图的主题(浅图白底/暗图深底)。data: URL 会被
 *  Chrome 拦顶层导航,必须走 blob;不主动回收——加载中 revoke 会死链 */
function svgToTabUrl(svg: string, dark: boolean | undefined, title: string): string | null {
  try {
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>html,body{margin:0;height:100%;background:${dark ? "#1c1b1a" : "#fff"}}svg{width:100%;height:100%}</style></head><body>${svg}</body></html>`;
    return URL.createObjectURL(new Blob([html], { type: "text/html" }));
  } catch {
    return null;
  }
}

/** SVG 存盘:与新标签页同源的 XML 合法性问题——存出的 .svg 文件也要能独立
 *  打开。先经 DOMParser(HTML 解析器,容忍未闭合标签)建 DOM,再
 *  XMLSerializer 序列化:未闭合标签自闭合、HTML 实体落成字面字符 */
function svgToFileBlob(svg: string): Blob | null {
  try {
    const doc = new DOMParser().parseFromString(svg, "text/html");
    const el = doc.body.querySelector("svg");
    if (!el) return null;
    // 清掉空的 xmlns="":序列化会按命名空间补上正规 xmlns,同名属性并存
    // 是非法 XML(存出的文件打不开,重演未闭合标签同款事故)
    for (const n of el.querySelectorAll("[xmlns='']")) n.removeAttribute("xmlns");
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(el)}`;
    return new Blob([xml], { type: "image/svg+xml" });
  } catch {
    return null;
  }
}

/** 图片存盘扩展名(无 mime 时兜底 png) */
function imageExt(mime: string | undefined): string {
  if (mime?.includes("webp")) return "webp";
  if (mime?.includes("jpeg")) return "jpg";
  return "png";
}

function CloseIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      aria-hidden="true"
      className="block"
    >
      <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
    </svg>
  );
}

function OpenTabIcon() {
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
      <path d="M9 2.5h4.5V7" />
      <path d="M13.5 2.5L7 9" />
      <path d="M12 9.5v3A1.5 1.5 0 0 1 10.5 14h-7A1.5 1.5 0 0 1 2 12.5v-7A1.5 1.5 0 0 1 3.5 4h3" />
    </svg>
  );
}

function SaveIcon() {
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
      <path d="M8 2v8" />
      <path d="M4.5 7L8 10.5L11.5 7" />
      <path d="M2.5 12v1A1.5 1.5 0 0 0 4 14.5h8a1.5 1.5 0 0 0 1.5-1.5v-1" />
    </svg>
  );
}

export function MediaViewer({
  content,
  onClose,
}: {
  content: MediaContent;
  onClose: () => void;
}) {
  const t = useT();
  const [tf, setTf] = useState<Transform>(IDENTITY);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<{
    px: number;
    py: number;
    base: Transform;
    /** 按下落点:pointercapture 会把 up 的 target 重定向到 stage,「按在
     *  媒体还是空白」只能在 down 时记(点按空白关闭的判据) */
    target: EventTarget | null;
  } | null>(null);

  // 打开时聚焦容器(键盘可达),关闭时把焦点还给触发元素
  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement | null;
    rootRef.current?.focus();
    return () => {
      restoreRef.current?.focus?.();
    };
  }, []);

  // Esc 关闭(IME 组词不吞;与 ConfirmCard 同款窗口级监听)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.isComposing) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 滚轮缩放:必须原生监听(passive:false)才能 preventDefault 阻断底层
  // 消息列表滚动,React 合成 wheel 是被动的
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.25 : 0.8;
      const rect = el.getBoundingClientRect();
      // 光标相对舞台中心的偏移 = 缩放锚点
      const cx = e.clientX - rect.left - rect.width / 2;
      const cy = e.clientY - rect.top - rect.height / 2;
      setTf((cur) => {
        const s = clampScale(cur.s * factor);
        // 保持光标下的内容点不动:t' = c − ((c − t)/s_old)·s_new
        return {
          s,
          x: cx - ((cx - cur.x) / cur.s) * s,
          y: cy - ((cy - cur.y) / cur.s) * s,
        };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    dragRef.current = {
      px: e.clientX,
      py: e.clientY,
      base: tf,
      target: e.target,
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    setTf({
      s: d.base.s,
      x: d.base.x + (e.clientX - d.px),
      y: d.base.y + (e.clientY - d.py),
    });
  };
  // pointerup:拖拽收尾 + 点按空白关闭。位移超阈值的落手(拖拽平移)不算
  // 点按;按下落在媒体内容上的点按也不关 —— 只认空白处的点按
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    const moved = Math.hypot(e.clientX - d.px, e.clientY - d.py);
    const onMedia =
      d.target instanceof Element &&
      d.target.closest("img, .media-svg-host") !== null;
    if (moved <= CLICK_MAX_MOVE && !onMedia) onClose();
  };
  // pointercancel(指针被系统接管)不算点击,只收尾
  const endDrag = () => {
    dragRef.current = null;
  };

  /** 底部胶囊的步进缩放:绝对 ±25 个百分点,锚定舞台中心(t 随比例缩放) */
  const stepZoom = (delta: number) => {
    setTf((cur) => {
      const s = clampScale(cur.s + delta);
      const r = s / cur.s;
      return { s, x: cur.x * r, y: cur.y * r };
    });
  };

  const openInTab = async () => {
    if (content.kind === "image") {
      // data: URL(echarts 快照走 getDataURL)会被 Chrome 拦顶层导航:
      // 先转 objectURL 再开。不主动回收——新标签页加载中 revoke 会死链
      // (同 svgToTabUrl 的取舍)
      if (content.url.startsWith("data:")) {
        try {
          const blob = await fetch(content.url).then((r) => r.blob());
          window.open(URL.createObjectURL(blob), "_blank", "noreferrer");
        } catch {
          // data: URL 本地解码失败(实际不可达)→ 退回原始尝试,Chrome
          // 仍会拦,行为等于没有出口
          window.open(content.url, "_blank", "noreferrer");
        }
        return;
      }
      window.open(content.url, "_blank", "noreferrer");
      return;
    }
    const url = svgToTabUrl(content.html, content.dark, t("chat.media.viewer"));
    if (url) window.open(url, "_blank", "noreferrer");
  };

  /** 保存到本地:图表经 XML 序列化成 .svg,图片存原图字节 */
  const save = () => {
    let url: string | null = null;
    let revoke = false;
    let name: string;
    if (content.kind === "image") {
      url = content.url; // objectURL 归 images.ts 缓存管,不在这里回收
      name = `tars-image.${imageExt(content.mime)}`;
    } else {
      const blob = svgToFileBlob(content.html);
      if (!blob) return;
      url = URL.createObjectURL(blob);
      revoke = true;
      name = "tars-diagram.svg";
    }
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    // 下载经 blob URL 异步开始,延迟回收;失败无害(面板关了浏览器也会收)
    if (revoke) setTimeout(() => URL.revokeObjectURL(url as string), 10_000);
  };

  const pct = Math.round(tf.s * 100);

  return createPortal(
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={t("chat.media.viewer")}
      tabIndex={-1}
      className="media-viewer fixed inset-0 z-30 flex flex-col outline-none"
    >
      <div className="flex items-center justify-end gap-1 p-2">
        <button
          type="button"
          className="icon-btn"
          aria-label={t("chat.media.save")}
          title={t("chat.media.save")}
          onClick={save}
        >
          <SaveIcon />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label={t("chat.media.openTab")}
          title={t("chat.media.openTab")}
          onClick={openInTab}
        >
          <OpenTabIcon />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label={t("chat.media.close")}
          title={t("chat.media.close")}
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 交互舞台(指针拖拽/双击复位),键盘出口在工具条与 Esc */}
      <div
        ref={stageRef}
        className="relative flex-1 cursor-grab touch-none overflow-hidden select-none active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={endDrag}
        onDoubleClick={() => setTf(IDENTITY)}
      >
        <div
          className="media-stage flex h-full w-full items-center justify-center will-change-transform"
          style={{ transform: `translate(${tf.x}px, ${tf.y}px) scale(${tf.s})` }}
        >
          {content.kind === "svg" ? (
            // biome-ignore lint/security/noDangerouslySetInnerHtml: 注入体与图内同一份——mermaid securityLevel:"strict"(内置 DOMPurify)消毒后的 SVG
            <div className="media-svg-host" role="img" aria-label={t("chat.media.viewer")} dangerouslySetInnerHTML={{ __html: content.html }} />
          ) : (
            <img
              src={content.url}
              alt={content.alt}
              draggable={false}
              className="max-h-full max-w-full object-contain"
            />
          )}
        </div>
      </div>
      {/* 底部缩放胶囊:−/百分数/+;点百分数复位(承接原顶部复位钮) */}
      <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
        <div className="pointer-events-auto flex items-center gap-0.5 rounded-full bg-surface-container-high p-1 shadow-2">
          <button
            type="button"
            className="icon-btn h-7 w-7 text-[15px] leading-none"
            aria-label={t("chat.media.zoomOut")}
            onClick={() => stepZoom(-ZOOM_STEP)}
          >
            −
          </button>
          <button
            type="button"
            className="min-w-[3.2em] rounded-full px-1 py-0.5 text-center text-[12px] font-medium tabular-nums text-on-surface-variant transition-colors duration-150 hover:bg-surface-container-highest hover:text-on-surface"
            title={t("chat.media.reset")}
            onClick={() => setTf(IDENTITY)}
          >
            {pct}%
          </button>
          <button
            type="button"
            className="icon-btn h-7 w-7 text-[15px] leading-none"
            aria-label={t("chat.media.zoomIn")}
            onClick={() => stepZoom(ZOOM_STEP)}
          >
            +
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
