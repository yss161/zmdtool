// 用 headless Chrome 渲染 0-9 数字模板（多字体候选），浏览器内归一化 12×16，
// 与真实截图字符（3/5）比对选最佳字体 → 生成 digit-templates.json
import fs from "node:fs";
import { PNG } from "pngjs";

const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = list.find(t => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pend = new Map();
ws.onmessage = (ev) => {
  try { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } }
  catch (e) { console.error("消息解析失败:", e.message, String(ev.data).slice(0, 120)); }
};
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("页面异常: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
};

const FONTS = [
  ["Segoe UI", 400], ["Segoe UI", 600], ["Segoe UI", 700],
  ["Arial", 400], ["Arial", 700],
  ["Tahoma", 400], ["Tahoma", 700],
  ["Verdana", 400], ["Verdana", 700],
  ["Roboto", 400], ["Roboto", 500],
  ["Noto Sans", 400], ["Noto Sans", 700],
];
const DILATE = [0, 1, 2]; // 渲染后膨胀次数（模拟游戏字体的加粗笔画）

// 浏览器内渲染+裁剪+膨胀+归一化 12×16，返回位图串（每数字 16 行 × 12 字符的 "01"）
const NW = 12, NH = 16;
const rendered = await evalJs(`(async () => {
  const FONTS = ${JSON.stringify(FONTS)};
  const DILATE = ${JSON.stringify(DILATE)};
  const NW = ${NW}, NH = ${NH};
  const cv = document.createElement("canvas");
  cv.width = 200; cv.height = 200;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  const out = {};
  for (const [fam, w] of FONTS) for (const dil of DILATE) {
    const key = fam + ":" + w + ":" + dil;
    out[key] = {};
    for (const ch of "0123456789") {
      ctx.clearRect(0, 0, 200, 200);
      ctx.font = w + " " + 60 + 'px "' + fam + '"';
      ctx.fillStyle = "#000";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(ch, 50, 150);
      const d = ctx.getImageData(0, 0, 200, 200).data;
      let minx = 1e9, miny = 1e9, maxx = -1, maxy = -1;
      let bin = new Uint8Array(200 * 200);
      for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) {
        if (d[(y * 200 + x) * 4 + 3] > 100) { bin[y * 200 + x] = 1; if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
      }
      if (maxx < 0) { out[key][ch] = null; continue; }
      for (let k = 0; k < dil; k++) { // 3×3 膨胀
        const b2 = new Uint8Array(bin);
        for (let y = 1; y < 199; y++) for (let x = 1; x < 199; x++) {
          if (!bin[y * 200 + x] && (bin[y * 200 + x - 1] || bin[y * 200 + x + 1] || bin[(y - 1) * 200 + x] || bin[(y + 1) * 200 + x])) b2[y * 200 + x] = 1;
        }
        bin = b2; minx--; miny--; maxx++; maxy++;
      }
      const bw = maxx - minx + 1, bh = maxy - miny + 1;
      const rows = [];
      for (let ny = 0; ny < NH; ny++) {
        let s = "";
        for (let nx = 0; nx < NW; nx++) {
          const x0 = Math.floor(minx + nx * bw / NW), x1 = Math.ceil(minx + (nx + 1) * bw / NW);
          const y0 = Math.floor(miny + ny * bh / NH), y1 = Math.ceil(miny + (ny + 1) * bh / NH);
          let sum = 0, cnt = 0;
          for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { if (x >= 0 && y >= 0 && x < 200 && y < 200) { cnt++; sum += bin[y * 200 + x]; } }
          s += cnt && sum / cnt > 0.35 ? "1" : "0";
        }
        rows.push(s);
      }
      out[key][ch] = { bw, bh, rows };
    }
  }
  return out;
})()`);

// 真实字符（digit-sample.png 顶行列数字 3,5，绿色掩码同 vision.js）→ 同样归一化 12×16
const png = PNG.sync.read(fs.readFileSync(new URL("./digit-sample.png", import.meta.url)));
const W = png.width, D = png.data;
const green = new Uint8Array(W * png.height);
for (let i = 0, p = 0; i < W * png.height; i++, p += 4) {
  const r = D[p], g = D[p + 1], b = D[p + 2];
  if (g > 45 && g > r + 12 && g > b + 12) green[i] = 1;
}
function normReal(bb) {
  const rows = [];
  for (let ny = 0; ny < NH; ny++) {
    let s = "";
    for (let nx = 0; nx < NW; nx++) {
      const x0 = Math.floor(bb.minx + nx * (bb.maxx - bb.minx + 1) / NW), x1 = Math.ceil(bb.minx + (nx + 1) * (bb.maxx - bb.minx + 1) / NW);
      const y0 = Math.floor(bb.miny + ny * (bb.maxy - bb.miny + 1) / NH), y1 = Math.ceil(bb.miny + (ny + 1) * (bb.maxy - bb.miny + 1) / NH);
      let sum = 0, cnt = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { cnt++; sum += green[y * W + x]; }
      s += cnt && sum / cnt > 0.35 ? "1" : "0";
    }
    rows.push(s);
  }
  return rows;
}
const real3 = normReal({ minx: 208, miny: 128, maxx: 221, maxy: 146 });
const real5 = normReal({ minx: 294, miny: 128, maxx: 307, maxy: 146 });

function ncc(a, b) {
  let sab = 0, sa2 = 0, sb2 = 0;
  for (let y = 0; y < a.length; y++) for (let x = 0; x < a[0].length; x++) {
    sab += a[y][x] * b[y][x]; sa2 += a[y][x] * a[y][x]; sb2 += b[y][x] * b[y][x];
  }
  return sab / Math.sqrt(sa2 * sb2 || 1);
}

const report = [];
for (const [key, digits] of Object.entries(rendered)) {
  const s3 = digits["3"] ? ncc(real3, digits["3"].rows) : 0;
  const s5 = digits["5"] ? ncc(real5, digits["5"].rows) : 0;
  report.push({ key, s3: Math.round(s3 * 1000) / 1000, s5: Math.round(s5 * 1000) / 1000, avg: Math.round((s3 + s5) / 2 * 1000) / 1000 });
}
report.sort((a, b) => b.avg - a.avg);
console.table ? console.table(report) : console.log(report);

const best = report[0];
if (!best || best.avg < 0.75) { console.log("最佳字体匹配度过低，需人工检查"); }
fs.writeFileSync(new URL("./digit-templates.json", import.meta.url), JSON.stringify({
  font: best.key, size: [NW, NH], digits: rendered[best.key],
  // 真实样本一并记录（用于未来回归）
  realSample: { "3": real3, "5": real5 },
}, null, 1));
console.log("最佳字体:", best.key, "avg=", best.avg, "→ 已保存 digit-templates.json");
process.exit(0);
