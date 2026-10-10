// 完整识别输出：tray-sample.png
import { PNG } from "pngjs";
import fs from "node:fs";
import { analyzeCircuitScreenshot } from "../../public/js/circuit-vision.js";

const png = PNG.sync.read(fs.readFileSync(new URL("./tray-sample.png", import.meta.url)));
const catalog = JSON.parse(fs.readFileSync(new URL("../../public/data/circuit-config.json", import.meta.url), "utf8"));
const presets = JSON.parse(fs.readFileSync(new URL("../../public/data/circuit-presets.json", import.meta.url), "utf8"));
const res = analyzeCircuitScreenshot({ width: png.width, height: png.height, data: png.data }, presets, { catalog, debug: true });
console.log(JSON.stringify({
  ok: res.ok, rows: res.rows, cols: res.cols, type2: res.type2,
  rowT: res.rowT, colT: res.colT,
  components: res.components, match: res.match,
  warnings: res.warnings,
  colGroups: res.debug.colGroups, rowGroups: res.debug.rowGroups,
  unitPitch: res.debug.unitPitch,
  diffs: res.debug.diffs,
  tally: res.debug.tally,
}, null, 1));
