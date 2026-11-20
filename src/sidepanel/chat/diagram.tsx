// 图表渲染(mermaid / echarts 代码块 → 图):组件与渲染基建,语言分派在
// bubbles 的 CodeBlock(它已在提取语言标识与源码)。关键取舍:
// - 渲染在面板本地、库按需 import:流式增量直接命中源码缓存,不做 port
//   往返;mermaid/echarts 只在首个对应图表块出现时才加载(约 1MB 级
//   chunk 不进首屏)
// - 渲染失败与流式半成品共用「回退源码」一条路径:不完整源码 parse 必然
//   失败,流式中自然以代码块形态出现,闭合且合法后翻成图;失败注记在源码
//   静置片刻后才显示,流式期间不出「失败」字样误导
// - SVG 经 mermaid securityLevel:"strict"(内置 DOMPurify)消毒后注入,
//   不开 loose、不接 click 回调
// - echarts 实例随容器生灭(与 mermaid 的全局单例不同):容器挂上才
//   init、卸载即 dispose,主题翻转走重新 init;放大快照走 getDataURL
//   的 data: URL,开新标签页时的 data:→objectURL 转换在 MediaViewer 侧
// - 主题跟随 <html data-theme>(theme.ts 只写 DOM 属性,无 React 状态可
//   订阅):MutationObserver 监听翻转;缓存键含主题,浅深各存一份

import { useEffect, useMemo, useRef, useState } from "react";
import { useCopyFlash, useT } from "../ui/hooks";
import { MediaViewer } from "./MediaViewer";

type ResolvedTheme = "light" | "dark";

/** 当前生效主题:data-theme 翻转(含 system 偏好下媒体查询驱动的重算)都
 *  过 MutationObserver;state 驱动,React Compiler 下不会陈旧 */
function useResolvedTheme(): ResolvedTheme {
  const [theme, setTheme] = useState<ResolvedTheme>(() =>
    document.documentElement.dataset.theme === "dark" ? "dark" : "light",
  );
  useEffect(() => {
    const read = () =>
      setTheme(
        document.documentElement.dataset.theme === "dark" ? "dark" : "light",
      );
    const obs = new MutationObserver(read);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => obs.disconnect();
  }, []);
  return theme;
}

// ---- mermaid:懒加载 + 单例初始化(主题变化时重设) ----

let mermaidMod: typeof import("mermaid") | null = null;
let mermaidTheme: ResolvedTheme | null = null;
let renderSeq = 0;

async function ensureMermaid(
  theme: ResolvedTheme,
): Promise<(typeof import("mermaid"))["default"]> {
  mermaidMod ??= await import("mermaid");
  if (mermaidTheme !== theme) {
    mermaidMod.default.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: theme === "dark" ? "dark" : "default",
    });
    mermaidTheme = theme;
  }
  return mermaidMod.default;
}

// ---- 渲染缓存:key = 主题 + 源码(同图浅深各一份),LRU 上限防长会话膨胀 ----

const RENDER_CACHE_MAX = 24;
const renderCache = new Map<string, string>();

function cacheGet(key: string): string | undefined {
  const hit = renderCache.get(key);
  if (hit !== undefined) {
    renderCache.delete(key);
    renderCache.set(key, hit);
  }
  return hit;
}

function cacheSet(key: string, svg: string): void {
  if (renderCache.size >= RENDER_CACHE_MAX) {
    renderCache.delete(renderCache.keys().next().value as string);
  }
  renderCache.set(key, svg);
}

/** 规范化 mermaid 根 svg 的尺寸声明:剥掉行内 style(内含 max-width: Npx,
 *  会压过样式表的容器适配)与显式宽高,统一挂 width="100%"——尺寸交给各
 *  容器的 CSS(viewBox 仍在,等比关系不丢)。否则查看器里 width:auto 的
 *  svg 会被行内 max-width 钉死而塌成 0×0(复杂宽图实测) */
function normalizeMermaidSvg(svg: string): string {
  const stripped = svg.replace(/<svg\b[^>]*>/, (tag) =>
    tag
      .replace(/\s(width|height)="[^"]*"/g, "")
      .replace(/\sstyle="[^"]*"/g, ""),
  );
  return stripped.replace("<svg", '<svg width="100%"');
}

/** 代码块头部条(语言名 + 失败注记 + 复制):成图与回退源码两态共用 */
function DiagramHead({
  lang,
  note,
  code,
}: {
  lang: string;
  note?: string;
  code: string;
}) {
  const t = useT();
  const [copied, copy] = useCopyFlash();
  return (
    <figcaption className="code-block-head">
      <span>
        {lang}
        {note && <span className="diagram-note">{note}</span>}
      </span>
      <button
        type="button"
        onClick={() => copy(code)}
        className="code-copy-btn"
      >
        {copied ? t("common.copied") : t("common.copy")}
      </button>
    </figcaption>
  );
}

/** 失败注记的静置门槛:源码还在变(流式)就一直不出注记,静置后才告知 */
const NOTE_SETTLE_MS = 800;

