// 电路截图识别回归：用真实游戏截图（Δ-V40020）验证识别结果
import fs from "node:fs";
import { PNG } from "pngjs";
import { analyzeCircuitScreenshot } from "../public/js/circuit-vision.js";

const png = PNG.sync.read(fs.readFileSync(new URL("./vision-dev/game-sample.png", import.meta.url)));
const img = { width: png.width, height: png.height, data: png.data };
const presets = JSON.parse(fs.readFileSync(new URL("../public/data/circuit-presets.json", import.meta.url), "utf8"));

let pass = 0, fail = 0;
const expect = (cond, name, extra) => {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, extra !== undefined ? JSON.stringify(extra) : ""); }
};

const res = analyzeCircuitScreenshot(img, presets, { debug: true });
console.log("识别结果:", JSON.stringify({ ok: res.ok, reason: res.reason, rows: res.rows, cols: res.cols, type2: res.type2, match: res.match, warnings: res.warnings }));
if (res.debug) console.log("调试:", JSON.stringify(res.debug));
expect(res.ok === true, "识别成功", res.reason);
if (!res.ok) { console.log(`\n通过 ${pass}/${pass + fail}`); process.exit(1); }
expect(res.rows === 5 && res.cols === 5, "棋盘 5×5", [res.rows, res.cols]);
expect(res.type2 === false, "单色模式");
expect(JSON.stringify(res.colT) === JSON.stringify([4, 4, 4, 4, 2]), "列目标 [4,4,4,4,2]", res.colT);
expect(JSON.stringify(res.rowT) === JSON.stringify([4, 5, 5, 4, 0]), "行目标 [4,5,5,4,0]", res.rowT);
expect(res.cells[4 * 5 + 0] === 1 && res.cells[4 * 5 + 2] === 1, "禁用格 (4,0)/(4,2)", res.cells);
expect(res.cells.filter(s => s === 1).length === 2, "恰好 2 个禁用格");
expect(res.match && res.match.key === "V4_BOT_0020", "匹配预设 V40020", res.match);

// ---- 样例 2：Δ-V40051（1920×1080 全屏截图，部分计数条过暗——网格补全 + 溢出/低阈值读数）----
const png2 = PNG.sync.read(fs.readFileSync(new URL("./vision-dev/mono-bar-sample.png", import.meta.url)));
const res2 = analyzeCircuitScreenshot({ width: png2.width, height: png2.height, data: png2.data }, presets, { catalog: JSON.parse(fs.readFileSync(new URL("../public/data/circuit-config.json", import.meta.url), "utf8")) });
console.log("样例2:", JSON.stringify({ ok: res2.ok, rows: res2.rows, cols: res2.cols, rowT: res2.rowT, colT: res2.colT, components: res2.components?.map(c => c.id + "x" + c.count) }));
expect(res2.ok && res2.rows === 5 && res2.cols === 5, "样例2 棋盘 5×5", [res2.rows, res2.cols]);
expect(JSON.stringify(res2.rowT) === JSON.stringify([5, 2, 2, 2, 5]), "样例2 行目标 [5,2,2,2,5]", res2.rowT);
expect(JSON.stringify(res2.colT) === JSON.stringify([5, 2, 2, 2, 5]), "样例2 列目标 [5,2,2,2,5]", res2.colT);
expect(res2.components?.map(c => c.id + "x" + c.count).join(",") === "23lshapex4", "样例2 托盘 23lshape×4", res2.components);
expect(res2.cells.filter(s => s === 1).length === 4, "样例2 恰好 4 个禁用格", res2.cells?.filter(s => s === 1).length);

// ---- 样例 3：Δ-V40054（空心描边方块条 + 棋盘装饰线污染 + 缺列，行/列解耦联合择优）----
const png3 = PNG.sync.read(fs.readFileSync(new URL("./vision-dev/mono-bar2-sample.png", import.meta.url)));
const res3 = analyzeCircuitScreenshot({ width: png3.width, height: png3.height, data: png3.data }, presets, { catalog: JSON.parse(fs.readFileSync(new URL("../public/data/circuit-config.json", import.meta.url), "utf8")) });
console.log("样例3:", JSON.stringify({ ok: res3.ok, rows: res3.rows, cols: res3.cols, rowT: res3.rowT, colT: res3.colT, components: res3.components?.map(c => c.id + "x" + c.count) }));
expect(res3.ok && res3.rows === 5 && res3.cols === 5, "样例3 棋盘 5×5", [res3.rows, res3.cols]);
expect(JSON.stringify(res3.rowT) === JSON.stringify([4, 5, 3, 2, 1]), "样例3 行目标 [4,5,3,2,1]", res3.rowT);
expect(JSON.stringify(res3.colT) === JSON.stringify([4, 5, 3, 2, 1]), "样例3 列目标 [4,5,3,2,1]", res3.colT);
expect(res3.components?.map(c => c.id + "x" + c.count).join(",") === "33crossx1,23zshapex1,23sshapex1", "样例3 托盘元件", res3.components);
expect(res3.cells.filter(s => s === 1).length === 2 && res3.cells.filter(s => s === 2).length === 2, "样例3 2 禁用格 + 2 锁定格", res3.cells);

