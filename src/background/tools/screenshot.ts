// page_screenshot 执行体:站点授权门 → content 画 SoM 标记 → SW 对该 tab
// 所在窗口 captureVisibleTab → content 摘标记 → OffscreenCanvas 降采样压 JPEG。
// 时序纪律:标记必须在捕获前画上、捕获后立即摘除(finally 兜底),截图里的
// 编号框才有意义且不留副作用。图片字节挂在结果的 screenshot 字段返回,
// agent 循环剥离后转成紧随工具消息的带图 user 消息 —— 本文件不碰消息协议。

import {
  callContentTool,
  getActiveTabId,
} from "../../shared/contentTools";
import {
  grantableOriginOf,
  hasOriginAccess,
  pageAccessHint,
} from "../../shared/hostAccess";
import type { ToolScreenshot } from "../../shared/toolTypes";
import {
  getToolExecutionContext,
  pickTargetTabId,
} from "./toolContext";

/** 附件宽度上限:1280 对视觉模型足够辨识编号,字节量稳定在百 KB 级 */
const CAPTURE_MAX_WIDTH = 1280;
const JPEG_QUALITY = 0.8;
/** 标记数量上限(与 content 侧 drawMarks 的枚举上限一致) */
const MARK_LIMIT = 30;

export interface ScreenshotMark {
  n: number;
  selector: string;
  tag: string;
  role: string | null;
  label: string | null;
}

export interface PageScreenshotResult {
  url: string;
  viewport: { w: number; h: number };
  /** 空数组 = 视口内没有可交互元素(纯内容页),图照常给(「它长什么样」) */
  marks: ScreenshotMark[];
  screenshot: ToolScreenshot;
}

export async function runPageScreenshot(
  args: { tabId?: number },
): Promise<PageScreenshotResult> {
  const ctx = getToolExecutionContext();
  const tabId = pickTargetTabId(
    args?.tabId,
    ctx?.lastOperatedTabId,
    ctx?.tabId,
    await getActiveTabId(),
  );
  if (tabId === null) throw new Error("no active tab");
  if (ctx) ctx.lastOperatedTabId = tabId;

  const tab = await chrome.tabs.get(tabId);
  const origin = grantableOriginOf(tab.url ?? "");
  if (!origin) {
    throw new Error(
      `page_screenshot: 目标页(${tab.url ?? "unknown"})不支持截图,仅 http/https 页面可以截`,
    );
  }
  // 站点授权门:与读页/操作同一条门。captureVisibleTab 没有 host 权限时
  // Chrome 直接拒绝,这里提前给出可行动指引(fail-early 纪律)
  if (!(await hasOriginAccess(origin))) {
    throw new Error(pageAccessHint(origin));
  }

  try {
    const marks = (await callContentTool(tabId, "screenshot_mark", {
      limit: MARK_LIMIT,
    })) as ScreenshotMark[];

    const shot = await captureAndEncode(tab.windowId);
    return { url: tab.url ?? "", viewport: shot.viewport, marks, screenshot: shot.attachment };
  } finally {
    // 摘标记兜底:捕获或编码抛错也不能把标记框留在用户页面上
    await callContentTool(tabId, "screenshot_cleanup").catch(() => {});
  }
}

async function captureAndEncode(windowId: number): Promise<{
  viewport: { w: number; h: number };
  attachment: ToolScreenshot;
}> {
  let dataUrl: string;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
      format: "jpeg",
      quality: 85,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `page_screenshot: 截图失败(${msg})。页面可能是浏览器内置页不可截,或所在窗口已最小化`,
    );
  }

  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, CAPTURE_MAX_WIDTH / bmp.width);
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext("2d")?.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const out = await canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY });
  return {
    viewport: { w, h },
    attachment: {
      bytes: new Uint8Array(await out.arrayBuffer()),
      mime: "image/jpeg",
      w,
      h,
    },
  };
}
