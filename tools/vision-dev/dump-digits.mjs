// 实验：数字模式截图的字符提取——打印所有绿色连通域与字符形状
import { PNG } from "pngjs";
import fs from "node:fs";
import { analyzeCircuitScreenshot } from "../../public/js/circuit-vision.js";

const png = PNG.sync.read(fs.readFileSync(new URL("./digit-sample.png", import.meta.url)));
const W = png.width, H = png.height, D = png.data;
console.log("尺寸:", W, "x", H);

// 复制 makeMasks 逻辑（与 vision.js 相同）
const n = W * H;
const green = new Uint8Array(n);
for (let i = 0, p = 0; i < n; i++, p += 4) {
  const r = D[p], g = D[p + 1], b = D[p + 2];
  if (g > 45 && g > r + 12 && g > b + 12) green[i] = 1;
}

// 连通域（C=1 全精度，字符分析用）
function compsFull(mask) {
  const comp = new Int32Array(W * H).fill(-1);
  const out = [];
  for (let i = 0; i < W * H; i++) {
    if (!mask[i] || comp[i] >= 0) continue;
    const q = [i]; comp[i] = out.length;
    const c = { n: 0, minx: 1e9, maxx: -1, miny: 1e9, maxy: -1, pix: [] };
    while (q.length) {
      const j = q.pop(); const jx = j % W, jy = (j / W) | 0;
      c.n++;
      if (jx < c.minx) c.minx = jx; if (jx > c.maxx) c.maxx = jx;
      if (jy < c.miny) c.miny = jy; if (jy > c.maxy) c.maxy = jy;
      c.pix.push(j);
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = jx + dx, ny = jy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const k = ny * W + nx;
        if (mask[k] && comp[k] < 0) { comp[k] = out.length; q.push(k); }
      }
    }
    out.push(c);
  }
  return out;
}

const all = compsFull(green).filter(c => c.n >= 6);
console.log("绿色连通域数:", all.length);
for (const c of all.sort((a, b) => a.miny - b.miny || a.minx - b.minx)) {
  const w = c.maxx - c.minx + 1, h = c.maxy - c.miny + 1;
  console.log(`bbox=[${c.minx},${c.miny}..${c.maxx},${c.maxy}] ${w}x${h} n=${c.n}`);
}

// ASCII art：打印字符大小的连通域（w<40 且 h<40）
console.log("\n--- 字符形状 ---");
for (const c of all) {
  const w = c.maxx - c.minx + 1, h = c.maxy - c.miny + 1;
  if (w > 40 || h > 40) continue;
  const set = new Set(c.pix);
  console.log(`\n[${c.minx},${c.miny}] ${w}x${h} n=${c.n}`);
  for (let y = c.miny; y <= c.maxy; y++) {
    let row = "";
    for (let x = c.minx; x <= c.maxx; x++) row += set.has(y * W + x) ? "#" : ".";
    console.log(row);
  }
}
