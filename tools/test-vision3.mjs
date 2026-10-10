// Node 回归：第三张样例（WL-A1006 游戏截图原图：7 格棋盘、库存 3×1 + 2×3 + 1×3）
// 验证"格子方块检测"主晶格来源：任意裁剪/缩放的截图都能正确对齐（回归"识别偏移"bug）
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { analyzeScreenshot } from "../public/js/vision.js";

const png = PNG.sync.read(readFileSync(new URL("./vision-dev/balloon-original.png", import.meta.url)));
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

const expectGrid = ["#####", "##..#", "#.#.#", "#...#", "#####"];
const nonzero = Object.keys(res.inventory).filter(k => res.inventory[k] > 0).sort();
let pass = grid.every((r, i) => r === expectGrid[i]);
if (!pass) console.log("MISMATCH grid:\n" + grid.join("\n"));
if (nonzero.join(",") !== "1,2,3") { pass = false; console.log("MISMATCH inventory families:", nonzero.join(",")); }
// 几何：方块检测的间距应约 55.6，原点约 (565, 94)
const g = res.geometry;
if (Math.abs(g.spacing - 55.63) > 2 || Math.abs(g.originX - 565) > 5 || Math.abs(g.originY - 93.8) > 5) {
  pass = false;
  console.log("MISMATCH geometry:", JSON.stringify(g));
}
console.log(pass ? "\nPASS ✓" : "\nFAIL ✗");
process.exit(pass ? 0 : 1);
