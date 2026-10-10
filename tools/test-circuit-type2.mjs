// 电路截图识别回归：双色（type2）模式
// bar 样例：7×5，绿 [2,1,4,1,2]/[0,0,0,1,1,3,5]、蓝 [3,3,3,3,3]/[3,5,5,2,0,0,0]，2 个禁用格
// digit 样例：7×5 数字模式双色，目标同上
import fs from "node:fs";
import { PNG } from "pngjs";
import { analyzeCircuitScreenshot } from "../public/js/circuit-vision.js";

const presets = JSON.parse(fs.readFileSync(new URL("../public/data/circuit-presets.json", import.meta.url), "utf8"));
const catalog = JSON.parse(fs.readFileSync(new URL("../public/data/circuit-config.json", import.meta.url), "utf8"));

let pass = 0, fail = 0;
const expect = (cond, name, extra) => {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, extra !== undefined ? JSON.stringify(extra) : ""); }
};
const load = (f) => {
  const png = PNG.sync.read(fs.readFileSync(new URL("./vision-dev/" + f, import.meta.url)));
  return analyzeCircuitScreenshot({ width: png.width, height: png.height, data: png.data }, presets, { catalog, debug: true });
};

// ---- bar 双色 ----
const bar = load("type2-bar-sample.png");
console.log("bar 双色:", JSON.stringify({ ok: bar.ok, rows: bar.rows, cols: bar.cols, type2: bar.type2, warnings: bar.warnings }));
expect(bar.ok, "bar 双色识别成功", bar.reason);
if (bar.ok) {
  expect(bar.rows === 7 && bar.cols === 5, "棋盘 7×5", [bar.rows, bar.cols]);
  expect(bar.type2 === true, "双色模式", bar.type2);
  expect(JSON.stringify(bar.colT) === JSON.stringify([2, 1, 4, 1, 2]), "绿列 [2,1,4,1,2]", bar.colT);
  expect(JSON.stringify(bar.rowT) === JSON.stringify([0, 0, 0, 1, 1, 3, 5]), "绿行 [0,0,0,1,1,3,5]", bar.rowT);
  expect(JSON.stringify(bar.col2T) === JSON.stringify([3, 3, 3, 3, 3]), "蓝列 [3,3,3,3,3]", bar.col2T);
  expect(JSON.stringify(bar.row2T) === JSON.stringify([3, 5, 5, 2, 0, 0, 0]), "蓝行 [3,5,5,2,0,0,0]", bar.row2T);
  expect(bar.cells.filter(s => s === 1).length === 2, "2 个禁用格", bar.cells);
  expect(bar.warnings.every(w => !w.includes("置信度") && !w.includes("总和")), "行列目标识别无警告", bar.warnings);
}

// ---- digit 双色 ----
const dig = load("type2-digit-sample.png");
console.log("digit 双色:", JSON.stringify({ ok: dig.ok, rows: dig.rows, cols: dig.cols, type2: dig.type2, warnings: dig.warnings }));
expect(dig.ok, "digit 双色识别成功", dig.reason);
if (dig.ok) {
  expect(dig.rows === 7 && dig.cols === 5, "棋盘 7×5", [dig.rows, dig.cols]);
  expect(dig.type2 === true, "双色模式", dig.type2);
  expect(JSON.stringify(dig.colT) === JSON.stringify([2, 1, 4, 1, 2]), "绿列 [2,1,4,1,2]", dig.colT);
  expect(JSON.stringify(dig.rowT) === JSON.stringify([0, 0, 0, 1, 1, 3, 5]), "绿行 [0,0,0,1,1,3,5]", dig.rowT);
  expect(JSON.stringify(dig.col2T) === JSON.stringify([3, 3, 3, 3, 3]), "蓝列 [3,3,3,3,3]", dig.col2T);
  expect(JSON.stringify(dig.row2T) === JSON.stringify([3, 5, 5, 2, 0, 0, 0]), "蓝行 [3,5,5,2,0,0,0]", dig.row2T);
  expect(dig.debug && dig.debug.digitMode === true, "走了数字模式路径");
}

// ---- digit 双色样例 2（5×5，绿顶第 1/5 列 0 无字符渲染 → 就近吸附配对补 0）----
const dig2 = load("type2-digit-sample2.png");
console.log("digit 双色 2:", JSON.stringify({ ok: dig2.ok, rows: dig2.rows, cols: dig2.cols, type2: dig2.type2, warnings: dig2.warnings }));
expect(dig2.ok, "digit 双色 2 识别成功", dig2.reason);
if (dig2.ok) {
  expect(dig2.rows === 5 && dig2.cols === 5, "棋盘 5×5", [dig2.rows, dig2.cols]);
  expect(dig2.type2 === true, "双色模式（缺位配对）", dig2.type2);
  expect(JSON.stringify(dig2.col2T) === JSON.stringify([0, 1, 2, 2, 4]), "蓝列 [0,1,2,2,4]", dig2.col2T);
  expect(JSON.stringify(dig2.row2T) === JSON.stringify([2, 2, 2, 1, 2]), "蓝行 [2,2,2,1,2]", dig2.row2T);
  expect(dig2.cells.filter(s => s === 1).length === 2, "2 个禁用格", dig2.cells);
}
expect(dig.ok, "digit 双色识别成功", dig.reason);
if (dig.ok) {
  expect(dig.rows === 7 && dig.cols === 5, "棋盘 7×5", [dig.rows, dig.cols]);
  expect(dig.type2 === true, "双色模式", dig.type2);
  expect(JSON.stringify(dig.colT) === JSON.stringify([2, 1, 4, 1, 2]), "绿列 [2,1,4,1,2]", dig.colT);
  expect(JSON.stringify(dig.rowT) === JSON.stringify([0, 0, 0, 1, 1, 3, 5]), "绿行 [0,0,0,1,1,3,5]", dig.rowT);
  expect(JSON.stringify(dig.col2T) === JSON.stringify([3, 3, 3, 3, 3]), "蓝列 [3,3,3,3,3]", dig.col2T);
  expect(JSON.stringify(dig.row2T) === JSON.stringify([3, 5, 5, 2, 0, 0, 0]), "蓝行 [3,5,5,2,0,0,0]", dig.row2T);
  expect(dig.debug && dig.debug.digitMode === true, "走了数字模式路径");
}

console.log(`\n通过 ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
