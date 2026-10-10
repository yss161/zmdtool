// Node 回归：第二张样例（WL-A1006：不规则 7 格棋盘、库存 3×1 + 2×3 + 1×3、无 6 级气球）
// 注意：Node 里没有 canvas 字体 OCR，徽章数量会回落为默认 3 并产生警告；
// 数量 OCR 的正确性由浏览器端流程覆盖。这里断言棋盘几何与库存类别。
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { analyzeScreenshot } from "../public/js/vision.js";

const png = PNG.sync.read(readFileSync(new URL("../test/sample2.png", import.meta.url)));
const res = analyzeScreenshot({ data: png.data, width: png.width, height: png.height }, {});
console.log("ok:", res.ok, res.reason || "");
if (!res.ok) process.exit(1);

const grid = [];
for (let gy = 0; gy < 5; gy++) {
  let row = "";
  for (let gx = 0; gx < 5; gx++) {
    const c = res.board.cells.find(c => c.gx === gx && c.gy === gy);
    row += c.state === "balloon" ? String(c.value) : c.state === "fillable" ? "." : "#";
  }
  grid.push(row);
}
console.log(grid.join("\n"));
console.log("inventory:", JSON.stringify(res.inventory));
console.log("warnings:", res.warnings.length);

const expectGrid = ["#####", "##..#", "#.#.#", "#...#", "#####"];
const nonzero = Object.keys(res.inventory).filter(k => res.inventory[k] > 0).sort();
let pass = grid.every((r, i) => r === expectGrid[i]);
if (!pass) console.log("MISMATCH grid");
if (nonzero.join(",") !== "1,2,3") { pass = false; console.log("MISMATCH inventory families:", nonzero.join(",")); }
// 几何：间距应约 52-53，原点在左上角附近（方块检测重拟合后的原点与暖色投票法略有差异，放宽容差）
const g = res.geometry;
if (Math.abs(g.spacing - 53.16) > 2 || Math.abs(g.originX - 521) > 5 || Math.abs(g.originY - 99.5) > 5) {
  pass = false;
  console.log("MISMATCH geometry:", JSON.stringify(g));
}
console.log(pass ? "\nPASS ✓" : "\nFAIL ✗");
process.exit(pass ? 0 : 1);
