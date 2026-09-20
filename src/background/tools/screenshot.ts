// page_screenshot 执行体:站点授权门 → 激活目标 tab(captureVisibleTab 只能
// 截所在窗口的「活动 tab」,目标 ≠ 活动时先激活、截完恢复)→ content 画
// SoM 标记 → SW 对该 tab 所在窗口 captureVisibleTab → content 摘标记 →
// OffscreenCanvas 降采样压 JPEG。
// 时序纪律:标记必须在捕获前画上、捕获后立即摘除(finally 兜底),截图里的
// 编号框才有意义且不留副作用;激活/恢复也走 finally 配平,不把 tab 切换
// 残留给用户。三者的空间对齐前提(编号画在哪个 tab、截的是哪个 tab)由此
// 机械保证。
// 图片字节挂在结果的 screenshot 字段返回,agent 循环剥离后转成紧随工具
// 消息的带图 user 消息 —— 本文件不碰消息协议。

import {
  callContentTool,
  getActiveTabId,
} from "../../shared/contentTools";
import {
  grantableOriginOf,
  hasOriginAccess,
  pageAccessHint,
} from "../../shared/hostAccess";
import { createLogger } from "../../shared/logger";
import { errText } from "../../shared/errors";
import type { ToolScreenshot } from "../../shared/toolTypes";
import {
  getToolExecutionContext,
  pickTargetTabId,
} from "./toolContext";

const log = createLogger({ ctx: "bg" });

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
  /** 捕获时的页面几何:模型据此知道「截到的是哪一段、还有没有下文」 */
  page: {
    scroll_y: number;
    scroll_height: number;
    viewport_height: number;
    at_bottom: boolean;
  };
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

  // 目标 ≠ 活动时先激活再截(模型显式传 tabId、用户中途切页、多窗口时
  // 必然走到这里):不激活会把另一个 tab 的画面连同本页的编号表一起发给
  // 模型 —— 视觉结论系统性错误,还顺带外带别的标签页内容。
  // 激活失败(参数竞态/无权限)明确报错,不静默退化成「截错页」
  const [activeTab] = await chrome.tabs.query({
    active: true,
    windowId: tab.windowId,
  });
  const needActivate = activeTab?.id !== tabId;
  let restore: (() => Promise<void>) | null = null;
  if (needActivate) {
    await activateTab(tabId);
    const prevActiveId = activeTab?.id;
    restore = async () => {
      if (prevActiveId !== undefined && prevActiveId >= 0) {
        await chrome.tabs.update(prevActiveId, { active: true });
      }
    };
  }
  log.info("screenshot", "capture target", {
    tabId,
    activated: needActivate,
  });

  try {
    const marked = (await callContentTool(tabId, "screenshot_mark", {
      limit: MARK_LIMIT,
    })) as { marks: ScreenshotMark[]; page: PageScreenshotResult["page"] };

    const shot = await captureAndEncode(tab.windowId);
    return {
      url: tab.url ?? "",
      viewport: shot.viewport,
      page: marked.page,
      marks: marked.marks,
      screenshot: shot.attachment,
    };
  } finally {
    // 摘标记兜底:捕获或编码抛错也不能把标记框留在用户页面上。失败要留痕
    // 而不是静默吞掉 —— callContentTool 的授权复核对这条清理同样生效(撤权
    // 后清理会被拒),那种情况下标记框确实会留在页面上,日志是唯一线索
    await callContentTool(tabId, "screenshot_cleanup").catch((e) => {
      log.warn("screenshot", "摘标记失败(标记框可能残留在页面)", {
        tabId,
        err: errText(e),
      });
    });
    // 活动 tab 配平恢复:尽力而为(原 tab 可能已被用户关掉),失败不吞掉主流程错误
    if (restore) await restore().catch(() => {});
  }
}

/** 激活目标 tab 并等它真正成为活动 tab。Chrome 没有「首帧绘制完成」事件,
 *  tab.status complete 只代表加载完 —— 激活后留一小段合成器出帧窗口,
 *  避免 captureVisibleTab 抓到未绘制帧(产品侧唯一一处固定等待,配合
 *  captureVisibleTab 的每秒限频重试一起兜底)。
 *  TODO(截后复核):捕获前后用户仍可能在这 ~150ms 内切页,
 *  现无「捕获时活动 tab 仍是目标」的复核;加固方向是截完 query 一次活动
 *  tab,不是目标则重试一次或明确报错(复核是缩小而非消除竞态) */
async function activateTab(tabId: number): Promise<void> {
  await chrome.tabs.update(tabId, { active: true });
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (t?.active) {
      await new Promise((r) => setTimeout(r, 150));
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`page_screenshot: 无法激活目标标签页(tabId ${tabId})`);
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
    const msg = errText(err);
    // Chrome 限每秒 2 次 captureVisibleTab(MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND):
    // 「截图 → 滚动 → 再截」的视觉循环一秒内就能撞上,退避一秒重试一次
    if (/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i.test(msg)) {
      await new Promise((r) => setTimeout(r, 1100));
      try {
        dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
          format: "jpeg",
          quality: 85,
        });
      } catch (retryErr) {
        throw new Error(`page_screenshot: 截图失败(${errText(retryErr)})`);
      }
    } else {
      throw new Error(
        `page_screenshot: 截图失败(${msg})。页面可能是浏览器内置页不可截,或所在窗口已最小化`,
      );
    }
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
