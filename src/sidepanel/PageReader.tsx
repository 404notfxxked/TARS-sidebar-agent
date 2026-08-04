// 演示：side panel 直接调用 content script
// 不经过 background service worker

import { useEffect, useState, useTransition } from "react";
import { callContentTool, getActiveTabId } from "../shared/contentTools";

interface PageMeta {
  title: string;
  url: string;
  text: string;
  htmlLength: number;
}

export default function PageReader() {
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [unavailableReason, setUnavailableReason] = useState<string | null>(
    null,
  );
  const availablePageReg = /^https?:\/\//;

  const handleRead = () => {
    setError(null);
    startTransition(async () => {
      try {
        const tabId = await getActiveTabId();
        console.log("获取活动页面 id:", tabId);
        if (tabId === null) {
          throw new Error("no active tab");
        }
        const result = (await callContentTool(
          tabId,
          "get_page_content",
        )) as PageMeta;
        setMeta(result);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  };

  useEffect(() => {
    let cancelled = false;

    const checkActiveTab = () => {
      chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
        console.log("检查tab", tab);
        if (cancelled) return;
        setUnavailableReason(
          availablePageReg.test(tab?.url ?? "") ? null : "当前页面不可读取",
        );
      });
    };

    const onActivated = () => checkActiveTab(); // 切 tab / 换窗口
    const onUpdated = (_: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (changeInfo.url !== undefined || changeInfo.status === "complete") {
        checkActiveTab(); // 同 tab 内导航
      }
    };

    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    checkActiveTab(); // 面板打开时先查一次

    return () => {
      cancelled = true;
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, []);

  return (
    <section className="bg-white border border-gray-200 rounded-lg px-4 py-3.5 shadow-sm">
      <h2 className="text-[13px] m-0 mb-2.5 text-gray-500 font-semibold uppercase tracking-wider">
        Side Panel ↔ Content Script · 直连
      </h2>

      <button
        type="button"
        onClick={handleRead}
        disabled={isPending || unavailableReason !== null}
        className="w-full px-3 py-2 bg-emerald-600 text-white border-none rounded-md text-[13px] cursor-pointer disabled:bg-gray-400 disabled:cursor-not-allowed mb-2"
      >
        {unavailableReason ?? (isPending ? "读取中…" : "读取当前页面")}
      </button>

      {error && <p className="m-0 mb-2 text-[12px] text-red-600">⚠ {error}</p>}

      {meta && (
        <div className="text-[12px] text-gray-700 space-y-1">
          <div>
            <span className="text-gray-400">title:</span> {meta.title || "—"}
          </div>
          <div className="break-all">
            <span className="text-gray-400">url:</span> {meta.url}
          </div>
          <div>
            <span className="text-gray-400">html length:</span>{" "}
            {meta.htmlLength}
          </div>
          <details className="mt-1">
            <summary className="cursor-pointer text-gray-500 hover:text-gray-700">
              text preview
            </summary>
            <pre className="m-0 mt-1 p-2 bg-gray-50 border border-gray-100 rounded text-[11px] max-h-32 overflow-auto whitespace-pre-wrap">
              {meta.text.slice(0, 500)}
              {meta.text.length > 500 ? "…" : ""}
            </pre>
          </details>
        </div>
      )}
    </section>
  );
}