export function MermaidFigure({ code }: { code: string }) {
  const t = useT();
  const theme = useResolvedTheme();
  const key = `${theme}\n${code}`;
  const [svg, setSvg] = useState<string | null>(() => cacheGet(key) ?? null);
  const [failed, setFailed] = useState(false);
  const [noteVisible, setNoteVisible] = useState(false);
  const [zoom, setZoom] = useState(false);

  useEffect(() => {
    const hit = cacheGet(key);
    if (hit !== undefined) {
      setSvg(hit);
      setFailed(false);
      return;
    }
    let alive = true;
    setSvg(null);
    setFailed(false);
    ensureMermaid(theme)
      .then((m) => m.render(`mmd-${++renderSeq}`, code))
      .then((res) => {
        const normalized = normalizeMermaidSvg(res.svg);
        cacheSet(key, normalized);
        if (alive) setSvg(normalized);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [key, theme, code]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: code 是刻意的重置触发器(流式新分片重启静置计时),不在回调内读取
  useEffect(() => {
    if (!failed) {
      setNoteVisible(false);
      return;
    }
    const timer = setTimeout(() => setNoteVisible(true), NOTE_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [failed, code]);

  if (svg === null) {
    return (
      <figure className="code-block">
        <DiagramHead
          lang="mermaid"
          note={noteVisible ? t("chat.diagram.renderFailed") : undefined}
          code={code}
        />
        <pre>
          <code className="language-mermaid">{code}</code>
        </pre>
      </figure>
    );
  }
  return (
    <figure className="diagram-figure">
      <DiagramHead lang="mermaid" code={code} />
      {/* 点击进放大查看器(复杂图在窄面板里读不清的主出口);真按钮,
          Enter/Space 原生可达 */}
      <button
        type="button"
        className="diagram-btn"
        aria-label={t("chat.media.zoomIn")}
        onClick={() => setZoom(true)}
      >
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: 注入体是 mermaid securityLevel:"strict"(内置 DOMPurify)消毒后的 SVG,这是图表渲染的既定通道 */}
        <div className="diagram-body" dangerouslySetInnerHTML={{ __html: svg }} />
      </button>
      {zoom && (
        <MediaViewer
          content={{ kind: "svg", html: svg, dark: theme === "dark" }}
          onClose={() => setZoom(false)}
        />
      )}
    </figure>
  );
}

// ---- echarts:统计图(JSON option)。实例随容器生灭,无跨渲染缓存 ----

type EChartsChart = ReturnType<typeof import("echarts").init>;
/** setOption 的参数形态(JSON.parse 结果的目标类型) */
type EChartsOptionInput = Parameters<EChartsChart["setOption"]>[0];

export function EChartsFigure({ code }: { code: string }) {
  const t = useT();
  const theme = useResolvedTheme();
  const [initFailed, setInitFailed] = useState(false);
  const [noteVisible, setNoteVisible] = useState(false);
  const [zoom, setZoom] = useState(false);
  const [zoomUrl, setZoomUrl] = useState<string | null>(null);
  // 容器元素走 state 而非 ref:init 必须等容器真挂上(option 可用晚于
  // 回退态的挂载拍,拿 ref 拿不到),callback ref 置值驱动 init effect 重跑
  const [bodyEl, setBodyEl] = useState<HTMLDivElement | null>(null);
  const chartRef = useRef<EChartsChart | null>(null);

  // JSON 可用性同步判定:parse 抛错(流式半成品)或结果不是 option 对象
  // 都算不可用,渲染直接走源码回退,与 MermaidFigure 的失败态同款
  const option = useMemo<EChartsOptionInput | null>(() => {
    try {
      const parsed: unknown = JSON.parse(code);
      return parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
        ? (parsed as EChartsOptionInput)
        : null;
    } catch {
      return null;
    }
  }, [code]);

  const failed = option === null || initFailed;

  useEffect(() => {
    if (option === null || !bodyEl) return;
    let alive = true;
    let inst: EChartsChart | null = null;
    void import("echarts")
      .then((echarts) => {
        if (!alive) return;
        inst = echarts.init(bodyEl, theme === "dark" ? "dark" : undefined);
        inst.setOption(option);
        chartRef.current = inst;
      })
      .catch(() => {
        // 懒加载失败(chunk 拉取失败,罕见)同样回退源码态
        if (alive) setInitFailed(true);
      });
    return () => {
      alive = false;
      inst?.dispose();
      chartRef.current = null;
    };
  }, [option, theme, bodyEl]);

  // 容器尺寸变化 → resize:echarts 不自动跟随面板宽度(拖宽侧栏等)
  useEffect(() => {
    if (!bodyEl) return;
    const ro = new ResizeObserver(() => chartRef.current?.resize());
    ro.observe(bodyEl);
    return () => ro.disconnect();
  }, [bodyEl]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: code 是刻意的重置触发器(流式新分片重启静置计时),不在回调内读取
  useEffect(() => {
    if (!failed) {
      setNoteVisible(false);
      return;
    }
    const timer = setTimeout(() => setNoteVisible(true), NOTE_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [failed, code]);

  if (failed) {
    return (
      <figure className="code-block">
        <DiagramHead
          lang="echarts"
          note={noteVisible ? t("chat.diagram.renderFailed") : undefined}
          code={code}
        />
        <pre>
          <code className="language-echarts">{code}</code>
        </pre>
      </figure>
    );
  }
  return (
    <figure className="diagram-figure">
      <DiagramHead lang="echarts" code={code} />
      {/* 点击进放大查看器:快照 data: URL 的获取与转换见 MediaViewer 头注 */}
      <button
        type="button"
        className="diagram-btn"
        aria-label={t("chat.media.zoomIn")}
        onClick={() => {
          const url = chartRef.current?.getDataURL({ pixelRatio: 2 });
          if (!url) return;
          setZoomUrl(url);
          setZoom(true);
        }}
      >
        <div ref={setBodyEl} className="diagram-echarts-body" />
      </button>
      {zoom && zoomUrl && (
        <MediaViewer
          content={{ kind: "image", url: zoomUrl, alt: t("chat.media.viewer") }}
          onClose={() => setZoom(false)}
        />
      )}
    </figure>
  );
}