// ---- 样例 4：Δ-V40054 模块 2/3（行首条 jpg 桥接成整块 + 顶部条碎化 + 缺列）----
const png4 = PNG.sync.read(fs.readFileSync(new URL("./vision-dev/mono-bar3-sample.png", import.meta.url)));
const res4 = analyzeCircuitScreenshot({ width: png4.width, height: png4.height, data: png4.data }, presets, { catalog: JSON.parse(fs.readFileSync(new URL("../public/data/circuit-config.json", import.meta.url), "utf8")) });
console.log("样例4:", JSON.stringify({ ok: res4.ok, rows: res4.rows, cols: res4.cols, rowT: res4.rowT, colT: res4.colT, components: res4.components?.map(c => c.id + "x" + c.count) }));
expect(res4.ok && res4.rows === 5 && res4.cols === 5, "样例4 棋盘 5×5", [res4.rows, res4.cols]);
expect(JSON.stringify(res4.rowT) === JSON.stringify([4, 5, 3, 2, 1]), "样例4 行目标 [4,5,3,2,1]", res4.rowT);
expect(JSON.stringify(res4.colT) === JSON.stringify([4, 5, 3, 2, 1]), "样例4 列目标 [4,5,3,2,1]", res4.colT);
expect(res4.components?.map(c => c.id + "x" + c.count).join(",") === "23lshapex3", "样例4 托盘 23lshape×3", res4.components);
expect(res4.cells.filter(s => s === 1).length === 2 && res4.cells.filter(s => s === 2).length === 3, "样例4 2 禁用格 + 3 锁定格", res4.cells);

// ---- 样例 5：Δ-V40054 模块 3/3（列 3/5 极淡条每行 <3 像素 + 顶部竖碎混行组）----
const png5 = PNG.sync.read(fs.readFileSync(new URL("./vision-dev/mono-bar5-sample.png", import.meta.url)));
const res5 = analyzeCircuitScreenshot({ width: png5.width, height: png5.height, data: png5.data }, presets, { catalog: JSON.parse(fs.readFileSync(new URL("../public/data/circuit-config.json", import.meta.url), "utf8")) });
console.log("样例5:", JSON.stringify({ ok: res5.ok, rows: res5.rows, cols: res5.cols, rowT: res5.rowT, colT: res5.colT, components: res5.components?.map(c => c.id + "x" + c.count) }));
expect(res5.ok && res5.rows === 5 && res5.cols === 5, "样例5 棋盘 5×5", [res5.rows, res5.cols]);
expect(JSON.stringify(res5.rowT) === JSON.stringify([4, 5, 3, 2, 1]), "样例5 行目标 [4,5,3,2,1]", res5.rowT);
expect(JSON.stringify(res5.colT) === JSON.stringify([4, 5, 3, 2, 1]), "样例5 列目标 [4,5,3,2,1]", res5.colT);
expect(res5.components?.reduce((s, c) => s + c.count + (c.count2 || 0), 0) === 4, "样例5 托盘 4 个元件", res5.components);
expect(res5.cells.filter(s => s === 1).length === 2 && res5.cells.filter(s => s === 2).length === 0, "样例5 2 禁用格（右下对角）", res5.cells);

// ---- 样例 6：Δ-V40054 模块 1/3（小图 1296px，黄绿条 g≈r 极低 b + 列组极少）----
const png6 = PNG.sync.read(fs.readFileSync(new URL("./vision-dev/mono-bar6-sample.png", import.meta.url)));
const res6 = analyzeCircuitScreenshot({ width: png6.width, height: png6.height, data: png6.data }, presets, { catalog: JSON.parse(fs.readFileSync(new URL("../public/data/circuit-config.json", import.meta.url), "utf8")) });
console.log("样例6:", JSON.stringify({ ok: res6.ok, rows: res6.rows, cols: res6.cols, rowT: res6.rowT, colT: res6.colT, components: res6.components?.map(c => c.id + "x" + c.count) }));
expect(res6.ok && res6.rows === 5 && res6.cols === 5, "样例6 棋盘 5×5", [res6.rows, res6.cols]);
expect(JSON.stringify(res6.rowT) === JSON.stringify([4, 5, 3, 2, 1]), "样例6 行目标 [4,5,3,2,1]", res6.rowT);
expect(JSON.stringify(res6.colT) === JSON.stringify([4, 5, 3, 2, 1]), "样例6 列目标 [4,5,3,2,1]", res6.colT);
expect(res6.components?.map(c => c.id + "x" + c.count).join(",") === "23lshapex3", "样例6 托盘 23lshape×3", res6.components);
expect(res6.cells.filter(s => s === 1).length === 2 && res6.cells.filter(s => s === 2).length === 3, "样例6 2 禁用格 + 3 锁定格", res6.cells);

console.log(`\n通过 ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
