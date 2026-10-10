// 调试任意样例：node tools/debug-sample.mjs [文件路径]
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { analyzeScreenshot } from "../public/js/vision.js";

const file = process.argv[2] || "../test/sample2.png";
globalThis.__VISION_DEBUG = true;
const logs = [];
const orig = console.log;
console.log = (...a) => logs.push(a.map(x => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(" "));
const png = PNG.sync.read(readFileSync(new URL(file, import.meta.url)));
const res = analyzeScreenshot({ data: png.data, width: png.width, height: png.height }, {});
console.log = orig;
console.log(logs.filter(l => !l.includes("cell(")).join("\n"));
console.log("ok:", res.ok, res.reason || "");
if (res.ok) {
  for (let gy = 0; gy < 5; gy++) {
    let row = "";
    for (let gx = 0; gx < 5; gx++) {
      const c = res.board.cells.find(c => c.gx === gx && c.gy === gy);
      row += c.state === "balloon" ? String(c.value) : c.state === "fillable" ? "." : "#";
    }
    console.log(row);
  }
  console.log("inventory:", JSON.stringify(res.inventory));
  console.log("geometry:", JSON.stringify(res.geometry));
}
