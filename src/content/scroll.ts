// 页面交互·滚动侧:window 视口滚动与落点几何。程序化滚动同步生效,返回时
// 读到的就是落点几何;滚动监听器照常触发,惰性加载能被正确喂到。

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
