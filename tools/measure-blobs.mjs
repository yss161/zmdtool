// 打印样例的暖色块（通用测量工具）：node tools/measure-blobs.mjs [文件]
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";

const file = process.argv[2] || "../test/sample3.png";
const png = PNG.sync.read(readFileSync(new URL(file, import.meta.url)));
const { width: W, height: H, data } = png;
console.log("image", W, "x", H);

const warm = new Uint8Array(W * H);
for (let p = 0, i = 0; p < W * H; p++, i += 4) {
  const r = data[i], g = data[i + 1], b = data[i + 2];
  if (r > 100 && r - b > 45 && g - b > 30) warm[p] = 1;
}
const seen = new Uint8Array(W * H);
const blobs = [];
for (let p = 0; p < W * H; p++) {
  if (!warm[p] || seen[p]) continue;
  const stack = [p]; seen[p] = 1;
  let n = 0, sx = 0, sy = 0, x0 = W, y0 = H, x1 = 0, y1 = 0;
  while (stack.length) {
    const q = stack.pop();
    const x = q % W, y = (q / W) | 0;
    n++; sx += x; sy += y;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const np = ny * W + nx;
      if (warm[np] && !seen[np]) { seen[np] = 1; stack.push(np); }
    }
  }
  blobs.push({ cx: +(sx / n).toFixed(1), cy: +(sy / n).toFixed(1), w: x1 - x0 + 1, h: y1 - y0 + 1, area: n });
}
blobs.sort((a, b) => b.area - a.area);
for (const b of blobs) console.log(`(${b.cx},${b.cy}) ${b.w}x${b.h} area=${b.area}`);
