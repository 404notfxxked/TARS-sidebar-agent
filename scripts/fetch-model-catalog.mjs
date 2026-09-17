// 模型能力目录刷新脚本:从 models.dev(MIT,https://models.dev)拉取社区
// 维护的模型目录,裁剪为 TARS 需要的字段,生成 public/model-catalog.json。
// 手动跑:pnpm catalog:refresh(提交生成的快照;运行时零网络依赖)。
// 快照消费方:src/shared/modelCatalog.ts(获取模型列表时预填推荐值,
// 三层能力判定之一:目录 → id 启发式 → 手动开关)。
// 同一裸 id 在多家供应商下重复且字段不一致时,canonical 供应商优先
// (官方目录比聚合站可信),其余按字母序先到先得,保证结果确定。

import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const SRC = "https://models.dev/api.json";
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public", "model-catalog.json");
const LICENSE = "MIT";

// 官方/一线供应商优先(字段冲突时先到先得)
const CANONICAL = [
  "openai", "anthropic", "google", "deepseek", "zhipuai", "moonshotai",
  "qwen", "xai", "groq", "mistral", "azure", "bedrock", "vertex",
];

const res = await fetch(SRC);
if (!res.ok) throw new Error(`fetch ${SRC} → HTTP ${res.status}`);
const data = await res.json();

const models = {};
const put = (id, entry) => {
  if (models[id] === undefined) models[id] = entry;
};
const pick = (p) => {
  for (const m of Object.values(p.models ?? {})) {
    if (typeof m?.id !== "string" || m.id === "") continue;
    const ctx = m?.limit?.context;
    const input = m?.modalities?.input;
    // reasoning_options 扁平化:toggle → "toggle",effort → 档位值逐个铺开;
    // budget_tokens 是连续区间,档位 UI 没法用,跳过(要用时回上游取)
    const ro = [];
    for (const opt of m?.reasoning_options ?? []) {
      if (opt?.type === "toggle") ro.push("toggle");
      else if (opt?.type === "effort" && Array.isArray(opt.values))
        for (const v of opt.values) if (typeof v === "string") ro.push(v);
    }
    put(m.id, {
      ...(Number.isFinite(ctx) && ctx > 0 ? { ctx } : {}),
      ...(typeof m?.reasoning === "boolean" ? { r: m.reasoning ? 1 : 0 } : {}),
      ...(Array.isArray(input) && input.includes("image") ? { v: 1 } : {}),
      ...(ro.length > 0 ? { ro } : {}),
    });
  }
};
for (const key of CANONICAL) if (data[key]) pick(data[key]);
for (const key of Object.keys(data).sort()) if (!CANONICAL.includes(key)) pick(data[key]);

// 全空条目(目录里只有描述没有可用字段)没有预填价值,丢掉
for (const id of Object.keys(models)) {
  if (Object.keys(models[id]).length === 0) delete models[id];
}

const out = {
  _meta: {
    source: SRC,
    repo: "https://github.com/sst/models.dev",
    license: LICENSE,
    generator: "scripts/fetch-model-catalog.mjs (pnpm catalog:refresh)",
    fetchedAt: new Date().toISOString().slice(0, 10),
    count: Object.keys(models).length,
  },
  models,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out));
const kb = Math.round(readFileSync(OUT).length / 1024);
console.log(`✅ ${out._meta.count} 个模型 → ${OUT}(${kb}KB)`);
