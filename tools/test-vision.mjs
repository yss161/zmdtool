// Node 测试：对样例截图运行视觉识别，打印识别结果（浏览器外的回归测试）
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { analyzeScreenshot } from "../public/js/vision.js";

globalThis.__VISION_DEBUG = process.argv.includes("-v");

const file = process.argv[2] || new URL("../test/sample.png", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const png = PNG.sync.read(readFileSync(file));
const img = { data: png.data, width: png.width, height: png.height };

const t0 = performance.now();
const res = analyzeScreenshot(img, {});
const ms = (performance.now() - t0).toFixed(0);
console.log(`\n== analyzeScreenshot: ${file} (${png.width}x${png.height}) in ${ms}ms ==`);
console.log("ok:", res.ok, res.ok ? "" : res.reason);
if (!res.ok) process.exit(1);

console.log("geometry:", JSON.stringify(res.geometry));
const grid = [];
for (let gy = 0; gy < 5; gy++) {
  let row = "";
  for (let gx = 0; gx < 5; gx++) {
    const c = res.board.cells.find(c => c.gx === gx && c.gy === gy);
    row += c.state === "balloon" ? String(c.value) : c.state === "fillable" ? "." : "#";
  }
  grid.push(row);
}
console.log("board (. = 可放置空格, # = 禁用, 数字 = 已放气球):");
console.log(grid.join("\n"));
console.log("inventory:", JSON.stringify(res.inventory));
console.log("balloonsOnBoard:", JSON.stringify(res.balloonsOnBoard));
console.log("warnings:", res.warnings);

// 期望结果断言（样例截图）
const expect = {
  grid: [".....", ".###.", ".###.", ".###.", "....."],
  inventory: { 1: 3, 2: 3, 3: 3, 4: 0, 5: 0, 6: 3 },
};
let pass = true;
for (let i = 0; i < 5; i++) if (grid[i] !== expect.grid[i]) { pass = false; console.log(`MISMATCH row ${i}: got "${grid[i]}" want "${expect.grid[i]}"`); }
for (const k of [1, 2, 3, 6]) if (res.inventory[k] !== expect.inventory[k]) { pass = false; console.log(`MISMATCH inventory ${k}: got ${res.inventory[k]} want ${expect.inventory[k]}`); }
console.log(pass ? "\nPASS ✓" : "\nFAIL ✗");
process.exit(pass ? 0 : 1);
