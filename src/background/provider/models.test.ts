// fetchModels 单测:①候选回退探测(根地址 base 首候选 404 → /v1/models;
// 版本段 base 只打一发,不拼出 /v1/v1);②错误分类(401/403 → auth 且不回退、
// 双候选 404 → missing、200 坏形状/非 JSON → shape 且多候选时继续探测);
// ③anthropic 协议:双认证头(x-api-key + anthropic-version + Bearer)、
// limit=1000 + after_id/has_more 翻页拉全、翻页硬上限、has_more 无 last_id
// 即停;④网络层错误原样抛出不推进候选。此前本模块零覆盖,
// 2026-09-23 随候选回退探测重写补齐(a4bfcc0)并钉覆盖率棘轮。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchModels, type ModelsFetchError } from "./models";

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** 依次弹出的响应队列(耗尽后重复末尾响应),记录每次请求的 URL 与头 */
function fetchQueue(resps: Response[]) {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const fn = vi.fn((url: string | URL | Request, init: RequestInit = {}) => {
    const i = calls.length;
    calls.push({ url: String(url), headers: new Headers(init.headers) });
    // clone:重复命中末尾响应时 body 已被上一页消费,Response 只能读一次
    return Promise.resolve(resps[Math.min(i, resps.length - 1)].clone());
  });
  return { fn, calls };
}

