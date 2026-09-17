// apiFetch 行为单测:重试决策矩阵(临时状态码重试/明确错误不重试/网络层
// 错误重试)、Retry-After 优先、超时与用户取消不重试、请求头组装。
// 此前 client.ts 覆盖率 8%,重试语义全部隐式(2026-09 评审 T8)。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "./client";

const ok = () => new Response("{}", { status: 200 });

/** 依次弹出的响应队列;函数可检查 attempt 上下文 */
function fetchQueue(resps: Array<Response | ((attempt: number) => Response)>) {
  let n = 0;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn((url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const r = resps[Math.min(n, resps.length - 1)];
    n++;
    return Promise.resolve(typeof r === "function" ? r(n - 1) : r);
  });
  return { fn, calls, count: () => n };
}

const status = (code: number, headers: Record<string, string> = {}) =>
  new Response("err-body", { status: code, headers });

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const base = {
  baseUrl: "https://api.test/v1",
  apiKey: "sk-abc",
  path: "/chat/completions",
};

describe("apiFetch 错误归一与重试", () => {
  it("成功响应原样返回,只发一次请求", async () => {
    const q = fetchQueue([ok()]);
    vi.mocked(fetch).mockImplementation(q.fn as typeof fetch);
    const res = await apiFetch(base);
    expect(res.status).toBe(200);
    expect(q.count()).toBe(1);
  });

  it("401 鉴权失败不重试:立即抛 ApiError,仅一次请求", async () => {
    const q = fetchQueue([status(401)]);
    vi.mocked(fetch).mockImplementation(q.fn as typeof fetch);
    await expect(apiFetch(base)).rejects.toThrow(/HTTP 401/);
    expect(q.count()).toBe(1);
  });

  it("429 限流重试至上限(1 + 3 次),耗尽后抛 ApiError", async () => {
    const q = fetchQueue([status(429)]);
    vi.mocked(fetch).mockImplementation(q.fn as typeof fetch);
    // catch 先行挂上,避免「拒绝先于断言处理器」被记成 unhandled
    const p = apiFetch(base).catch((e) => e);
    await vi.runAllTimersAsync();
    expect(String(await p)).toMatch(/HTTP 429/);
    expect(q.count()).toBe(4);
  });

  it("Retry-After 头优先于指数退避", async () => {
    const q = fetchQueue([status(429, { "retry-after": "2" }), ok()]);
    vi.mocked(fetch).mockImplementation(q.fn as typeof fetch);
    const p = apiFetch(base);
    await vi.advanceTimersByTimeAsync(1999); // 不足 2s:第二次请求还没发
    expect(q.count()).toBe(1);
    await vi.advanceTimersByTimeAsync(1); // 恰好 2s:重试发出
    const res = await p;
    expect(res.status).toBe(200);
    expect(q.count()).toBe(2);
  });

  it("Retry-After 非 数字头按解析失败兜底走指数退避", async () => {
    const q = fetchQueue([status(503, { "retry-after": "soon" }), ok()]);
    vi.mocked(fetch).mockImplementation(q.fn as typeof fetch);
    const p = apiFetch(base);
    await vi.runAllTimersAsync();
    const res = await p;
    expect(res.status).toBe(200);
    expect(q.count()).toBe(2);
  });

  it("网络层错误(fetch reject)退避重试,耗尽后原样抛出", async () => {
    let n = 0;
    vi.mocked(fetch).mockImplementation(() => {
      n++;
      return Promise.reject(new TypeError("fetch failed"));
    });
    const p = apiFetch(base).catch((e) => e);
    await vi.runAllTimersAsync();
    expect(String(await p)).toMatch("fetch failed");
    expect(n).toBe(4);
  });

  it("retry:false 交互请求快速失败:网络错误不重试", async () => {
    let n = 0;
    vi.mocked(fetch).mockImplementation(() => {
      n++;
      return Promise.reject(new TypeError("fetch failed"));
    });
    const out = await apiFetch({ ...base, retry: false }).catch((e) => e);
    expect(String(out)).toMatch("fetch failed");
    expect(n).toBe(1);
  });

  it("超时:挂死的 fetch 被合并 signal 中止,报超时错误不重试", async () => {
    vi.mocked(fetch).mockImplementation(
      (_url, init: RequestInit = {}) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const p = apiFetch({ ...base, timeoutMs: 1000, retry: false }).catch((e) => e);
    await vi.runAllTimersAsync();
    expect(String(await p)).toMatch("request timeout after 1000ms");
  });

  it("外部取消:用户点停止后立即抛出,不重试", async () => {
    const ctrl = new AbortController();
    let n = 0;
    vi.mocked(fetch).mockImplementation(
      (_url, init: RequestInit = {}) =>
        new Promise((_resolve, reject) => {
          n++;
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const p = apiFetch({ ...base, signal: ctrl.signal }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(1);
    ctrl.abort();
    await p;
    expect(n).toBe(1); // 取消不重试
  });

  it("请求组装:Bearer 认证头 + POST JSON;GET 无 body 不带 Content-Type", async () => {
    const q1 = fetchQueue([ok()]);
    vi.mocked(fetch).mockImplementation(q1.fn as typeof fetch);
    await apiFetch({ ...base, body: { model: "m" } });
    expect(q1.calls[0].init.method).toBe("POST");
    const h1 = new Headers(q1.calls[0].init.headers);
    expect(h1.get("authorization")).toBe("Bearer sk-abc");
    expect(h1.get("content-type")).toBe("application/json");
    expect(q1.calls[0].init.body).toBe(JSON.stringify({ model: "m" }));

    const q2 = fetchQueue([ok()]);
    vi.mocked(fetch).mockImplementation(q2.fn as typeof fetch);
    await apiFetch({ ...base, method: "GET", path: "/models" });
    expect(q2.calls[0].init.method).toBe("GET");
    const h2 = new Headers(q2.calls[0].init.headers);
    expect(h2.get("content-type")).toBeNull();
  });
});
