// evals 运行环境:REAL 模式的 env 读取校验、真端点配置种子、观测路由与
// 输出目录。定位与运行方式见 tests/README.md「evals」小节。
// 铁律:密钥只从环境变量读;任何输出(JSONL、报告、日志、异常文本)不得
// 包含 key 或 Authorization 头,baseUrl 只记 host;REAL 模式 env 不齐由
// runner 以退出码 2 报缺哪个。
//
// 配置种子的字段形状以 src/shared/configStore.ts 的 ProviderEntry /
// ModelEntry 为准:providers 数组一项(kind 缺省按 chat-completions 消费,
// 只在非缺省时写入),models 至少含 {id, contextTokens},vision 缺省 false。

import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

export const DEFAULT_CONTEXT_TOKENS = 128000;

/** 读 REAL 模式环境变量;缺失时返回 {missing: [名字]},由 runner 退出码 2 上报 */
export function readEvalEnv() {
  const baseUrl = process.env.EVALS_BASE_URL;
  const apiKey = process.env.EVALS_API_KEY;
  const model = process.env.EVALS_MODEL;
  const missing = [];
  if (!baseUrl) missing.push("EVALS_BASE_URL");
  if (!apiKey) missing.push("EVALS_API_KEY");
  if (!model) missing.push("EVALS_MODEL");
  if (missing.length > 0) return { missing };
  const kind = process.env.EVALS_KIND || "chat-completions";
  const contextTokens =
    Number(process.env.EVALS_CONTEXT_TOKENS) || DEFAULT_CONTEXT_TOKENS;
  let host = "";
  try {
    host = new URL(baseUrl).host;
  } catch {
    missing.push("EVALS_BASE_URL(不是合法 URL)");
    return { missing };
  }
  return { baseUrl, apiKey, model, kind, contextTokens, host };
}

/** 真端点配置种子(照 lib-cdp-mock seedProviders 的形状,但值来自 env);
 *  经 openPanel 的 configure 在面板页执行,reload 后生效 */
export function seedEvalProviders(page, env) {
  return page.evaluate(
    (cfg) =>
      chrome.storage.local.set({
        providers: [
          {
            id: "eval-prov",
            name: "Evals",
            baseUrl: cfg.baseUrl,
            apiKey: cfg.apiKey,
            ...(cfg.kind === "chat-completions" ? {} : { kind: cfg.kind }),
            models: [{ id: cfg.model, contextTokens: cfg.contextTokens }],
          },
        ],
        modelProvider: "eval-prov",
        model: cfg.model,
      }),
    {
      baseUrl: env.baseUrl,
      apiKey: env.apiKey,
      model: env.model,
      kind: env.kind,
      contextTokens: env.contextTokens,
    },
  );
}

/**
 * REAL 模式的 pass-through 观测路由:真实端点本可零路由自然放行(底座对
 * 未命中路由的请求一律 continueRequest),显式注册只为拿每轮请求的规模
 * 口径(messages 条数 / 整体字符数)——不存原文,只存计数(日志最小原文
 * 纪律)。anthropic-messages 协议的补全端点路径是 /messages,一并匹配。
 * requests:调用方传入的数组,每轮 run 一个,报告花费口径用。
 * EVALS_DEBUG=1 时向 stderr 打印每次命中的 host+path(不含 query 不含
 * body),诊断计数类异常(如同一请求被两层各拦一次的系统性 2×)。
 */
export function modelObservabilityRoute(requests) {
  return {
    match: (url) =>
      url.includes("/chat/completions") || /\/messages(?:\?|$)/.test(url),
    handle: async (ctx) => {
      if (process.env.EVALS_DEBUG === "1") {
        try {
          const u = new URL(ctx.params.request.url);
          const raw = ctx.params.request.postData ?? "";
          let msgs = -1;
          try {
            const b = JSON.parse(raw || "{}");
            msgs = Array.isArray(b.messages) ? b.messages.length : -1;
          } catch {
            /* 只打计数 */
          }
          const via = ctx.params.requestId ? "cdp" : "pw";
          console.error(
            `[evals-obs] t=${Date.now()} via=${via} ${ctx.params.request.method ?? "POST"} ${u.host}${u.pathname} query=${u.search ? "有" : "无"} msgs=${msgs} chars=${raw.length}`,
          );
        } catch {
          /* 诊断打点不影响放行 */
        }
      }
      // 只在 CDP Fetch 层计数(保留作双保险)。
      // 底座层归属确定性化(2026-10)后,pw 路由层对 SW 请求已让渡、不再查路由表,
      // 本守卫应永不触发;保留因为它零成本,且若 Playwright 未来版本再变
      // 拦截行为(重新对 SW 请求成对命中),计数仍不被系统性 2×。
      // LLM 请求全部经 SW 发起,CDP 层必然在场,按本层计数即 1:1。
      if (!ctx.params.requestId) {
        await ctx.pass();
        return;
      }
      try {
        const raw = ctx.params.request.postData ?? "";
        const body = JSON.parse(raw || "{}");
        requests.push({
          messages: Array.isArray(body.messages) ? body.messages.length : 0,
          chars: raw.length,
        });
      } catch {
        requests.push({ messages: -1, chars: -1 });
      }
      await ctx.pass();
    },
  };
}

/** 结果目录:tests/evals/output/(.gitignore 排除;JSONL 结果落这里) */
export function ensureOutputDir() {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "output");
  mkdirSync(dir, { recursive: true });
  return dir;
}