const errOf = (p: Promise<unknown>) => p.catch((e) => e);
const codeOf = async (p: Promise<unknown>) =>
  (await errOf(p) as ModelsFetchError).code;

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("候选回退探测与错误分类", () => {
  it("版本段 base(chat-completions):只打 {base}/models 一发,Bearer 认证,ids 去重排序", async () => {
    const q = fetchQueue([
      jsonRes({ data: [{ id: "b" }, { id: "a" }, { id: "a" }, { id: "" }] }),
    ]);
    vi.mocked(fetch).mockImplementation(q.fn as typeof fetch);
    const out = await fetchModels("https://api.test/v1", "sk-abc");
    expect(q.calls.length).toBe(1);
    expect(q.calls[0].url).toBe("https://api.test/v1/models");
    expect(q.calls[0].headers.get("authorization")).toBe("Bearer sk-abc");
    expect(out.ids).toEqual(["a", "b"]);
    expect(out.suggestedBase).toBeNull();
  });

  it("根地址 base:首候选 404 回退 {base}/v1/models,返回 suggestedBase", async () => {
    const q = fetchQueue([
      jsonRes({ error: "not found" }, 404),
      jsonRes({ data: [{ id: "m1" }] }),
    ]);
    vi.mocked(fetch).mockImplementation(q.fn as typeof fetch);
    const out = await fetchModels("https://gate.example.com", "sk-abc");
    expect(q.calls.map((c) => c.url)).toEqual([
      "https://gate.example.com/models",
      "https://gate.example.com/v1/models",
    ]);
    expect(out.ids).toEqual(["m1"]);
    expect(out.suggestedBase).toBe("https://gate.example.com/v1");
  });

  it("版本段 base 404 不回退:报 missing,只打一发(不拼 /v1/v1)", async () => {
    const q = fetchQueue([jsonRes({}, 404)]);
    vi.mocked(fetch).mockImplementation(q.fn as typeof fetch);
    expect(await codeOf(fetchModels("https://api.test/v1", "k"))).toBe("missing");
    expect(q.calls.length).toBe(1);
  });

  it("双候选都 404:报 missing", async () => {
    const q = fetchQueue([jsonRes({}, 404)]);
    vi.mocked(fetch).mockImplementation(q.fn as typeof fetch);
    const err = await errOf(fetchModels("https://gate.example.com", "k"));
    expect((err as ModelsFetchError).code).toBe("missing");
    expect(q.calls.length).toBe(2);
  });

  it("401 归类 auth 且立即停:不回退候选(路由存在,换路径无意义)", async () => {
    const q = fetchQueue([jsonRes({ error: { message: "bad key" } }, 401)]);
    vi.mocked(fetch).mockImplementation(q.fn as typeof fetch);
    expect(await codeOf(fetchModels("https://gate.example.com", "bad"))).toBe(
      "auth",
    );
    expect(q.calls.length).toBe(1);
  });

  it("403 同 auth 分类", async () => {
    const q = fetchQueue([jsonRes({}, 403)]);
    vi.mocked(fetch).mockImplementation(q.fn as typeof fetch);
    expect(await codeOf(fetchModels("https://api.test/v1", "k"))).toBe("auth");
  });

  it("405(路由只认别的动词)同 missing 分类并推进候选", async () => {
    const q = fetchQueue([jsonRes({}, 405), jsonRes({ data: [{ id: "m" }] })]);
    vi.mocked(fetch).mockImplementation(q.fn as typeof fetch);
    const out = await fetchModels("https://gate.example.com", "k");
    expect(q.calls.length).toBe(2);
    expect(out.ids).toEqual(["m"]);
  });

  it("200 坏形状(智谱桥式 200 包业务错误):单候选报 shape", async () => {
    const q = fetchQueue([jsonRes({ code: 401, msg: "令牌已过期" })]);
    vi.mocked(fetch).mockImplementation(q.fn as typeof fetch);
    expect(await codeOf(fetchModels("https://api.test/v1", "k"))).toBe("shape");
    expect(q.calls.length).toBe(1);
  });

  it("200 坏形状在首候选:推进到下一候选(智谱 /api/anthropic 根地址场景)", async () => {
    const q = fetchQueue([
      jsonRes({ code: 500, msg: "404 NOT_FOUND" }),
      jsonRes({ data: [{ id: "glm-5.3" }] }),
    ]);
    vi.mocked(fetch).mockImplementation(q.fn as typeof fetch);
    const out = await fetchModels("https://open.bigmodel.cn/api/anthropic", "k");
    expect(q.calls.map((c) => c.url)).toEqual([
      "https://open.bigmodel.cn/api/anthropic/models",
      "https://open.bigmodel.cn/api/anthropic/v1/models",
    ]);
    expect(out.ids).toEqual(["glm-5.3"]);
    expect(out.suggestedBase).toBe("https://open.bigmodel.cn/api/anthropic/v1");
  });

  it("200 非 JSON(网关回 HTML 控制台页):按 shape 归类而非裸 SyntaxError", async () => {
    const q = fetchQueue([new Response("<html>login</html>", { status: 200 })]);
    vi.mocked(fetch).mockImplementation(q.fn as typeof fetch);
    expect(await codeOf(fetchModels("https://api.test/v1", "k"))).toBe("shape");
  });

  it("其余状态码(如 500)不归类:原样抛 ApiError,不推进候选", async () => {
    const q = fetchQueue([jsonRes({}, 500)]);
    vi.mocked(fetch).mockImplementation(q.fn as typeof fetch);
    const err = await errOf(fetchModels("https://gate.example.com", "k"));
    expect(String(err)).toMatch(/HTTP 500/);
    expect(q.calls.length).toBe(1);
  });

  it("网络层错误原样抛出:不推进候选、不归类", async () => {
    const fn = vi.fn(() => Promise.reject(new TypeError("fetch failed")));
    vi.mocked(fetch).mockImplementation(fn as typeof fetch);
    const err = await errOf(fetchModels("https://gate.example.com", "k"));
    expect(err).toBeInstanceOf(TypeError);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("已知桥接形态:精确 host 白名单直打文档端点", () => {
  it("DeepSeek 桥(根地址式):首选候选直打 origin 根 /models,一发命中不走错误路径", async () => {
    const q = fetchQueue([jsonRes({ data: [{ id: "deepseek-v4-pro" }] })]);
    vi.mocked(fetch).mockImplementation(q.fn as typeof fetch);
    const out = await fetchModels(
      "https://api.deepseek.com/anthropic",
      "k",
      undefined,
      "anthropic-messages",
    );
    expect(q.calls.length).toBe(1);
    expect(q.calls[0].url).toBe("https://api.deepseek.com/models");
    expect(out.ids).toEqual(["deepseek-v4-pro"]);
    // 列表来自 origin 根,聊天仍走 {base}/v1/messages:suggestedBase 必须为空
    expect(out.suggestedBase).toBeNull();
  });

  it("DeepSeek 桥(带 /v1 式):同样直打 origin 根,版本段不禁用白名单", async () => {
    const q = fetchQueue([jsonRes({ data: [{ id: "m" }] })]);
    vi.mocked(fetch).mockImplementation(q.fn as typeof fetch);
    const out = await fetchModels(
      "https://api.deepseek.com/anthropic/v1",
      "k",
      undefined,
      "anthropic-messages",
    );
    expect(q.calls.length).toBe(1);
    expect(q.calls[0].url).toBe("https://api.deepseek.com/models");
    expect(out.suggestedBase).toBeNull();
  });

  it("白名单候选失败仍回退通用链:suggestedBase 恢复给出(OpenAI 根列表不适用于聊天)", async () => {
    const q = fetchQueue([
      jsonRes({}, 404), // origin/models(白名单直打)
      jsonRes({}, 404), // {base}/models
      jsonRes({ data: [{ id: "m" }] }), // {base}/v1/models
    ]);
    vi.mocked(fetch).mockImplementation(q.fn as typeof fetch);
    const out = await fetchModels(
      "https://api.deepseek.com/anthropic",
      "k",
      undefined,
      "anthropic-messages",
    );
    expect(q.calls.map((c) => c.url)).toEqual([
      "https://api.deepseek.com/models",
      "https://api.deepseek.com/anthropic/models?limit=1000",
      "https://api.deepseek.com/anthropic/v1/models?limit=1000",
    ]);
    expect(out.ids).toEqual(["m"]);
    expect(out.suggestedBase).toBe("https://api.deepseek.com/anthropic/v1");
  });

  it("Kimi 平台线桥:直打 OpenAI 线 /v1/models", async () => {
    const q = fetchQueue([jsonRes({ data: [{ id: "kimi-k3" }] })]);
    vi.mocked(fetch).mockImplementation(q.fn as typeof fetch);
    const out = await fetchModels(
      "https://api.moonshot.cn/anthropic",
      "k",
      undefined,
      "anthropic-messages",
    );
    expect(q.calls.length).toBe(1);
    expect(q.calls[0].url).toBe("https://api.moonshot.cn/v1/models");
    expect(out.ids).toEqual(["kimi-k3"]);
  });
});

describe("未知桥的通用兜底:同 origin 根探测(仅 anthropic 格式)", () => {
  it("base 两候选都 404 后,推进 origin 根两候选;origin 命中不给 suggestedBase", async () => {
    const q = fetchQueue([
      jsonRes({}, 404), // {base}/models
      jsonRes({}, 404), // {base}/v1/models
      jsonRes({}, 404), // {origin}/models
      jsonRes({ data: [{ id: "m" }] }), // {origin}/v1/models
    ]);
    vi.mocked(fetch).mockImplementation(q.fn as typeof fetch);
    const out = await fetchModels(
      "https://bridge.example.net/anthropic",
      "k",
      undefined,
      "anthropic-messages",
    );
    expect(q.calls.map((c) => c.url)).toEqual([
      "https://bridge.example.net/anthropic/models?limit=1000",
      "https://bridge.example.net/anthropic/v1/models?limit=1000",
      "https://bridge.example.net/models",
      "https://bridge.example.net/v1/models",
    ]);
    expect(out.ids).toEqual(["m"]);
    expect(out.suggestedBase).toBeNull();
  });

  it("origin 根探测是猜测:401 不中止整链(不冒充电报认证失败),继续走完", async () => {
    const q = fetchQueue([
      jsonRes({}, 404),
      jsonRes({}, 404),
      jsonRes({}, 401), // {origin}/models 要鉴权(同 key 不同路由的权限差异)
      jsonRes({ data: [{ id: "m" }] }),
    ]);
    vi.mocked(fetch).mockImplementation(q.fn as typeof fetch);
    const out = await fetchModels(
      "https://bridge.example.net/anthropic",
      "k",
      undefined,
      "anthropic-messages",
    );
    expect(q.calls.length).toBe(4);
    expect(out.ids).toEqual(["m"]);
  });

  it("chat-completions 格式不做 origin 根探测(OpenAI 生态无此约定)", async () => {
    const q = fetchQueue([jsonRes({}, 404)]);
    vi.mocked(fetch).mockImplementation(q.fn as typeof fetch);
    await errOf(fetchModels("https://gate.example.com/relay", "k"));
    expect(q.calls.length).toBe(2);
    expect(q.calls[1].url).toBe("https://gate.example.com/relay/v1/models");
  });

  it("base 解析不出 origin(手填裸串):白名单与 origin 探测静默缺席,不崩", async () => {
    const q = fetchQueue([jsonRes({}, 404)]);
    vi.mocked(fetch).mockImplementation(q.fn as typeof fetch);
    expect(
      await codeOf(
        fetchModels("not-a-url", "k", undefined, "anthropic-messages"),
      ),
    ).toBe("missing");
    expect(q.calls.map((c) => c.url)).toEqual([
      "not-a-url/models?limit=1000",
      "not-a-url/v1/models?limit=1000",
    ]);
  });
});

describe("anthropic-messages 协议", () => {
  it("双认证头 + limit=1000;has_more 经 after_id 翻页拉全", async () => {
    const q = fetchQueue([
      jsonRes({ data: [{ id: "b" }, { id: "a" }], has_more: true, last_id: "a" }),
      jsonRes({ data: [{ id: "c" }], has_more: false }),
    ]);
    vi.mocked(fetch).mockImplementation(q.fn as typeof fetch);
    const out = await fetchModels(
      "https://api.anthropic.com/v1", // i18n-ok:wire 端点常量,与字典占位符同文非 UI 断言
      "sk-ant",
      undefined,
      "anthropic-messages",
    );
    expect(q.calls[0].url).toBe("https://api.anthropic.com/v1/models?limit=1000");
    expect(q.calls[1].url).toBe(
      "https://api.anthropic.com/v1/models?limit=1000&after_id=a",
    );
    const h = q.calls[0].headers;
    expect(h.get("x-api-key")).toBe("sk-ant");
    expect(h.get("anthropic-version")).toBe("2023-06-01");
    expect(h.get("authorization")).toBe("Bearer sk-ant");
    expect(out.ids).toEqual(["a", "b", "c"]);
    expect(out.suggestedBase).toBeNull();
  });

  it("anthropic 根地址(桥式 base)同样走候选回退", async () => {
    const q = fetchQueue([
      jsonRes({}, 404),
      jsonRes({ data: [{ id: "minimax-m2" }] }),
    ]);
    vi.mocked(fetch).mockImplementation(q.fn as typeof fetch);
    const out = await fetchModels(
      "https://api.minimax.io/anthropic",
      "k",
      undefined,
      "anthropic-messages",
    );
    expect(q.calls.map((c) => c.url)).toEqual([
      "https://api.minimax.io/anthropic/models?limit=1000",
      "https://api.minimax.io/anthropic/v1/models?limit=1000",
    ]);
    expect(out.ids).toEqual(["minimax-m2"]);
    expect(out.suggestedBase).toBe("https://api.minimax.io/anthropic/v1");
  });

  it("has_more 永真:翻页在硬上限封顶(1 + 3 页),不无限打", async () => {
    const q = fetchQueue([
      jsonRes({ data: [{ id: "x" }], has_more: true, last_id: "x" }),
    ]);
    vi.mocked(fetch).mockImplementation(q.fn as typeof fetch);
    const out = await fetchModels(
      "https://api.anthropic.com/v1", // i18n-ok:wire 端点常量,与字典占位符同文非 UI 断言
      "k",
      undefined,
      "anthropic-messages",
    );
    expect(q.calls.length).toBe(4);
    expect(q.calls[3].url).toBe(
      "https://api.anthropic.com/v1/models?limit=1000&after_id=x",
    );
    expect(out.ids).toEqual(["x"]);
  });

  it("has_more 为真但无 last_id:不再翻页", async () => {
    const q = fetchQueue([jsonRes({ data: [{ id: "y" }], has_more: true })]);
    vi.mocked(fetch).mockImplementation(q.fn as typeof fetch);
    await fetchModels(
      "https://api.anthropic.com/v1", // i18n-ok:wire 端点常量,与字典占位符同文非 UI 断言
      "k",
      undefined,
      "anthropic-messages",
    );
    expect(q.calls.length).toBe(1);
  });
});
