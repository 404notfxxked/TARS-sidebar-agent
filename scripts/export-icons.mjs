// 把图标源 SVG 栅格化成 Chrome manifest 需要的 PNG(16/32/48/128)。
// 跑法:pnpm icons:export;源文件 public/icons/icon.svg(改图标后重跑本脚本)。
// omitBackground 让圆角外的四角保持透明。
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const svgPath = join(root, "public", "icons", "icon.svg");
const outDir = join(root, "public", "icons");
const sizes = [16, 32, 48, 128];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const size of sizes) {
  await page.setViewportSize({ width: size, height: size });
  await page.goto(`file://${svgPath}`);
  await page.screenshot({
    path: join(outDir, `icon-${size}.png`),
    omitBackground: true,
  });
  console.log(`icon-${size}.png`);
}
await browser.close();
