// 双色样例像素分析：列出绿/蓝连通域（bbox + n），按位置排序
import { PNG } from "pngjs";
import fs from "node:fs";

function analyze(file) {
  const png = PNG.sync.read(fs.readFileSync(new URL("./" + file, import.meta.url)));
  const W = png.width, H = png.height, D = png.data;
  const green = new Uint8Array(W * H), blue = new Uint8Array(W * H);
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    const r = D[p], g = D[p + 1], b = D[p + 2];
    if (g > 45 && g > r + 12 && g > b + 12) green[i] = 1;
    else if (b > 60 && b > r + 15 && b > g + 8) blue[i] = 1;
  }
  const C = 2;
  function comps(mask) {
    const gw = Math.ceil(W / C), gh = Math.ceil(H / C);
    const g = new Uint8Array(gw * gh);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (mask[y * W + x]) g[((y / C) | 0) * gw + ((x / C) | 0)] = 1;
    }
    const comp = new Int32Array(gw * gh).fill(-1);
    const out = [];
    for (let i = 0; i < gw * gh; i++) {
      if (!g[i] || comp[i] >= 0) continue;
      const q = [i]; comp[i] = out.length;
      const c = { n: 0, minx: 1e9, maxx: -1, miny: 1e9, maxy: -1 };
      while (q.length) {
        const j = q.pop(); const jx = j % gw, jy = (j / gw) | 0;
        c.n++;
        if (jx * C < c.minx) c.minx = jx * C;
        if ((jx + 1) * C > c.maxx) c.maxx = (jx + 1) * C;
        if (jy * C < c.miny) c.miny = jy * C;
        if ((jy + 1) * C > c.maxy) c.maxy = (jy + 1) * C;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = jx + dx, ny = jy + dy;
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
          const k = ny * gw + nx;
          if (g[k] && comp[k] < 0) { comp[k] = out.length; q.push(k); }
        }
      }
      if (c.n >= 4) out.push(c);
    }
    return out;
  }
  console.log("\n=====", file, W + "x" + H, "=====");
  for (const [name, mask] of [["GREEN", green], ["BLUE", blue]]) {
    const cs = comps(mask).sort((a, b) => a.miny - b.miny || a.minx - b.minx);
    console.log(name, cs.length, "个:");
    for (const c of cs) {
      const w = c.maxx - c.minx + 1, h = c.maxy - c.miny + 1;
      console.log(`  [${c.minx},${c.miny}..${c.maxx},${c.maxy}] ${w}x${h} n=${c.n} c=(${((c.minx + c.maxx) / 2) | 0},${((c.miny + c.maxy) / 2) | 0})`);
    }
  }
}
analyze("type2-bar-sample.png");
analyze("type2-digit-sample.png");
