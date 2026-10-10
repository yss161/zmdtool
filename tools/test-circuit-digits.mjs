// 电路截图识别回归：数字显示模式（行列目标渲染为数字字符，无计数方块条）
// 样例 tools/vision-dev/digit-sample.png：5×5，列目标 [3,5,5,5,3]、行目标 [3,5,5,5,3]，锁定格 (2,2)
import fs from "node:fs";
import { PNG } from "pngjs";
import { analyzeCircuitScreenshot } from "../public/js/circuit-vision.js";

const png = PNG.sync.read(fs.readFileSync(new URL("./vision-dev/digit-sample.png", import.meta.url)));
const img = { width: png.width, height: png.height, data: png.data };
const presets = JSON.parse(fs.readFileSync(new URL("../public/data/circuit-presets.json", import.meta.url), "utf8"));
const catalog = JSON.parse(fs.readFileSync(new URL("../public/data/circuit-config.json", import.meta.url), "utf8"));

let pass = 0, fail = 0;
const expect = (cond, name, extra) => {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, extra !== undefined ? JSON.stringify(extra) : ""); }
};

const res = analyzeCircuitScreenshot(img, presets, { catalog, debug: true });
console.log("识别结果:", JSON.stringify({ ok: res.ok, reason: res.reason, rows: res.rows, cols: res.cols, type2: res.type2, match: res.match, warnings: res.warnings }));
if (res.debug) console.log("调试:", JSON.stringify({ digitMode: res.debug.digitMode, weak: res.debug.weakDigits, trace: res.debug.digitTrace, digitCols: res.debug.digitCols, digitRows: res.debug.digitRows }));
if (res.ok) console.log("rowT:", JSON.stringify(res.rowT), "colT:", JSON.stringify(res.colT));
expect(res.ok === true, "识别成功", res.reason);
if (!res.ok) { console.log(`\n通过 ${pass}/${pass + fail}`); process.exit(1); }
expect(res.rows === 5 && res.cols === 5, "棋盘 5×5", [res.rows, res.cols]);
expect(JSON.stringify(res.colT) === JSON.stringify([3, 5, 5, 5, 3]), "列目标 [3,5,5,5,3]", res.colT);
expect(JSON.stringify(res.rowT) === JSON.stringify([3, 5, 5, 5, 3]), "行目标 [3,5,5,5,3]", res.rowT);
expect(res.cells[2 * 5 + 2] === 2, "锁定格 (2,2) 识别为常亮", res.cells);
expect(res.debug && res.debug.digitMode === true, "走了数字模式路径");
// 托盘：十字×2 + Z 形×2（元件 id 按目录匹配）
const tray = res.components.map(c => c.id + "×" + c.count).sort().join(",");
console.log("托盘:", tray || "（未识别）");
expect(res.components.length > 0, "托盘元件识别", tray);
expect(res.warnings.every(w => !w.includes("置信度较低")), "无低置信度警告", res.warnings);

console.log(`\n通过 ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
