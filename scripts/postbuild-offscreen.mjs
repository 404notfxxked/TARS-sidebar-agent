// 构建后整理:vite 的 HTML 入口产物镜像源码目录结构,
// 把 dist/src/offscreen/offscreen.html 移到 dist/ 根目录,
// 与 manifest/桥接代码约定的扩展根路径一致(offscreen.html 资源引用为
// 绝对路径 /assets/*,移动后不受影响)。
import { cpSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dist = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const nested = join(dist, "src", "offscreen", "offscreen.html");
const target = join(dist, "offscreen.html");

try {
  cpSync(nested, target);
  rmSync(join(dist, "src"), { recursive: true, force: true });
  console.log("[post-build] offscreen.html -> dist 根目录");
} catch {
  console.warn("[post-build] 未找到嵌套的 offscreen.html,跳过");
}
