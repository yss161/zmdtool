// 源石电路截图识别：从游戏截图提取棋盘状态、行列目标与元件清单，直接求解（不依赖题库）。
// 识别目标（游戏"图形"显示模式）：
//   - 棋盘格：空 / 禁用(灰色斜纹⊘) / 绿色常亮 / 蓝色常亮
//   - 行列目标：棋盘上方/左侧的绿色(蓝色)计数段，数段即数字
//   - 元件托盘：右侧元件卡中的亮绿/蓝色形状 ↔ 元件目录匹配（旋转不变）
//   - 官方预设匹配仅作交叉校验（识别的元件与预设不一致时给出提示）
// 输入 data: { width, height, data(Uint8ClampedArray) }（ImageData 兼容）
// 输出 analyzeCircuitScreenshot: { ok, reason?, rows, cols, type2, cells, rowT, colT, row2T, col2T,
//   components: [{id, count, count2}], match: { key, name, score } | null, warnings: [], overlay: {...} }

import { rotationsOf } from "./circuit-solver.js";

// ---- 基础工具 ----
function makeMasks(D, W, H) {
  // 绿色（计数段/绿常亮/元件）：g 显著高于 r、b
  // 蓝色（蓝计数段/蓝常亮）：b 显著高于 r、g
  // 灰色（禁用格斜纹）：r≈g≈b，中等亮度
  // 绿溢出（gex）：g - max(r,b) > 4——对暗色计数条灵敏（全屏截图里部分计数条
  // 颜色很暗，低于绿色阈值，但其绿色溢出量仍显著高于背景 ~0）
  const n = W * H;
  const green = new Uint8Array(n), blue = new Uint8Array(n), gray = new Uint8Array(n), gex = new Uint8Array(n), glo = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = D[p], g = D[p + 1], b = D[p + 2];
    if (g > 45 && g > r + 12 && g > b + 12) green[i] = 1;
    else if (b > 60 && b > r + 15 && b > g + 8) blue[i] = 1;
    else if (r > 34 && r < 160 && Math.abs(r - g) < 16 && Math.abs(g - b) < 16) gray[i] = 1;
    if (g > 34 && g - Math.max(r, b) > 4) gex[i] = 1;
    // 低阈值绿（glo）：暗色/异色计数条——除了"g 高于 r、b"的普通暗绿条，还要覆盖
    // "黄绿条"（r≈g、b 极低，如全屏截图上更淡的计数条：实测 r=144 g=144 b=70，
    // g-r=0 但 g-b=74；背景 b≈g 不会误入）——用于暗条的投影读数与探针。
    if (g > 32 && g > r + 5 && g > b + 5) glo[i] = 1;
    else if (g > 30 && g - b > 12 && g > r - 60) glo[i] = 1;
  }
  return { green, blue, gray, gex, glo };
}

// 连通域（网格降采样加速）
function components(mask, W, H, cell) {
  const gw = Math.ceil(W / cell), gh = Math.ceil(H / cell);
  const g = new Uint8Array(gw * gh);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (mask[y * W + x]) g[((y / cell) | 0) * gw + ((x / cell) | 0)] = 1;
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
      if (jx * cell < c.minx) c.minx = jx * cell;
      if ((jx + 1) * cell > c.maxx) c.maxx = (jx + 1) * cell;
      if (jy * cell < c.miny) c.miny = jy * cell;
      if ((jy + 1) * cell > c.maxy) c.maxy = (jy + 1) * cell;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = jx + dx, ny = jy + dy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const k = ny * gw + nx;
        if (g[k] && comp[k] < 0) { comp[k] = out.length; q.push(k); }
      }
    }
    if (c.n >= 4) out.push(c); // 过滤噪点
  }
  return out;
}

// 一维投影分段计数：strip 内 mask 像素沿 axis 投影计数，按"峰值平台"分段
// （对 JPEG 噪声桥接和细小间隙都稳健：亮度/计数低于峰值 15% 视为段间空隙）
function countRuns(mask, W, H, x0, x1, y0, y1, axis) {
  const proj = [];
  if (axis === "y") {
    for (let y = y0; y < y1; y++) { let n = 0; for (let x = x0; x < x1; x++) { if (mask[y * W + x]) n++; } proj.push(n); }
  } else {
    for (let x = x0; x < x1; x++) { let n = 0; for (let y = y0; y < y1; y++) { if (mask[y * W + x]) n++; } proj.push(n); }
  }
  const mx = Math.max(...proj, 0);
  if (mx < 3) return 0;
  const th = Math.max(2, mx * 0.15);
  let runs = 0, inRun = false;
  for (const v of proj) {
    if (v >= th) { if (!inRun) { runs++; inRun = true; } }
    else inRun = false;
  }
  return runs;
}

function median(arr) { const a = [...arr].sort((x, y) => x - y); return a.length ? a[(a.length / 2) | 0] : 0; }

// 众数簇：值域 [×0.85, ×1.18] 内元素最多的簇的中位数 = 真实间距
// （真实间距的样本出现频次最高；半距 ~0.5× 与跨段 ~2× 的簇被排除；全并列时取最小簇）
function clusterMode(arr) {
  const a = [...arr].filter(v => v > 5).sort((x, y) => x - y);
  if (!a.length) return 0;
  let best = 0;
  for (let i = 0; i < a.length; i++) {
    const vals = a.filter(v => v >= a[i] * 0.85 && v <= a[i] * 1.18);
    if (vals.length > best) best = median(vals);
  }
  return best;
}

// 鲁棒间距估计：相邻差里排除明显是"跨格"的大值，取中位
function robustPitch(diffs) {
  const d = diffs.filter(x => x >= 30 && x <= 400);
  if (!d.length) return 0;
  const mn = Math.min(...d);
  const near = d.filter(x => x <= mn * 2.2);
  return median(near);
}

// ---- 主流程 ----
// ---- 托盘元件识别：元件卡形状 ↔ 目录匹配（旋转不变，连续 IoU 评分） ----
function recognizeTray(mask, W, H, blobs, catalog, debug) {
  // 每元件的格数（shape 为坐标对列表；去重防目录笔误重复点）
  const cellsOf = {};
  for (const [id, c] of Object.entries(catalog)) cellsOf[id] = new Set(c.shape.map(p => p.join(","))).size;
  const matched = [];
  const unmatched = [];
  for (const blob of blobs) {
    const Wb = blob.maxx - blob.minx + 1, Hb = blob.maxy - blob.miny + 1;
    let best = null;
    const top3 = [];
    for (const id of Object.keys(catalog)) {
      for (const cells of rotationsOf(catalog[id].shape)) {
        const sw = Math.max(...cells.map(p => p[1])) + 1;
        const sh = Math.max(...cells.map(p => p[0])) + 1;
        // 长宽比过滤
        if (Math.abs(Wb / Hb - sw / sh) > 0.18 * (sw / sh)) continue;
        const u = Wb / sw, uh = Hb / sh;
        if (Math.abs(u - uh) > u * 0.28) continue;
        const occupied = new Set(cells.map(([r, c]) => r + "," + c));
        // 连续 IoU：以 2px 步长采样，假设栅格 vs 实际掩码
        let inter = 0, union = 0;
        for (let y = blob.miny; y <= blob.maxy; y += 2) for (let x = blob.minx; x <= blob.maxx; x += 2) {
          const inBlob = mask[y * W + x] ? 1 : 0;
          const ci = Math.min(sw - 1, Math.max(0, Math.floor((x - blob.minx) / u)));
          const cj = Math.min(sh - 1, Math.max(0, Math.floor((y - blob.miny) / uh)));
          const inHyp = occupied.has(cj + "," + ci) ? 1 : 0;
          if (inBlob && inHyp) inter++;
          if (inBlob || inHyp) union++;
        }
        const iou = union ? inter / union : 0;
        if (!best || iou > best.iou) best = { id, iou };
        top3.push({ id, iou: Math.round(iou * 100) / 100, cells: cellsOf[id] });
      }
    }
    top3.sort((a, b) => b.iou - a.iou);
    // 候选去重（同 id 只留最高分；旋转体共享格数）
    const byId = new Map();
    for (const t of top3) if (!byId.has(t.id) && t.iou >= 0.5) byId.set(t.id, t);
    const cands = [...byId.values()].slice(0, 4);
    if (debug) debug.trayTop = (debug.trayTop || []).concat([[blob.minx, blob.miny], top3.slice(0, 3)]);
    if (best && best.iou >= 0.72) matched.push({ id: best.id, score: best.iou, cands });
    else unmatched.push({ bbox: [blob.minx, blob.miny, blob.maxx, blob.maxy], score: best ? Math.round(best.iou * 100) / 100 : 0 });
  }
  return { matched, unmatched };
}

// ---- 数字显示模式（游戏"数字"显示模式：行列目标直接渲染为数字字符）----

// 数字字符模板：headless Chrome 渲染 Arial:700+1px 膨胀 归一化 12×16
// （tools/vision-dev/gen-digit-templates.mjs 生成），r3/r5 为真实截图提取样本。匹配 = 归一化 NCC 取 argmax。
const DIGIT_TEMPLATES = {
  0: ["000111111000", "001111111100", "011111111110", "011111011111", "111110001111", "111110001111", "111100001111", "111100001111", "111100001111", "111100001111", "111110001111", "111110001111", "011111011111", "011111111110", "001111111100", "000011111000"],
  1: ["000000011111", "000000111111", "000011111111", "011111111111", "111111111111", "111111111111", "111111111111", "100000111111", "000000111111", "000000111111", "000000111111", "000000111111", "000000111111", "000000111111", "000000111111", "000000111111"],
  2: ["000111111100", "001111111110", "011111111111", "011111011111", "011110001111", "000000001111", "000000011111", "000000111110", "000001111110", "000011111000", "000111110000", "001111100000", "011111111111", "011111111111", "111111111111", "111111111111"],
  3: ["000111111000", "011111111100", "011111111110", "111110111110", "011100011110", "000000111110", "000011111100", "000011111100", "000001111110", "000000011111", "000000001111", "111100001111", "111110011111", "011111111110", "011111111100", "000111111000"],
  4: ["000000111100", "000000111100", "000001111100", "000011111100", "000011111100", "000111111100", "001111111100", "001110111100", "011110111100", "111111111111", "111111111111", "111111111111", "111111111111", "000000111100", "000000111100", "000000111100"],
  5: ["001111111110", "011111111110", "011111111110", "011111111110", "011110000000", "011111111000", "111111111100", "111111111110", "111110111111", "000000011111", "000000001111", "111100011111", "111110111111", "111111111110", "011111111100", "000111111000"],
  6: ["000011111000", "001111111110", "011111111110", "011111011111", "111110001110", "111111110000", "111111111100", "111111111110", "111111111111", "111110001111", "111110001111", "111110001111", "011111011111", "011111111110", "001111111110", "000011111000"],
  7: ["111111111111", "111111111111", "111111111111", "111111111110", "000000111100", "000000111100", "000001111000", "000011111000", "000011110000", "000111110000", "000111100000", "000111100000", "000111100000", "001111100000", "001111000000", "001111000000"],
  8: ["000111111000", "001111111100", "011111111110", "111110011110", "111110011110", "011110011110", "011111111110", "001111111100", "011111111110", "111110011111", "111100001111", "111100001111", "111110011111", "011111111110", "011111111110", "000111111000"],
  9: ["000111110000", "011111111100", "011111111110", "111110111110", "111100011111", "111100011111", "111100011111", "111111111111", "011111111111", "001111111111", "000011111111", "011100011111", "111110111110", "011111111110", "011111111100", "000111110000"],
  r3: ["001111111100", "011111111110", "111111111111", "111110011111", "011100001111", "000000001111", "000001111110", "000011111110", "000001111111", "000000111111", "000000001111", "111100001111", "111111111111", "011111111111", "001111111110", "000111111100"],
  r5: ["011111111110", "111111111110", "111111111100", "111111111000", "111100000000", "111111111000", "111111111100", "111111111110", "111100011111", "010000011111", "000000011111", "111000011111", "111111111111", "111111111110", "011111111100", "001111110000"],
  // 双色数字模式样例（type2-digit-sample.png，值由行列和约束校验确定；游戏顶部数字字形与左侧不同）
  r2b: ["001111111100", "011111111110", "111111111111", "111111111111", "111111111111", "011100111111", "000000111111", "000000111111", "000001111111", "000111111110", "001111111110", "011111111111", "111111111111", "111111111111", "111111111111", "011111111110"],
  r1b: ["001111111110", "011111111110", "111111111111", "111111111111", "111111111111", "111111111111", "111111111111", "011111111111", "001111111111", "001111111111", "001111111111", "001111111111", "001111111111", "001111111111", "000111111111", "000011111100"],
  r4b: ["000000111100", "000001111110", "000001111111", "000011111111", "000111111111", "000111111111", "000111111111", "001111111111", "111111111111", "111111111111", "111111111111", "111111111111", "111111111111", "010111111110", "000000011111", "000000011110"],
  r3b: ["000011111000", "000111111110", "001111111111", "111111111111", "111111011111", "011100011111", "000000111111", "000011111111", "000111111111", "001110011111", "011110001111", "011110011111", "111111111110", "111111111110", "011111111100", "001111111000"],
  r3c: ["001111110000", "011111111000", "011111111000", "011111111000", "011111111100", "001001111101", "000011111001", "000011110000", "000111111000", "000011111100", "011100111100", "111111111100", "111111111000", "011111111000", "001111111000", "000111110000"],
  r3d: ["001111111100", "011111111110", "011111111110", "111111111111", "111111111111", "011100111111", "001110111111", "000111111111", "000011111111", "000001111111", "111100111111", "111100111111", "111111111111", "111111111110", "011111111100", "001111111000"],
  r3e: ["000111111000", "001111111100", "001111111100", "111111111110", "111111111111", "011000111111", "000000111111", "000001111111", "000011111110", "000001111110", "000000111110", "001100011111", "111111111111", "011111111110", "001111111100", "001111111000"],
  r3f: ["000111111100", "011111111110", "111111111111", "111111111111", "111100111111", "111100111111", "011100111111", "000111111111", "000111111110", "000011111111", "000000111111", "010000111111", "111110111111", "111111111111", "111111111110", "111111111100"],
  // Δ-V40055 左侧数字（type2-digit-sample.png，蓝绿左右两种字形全收录，含 0 的真实样本）
  r0g130: ["000111110000", "001111111000", "011111111100", "111110011110", "111100001111", "111000001111", "111000001111", "111000001111", "111000001111", "111000001111", "111000001111", "111100001111", "111100001110", "011111111110", "001111111100", "000111111000"],
  r0g132: ["000111111100", "001111111110", "011111111111", "111000001111", "110000000111", "110000000111", "110000000111", "110000000111", "110000000111", "110000000111", "110000000111", "111000000111", "111000011111", "111001111110", "000011111100", "000011111000"],
  r1g134: ["000001111111", "000111111111", "001111111111", "111111111111", "111111111111", "111111111111", "000000111111", "000000111111", "000000111111", "000000111111", "000000111111", "000000111111", "000000111111", "000000111111", "000000111111", "000000111111"],
  r3g130: ["001111111110", "011111111111", "111111111111", "011100001111", "001000001111", "000000001111", "000001111111", "000011111110", "000001111111", "000000001111", "010000001111", "111000001111", "111100011111", "111111111111", "011111111110", "001111111100"],
  r5g130: ["011111111110", "011111111111", "011111111110", "111111111100", "111110000000", "111111111100", "111111111110", "111111111111", "111111111111", "011000001111", "000000001111", "111100001111", "111111111111", "011111111110", "001111111100", "000111111000"],
  r1g442: ["001111111111", "111111111111", "111111111111", "111111111111", "111111111111", "111111111111", "011111111111", "001111111111", "000111111111", "000011111111", "000011111111", "000011111111", "000011111111", "000011111111", "000011111111", "000001111111"],
  r2g524: ["000011110000", "000111111000", "001111111110", "011111111111", "111111111111", "011111111111", "000000111111", "000000111111", "000001111110", "000011111100", "000011111000", "000111111000", "011111111100", "011111111110", "111111111110", "111111111110"],
  r3b130: ["001111111110", "011111111111", "111111111111", "111111111111", "011100001111", "000000001111", "000001111111", "000011111111", "000011111111", "000001111111", "000000001111", "111100001111", "111111111111", "111111111111", "011111111110", "001111111100"],
  r5b130: ["011111111110", "011111111111", "011111111110", "111111111100", "111110000000", "111111111100", "111111111110", "111111111111", "111110111111", "011000001111", "000000001111", "111100011111", "111111111111", "111111111111", "011111111110", "001111111000"],
  r2b130: ["000111111100", "001111111110", "011111111110", "111111111111", "011000001111", "000000001111", "000000011111", "000000111111", "000001111100", "000011111000", "000111110000", "011111000000", "111111111111", "111111111111", "111111111111", "111111111110"],
  r0b130: ["000111111100", "001111111110", "011100000111", "111000000111", "111000000111", "111000000011", "111000000011", "111000000011", "111000000011", "111000000011", "111000000011", "111000000111", "111000000111", "011100001111", "001111111110", "000111111100"],
};
const DIGIT_NW = 12, DIGIT_NH = 16;

// 字符 OCR：bbox 内掩码归一化 12×16 → 与全部模板 NCC → { digit, score, margin } | null
function ocrChar(mask, W, H, c) {
  // 精化 bbox：连通域扩散——从量化框内的掩码像素出发 flood fill（限 ±6 邻域），
  // 只取与字符主体连通的像素，排除紧邻的分隔符/其他字符碎片（如 "2|3" 的竖线残片）。
  const X0 = Math.max(0, c.minx - 6), X1 = Math.min(W - 1, c.maxx + 6);
  const Y0 = Math.max(0, c.miny - 6), Y1 = Math.min(H - 1, c.maxy + 6);
  const seen = new Set();
  const stack = [];
  for (let y = c.miny; y <= c.maxy; y++) for (let x = c.minx; x <= c.maxx; x++) {
    if (mask[y * W + x]) { const k = y * W + x; if (!seen.has(k)) { seen.add(k); stack.push(k); } }
  }
  let minx = 1e9, maxx = -1, miny = 1e9, maxy = -1;
  while (stack.length) {
    const j = stack.pop(); const x = j % W, y = (j / W) | 0;
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (y < miny) miny = y; if (y > maxy) maxy = y;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < X0 || nx > X1 || ny < Y0 || ny > Y1) continue;
      const k = ny * W + nx;
      if (mask[k] && !seen.has(k)) { seen.add(k); stack.push(k); }
    }
  }
  if (maxx < 0) return null;
  const bw = maxx - minx + 1, bh = maxy - miny + 1;
  if (bw < 5 || bh < 8) return null;
  const grid = [];
  for (let ny = 0; ny < DIGIT_NH; ny++) {
    const row = [];
    for (let nx = 0; nx < DIGIT_NW; nx++) {
      const x0 = Math.floor(minx + nx * bw / DIGIT_NW), x1 = Math.ceil(minx + (nx + 1) * bw / DIGIT_NW);
      const y0 = Math.floor(miny + ny * bh / DIGIT_NH), y1 = Math.ceil(miny + (ny + 1) * bh / DIGIT_NH);
      let sum = 0, cnt = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { cnt++; sum += mask[y * W + x]; }
      row.push(cnt && sum / cnt > 0.35 ? 1 : 0);
    }
    grid.push(row);
  }
  let best = null;
  const byDigit = {}; // 每个数字取其全部模板（合成 + 真实样本）的最大分，避免同类模板竞争拉低 margin
  for (const [k, rows] of Object.entries(DIGIT_TEMPLATES)) {
    let sab = 0, sa2 = 0, sb2 = 0;
    for (let y = 0; y < DIGIT_NH; y++) for (let x = 0; x < DIGIT_NW; x++) {
      const b = rows[y][x] === "1" ? 1 : 0;
      sab += grid[y][x] * b; sa2 += grid[y][x] * grid[y][x]; sb2 += b * b;
    }
    const s = sab / Math.sqrt(sa2 * sb2 || 1);
    const d = k[0] === "r" ? k[1] : k; // r3/r5 真实样本 → 3/5
    if (!byDigit[d] || s > byDigit[d]) byDigit[d] = s;
    if (!best || s > best.s) best = { d, s };
  }
  if (!best) return null;
  const ranked = Object.entries(byDigit).sort((a, b) => b[1] - a[1]);
  const second = ranked.find(([d]) => d !== best.d);
  return { digit: +best.d, score: best.s, margin: best.s - (second ? second[1] : 0) };
}

// 数字模式网格检测：从行列数字字符的位置聚类推断网格并 OCR 目标值。
// 列数字 = 一条水平带（cy 相近、cx 等距）；行数字 = 一条垂直带。返回 null 表示不是数字模式。
function detectDigitGrid(green, blue, comps, compsBlue, W, H, debug, forceType2) {
  const isChar = (c) => {
    const w = c.maxx - c.minx + 1, h = c.maxy - c.miny + 1;
    return w >= 6 && w <= 44 && h >= 10 && h <= 44 && h >= w * 0.85 && c.n >= 8;
  };
  const chars = comps.filter(isChar);
  if (chars.length < 4) { if (debug) debug.digitTrace = "chars<4: " + chars.length + "/" + comps.length; return null; }
  const hs = chars.map(c => c.maxy - c.miny + 1).sort((a, b) => a - b);
  const bandTol = Math.max(10, hs[(hs.length / 2) | 0] * 0.8);

  // 带检测：按 keyFn 聚类成带（相邻合并）；带内按 posFn 排列，需 ≥2 字符且等距（间距 = 目标网格间距）
  function findBand(list, keyFn, posFn, tol) {
    const sorted = [...list].sort((a, b) => keyFn(a) - keyFn(b) || posFn(a) - posFn(b));
    const bands = [];
    for (const c of sorted) {
      const last = bands[bands.length - 1];
      if (last && Math.abs(keyFn(last.items[last.items.length - 1]) - keyFn(c)) <= tol) last.items.push(c);
      else bands.push({ items: [c] });
    }
    return bands.filter(b => {
      if (b.items.length < 2) return false;
      b.items.sort((a, b) => posFn(a) - posFn(b));
      const ks = b.items.map(posFn);
      const diffs = ks.slice(1).map((v, i) => v - ks[i]);
      const dmed = median(diffs);
      return dmed >= 24 && diffs.every(d => Math.abs(d - dmed) <= dmed * 0.35);
    });
  }
  const cy = c => (c.miny + c.maxy) / 2, cx = c => (c.minx + c.maxx) / 2;
  const colBands = findBand(chars, cy, cx, bandTol); // 列数字：水平带（cy 相聚），带内 cx 等距
  const rowBands = findBand(chars, cx, cy, bandTol); // 行数字：垂直带（cx 相聚），带内 cy 等距
  colBands.sort((a, b) => b.items.length - a.items.length);
  rowBands.sort((a, b) => b.items.length - a.items.length);
  if (!colBands.length || !rowBands.length) {
    if (debug) debug.digitTrace = "bands: col=" + colBands.map(b => b.items.length).join(",") + " row=" + rowBands.map(b => b.items.length).join(",")
      + " chars=" + chars.map(c => [c.maxx - c.minx + 1, c.maxy - c.miny + 1, c.n]).join(";");
    return null;
  }
  const colBand = colBands[0], rowBand = rowBands[0];
  colBand.items.sort((a, b) => cx(a) - cx(b));
  rowBand.items.sort((a, b) => cy(a) - cy(b));

  // 蓝色字符带（双色）：与绿色带独立聚类
  const charsB = (compsBlue || []).filter(isChar);
  const blueColBands = charsB.length >= 4 ? findBand(charsB, cy, cx, bandTol) : [];
  const blueRowBands = charsB.length >= 4 ? findBand(charsB, cx, cy, bandTol) : [];
  blueColBands.sort((a, b) => b.items.length - a.items.length);
  blueRowBands.sort((a, b) => b.items.length - a.items.length);
  const blueColBand = blueColBands[0], blueRowBand = blueRowBands[0];
  if (debug) debug.digitBands = { col: colBands.map(b => b.items.length), row: rowBands.map(b => b.items.length),
    charsG: chars.length, charsB: charsB.length };

  // 绿蓝配对。优先按序严格配对（组数一致 = 双色每行列都有蓝绿数字）；
  // 组数不一致时按中心就近吸附（游戏对 0 目标可能不渲染数字字符，缺位 → 该色目标记 0），
  // forceType2 时即使蓝带缺失也按双色处理。
  function pairBands(gItems, bItems, posFn) {
    const gPos = gItems.map(posFn), bPos = bItems.map(posFn);
    if (!bItems.length) return { slots: gPos.map((p, i) => ({ center: p, g: gItems[i], b: null })), type2: false };
    // offset 估计：每绿项找最近蓝项的带符号差的中位数（均值差在组数不等时会偏移——
    // 缺位一侧的均值被拉高/低，导致全部配对失败）
    const diffs = gPos.map(g => {
      let bd = 1e9, bo = 0;
      bPos.forEach(b => { const d = Math.abs(b - g); if (d < bd) { bd = d; bo = b - g; } });
      return bo;
    });
    const offset = diffs.length ? median(diffs) : 0;
    const gp = median(gPos.slice(1).map((v, i) => v - gPos[i]).filter(v => v > 24)) || 0;
    const bp = median(bPos.slice(1).map((v, i) => v - bPos[i]).filter(v => v > 24)) || 0;
    const pitchGuess = Math.max(gp, bp) || Math.abs(offset) * 2.2 || 60;
    if (gItems.length === bItems.length) {
      // 严格按序配对（各自已排序）
      return { slots: gPos.map((p, i) => ({ center: (p + bPos[i]) / 2, g: gItems[i], b: bItems[i] })), type2: true, offset };
    }
    // 就近吸附：对较多的一带每项，在另一带找最近未配对项（|差 - offset| ≤ 0.45×间距）
    const used = new Set();
    const slots = [];
    const gUsed = new Set(), bUsed = new Set();
    const all = [];
    gPos.forEach((p, i) => all.push({ pos: p + offset, i, isG: true }));
    bPos.forEach((p, i) => all.push({ pos: p, i, isG: false }));
    all.sort((a, b) => a.pos - b.pos);
    // 相邻交错配对：排序后逐个看与相邻异色项的距离
    const decisions = [];
    for (let k = 0; k < all.length; k++) {
      const a = all[k];
      if (k + 1 < all.length && all[k + 1].isG !== a.isG && !a.paired && !all[k + 1].paired) {
        const d = Math.abs(all[k + 1].pos - a.pos);
        decisions.push([(a.isG ? 'G' : 'B') + a.pos.toFixed(0), (all[k + 1].isG ? 'G' : 'B') + all[k + 1].pos.toFixed(0), 'd=' + d.toFixed(1), d <= pitchGuess * 0.45 ? 'PAIR' : 'TOOFAR']);
        if (d <= pitchGuess * 0.45) {
          const g = a.isG ? a : all[k + 1], b = a.isG ? all[k + 1] : a;
          slots.push({ center: (a.pos + all[k + 1].pos) / 2, g: gItems[g.i], b: bItems[b.i] });
          a.paired = all[k + 1].paired = true;
          gUsed.add(a.isG ? a.i : all[k + 1].i); bUsed.add(a.isG ? all[k + 1].i : a.i);
          k++; // 下一对
          continue;
        }
      }
      decisions.push([(a.isG ? 'G' : 'B') + a.pos.toFixed(0), 'SINGLE']);
      slots.push({ center: a.pos + (a.isG ? offset / 2 : -offset / 2), g: a.isG ? gItems[a.i] : null, b: a.isG ? null : bItems[a.i] });
      if (a.isG) gUsed.add(a.i); else bUsed.add(a.i);
    }
    return { slots, type2: forceType2 || slots.some(s => s.g && s.b), offset, trace: { gPos, bPos, offset, pitchGuess, decisions, slots: slots.map(s => (s.g ? 'G' : '-') + (s.b ? 'B' : '-')) } };
  }
  const colPair = pairBands(colBand.items, blueColBand ? blueColBand.items : [], cx);
  const rowPair = pairBands(rowBand.items, blueRowBand ? blueRowBand.items : [], cy);
  if (debug) debug.pairTrace = { col: colPair.trace, row: rowPair.trace };
  const type2 = colPair.type2 && rowPair.type2;
  colPair.slots.sort((a, b) => a.center - b.center);
  rowPair.slots.sort((a, b) => a.center - b.center);
  if (debug) debug.paired = { col: colPair.slots.map(s => (s.g ? 'G' : '-') + (s.b ? 'B' : '-')), row: rowPair.slots.map(s => (s.g ? 'G' : '-') + (s.b ? 'B' : '-')) };

  const colCenters = colPair.slots.map(s => s.center);
  const rowCenters = rowPair.slots.map(s => s.center);
  const pitchC = median(colCenters.slice(1).map((v, i) => v - colCenters[i]));
  const pitchR = median(rowCenters.slice(1).map((v, i) => v - rowCenters[i]));
  if (!pitchC || !pitchR || Math.min(pitchC, pitchR) < 24) { if (debug) debug.digitTrace = "pitch: " + pitchC + "," + pitchR; return null; }
  if (Math.abs(pitchC - pitchR) / Math.min(pitchC, pitchR) > 0.25) { if (debug) debug.digitTrace = "pitch mismatch: " + pitchC + "," + pitchR; return null; } // 行列间距应一致

  // OCR 目标：绿 → colT/rowT；蓝（双色）→ col2T/row2T；缺位的色记 0
  let weak = 0;
  const ocrScores = [];
  const ocrOne = (mask, c, into) => {
    if (!c) { into.push(0); return true; }
    const o = ocrChar(mask, W, H, c);
    if (!o) { if (debug) debug.digitTrace = "ocr fail " + [c.minx, c.miny, c.maxx, c.maxy]; return false; }
    into.push(o.digit);
    ocrScores.push(o.digit + ":" + o.score.toFixed(3) + "/" + o.margin.toFixed(3));
    if (o.score < 0.75 || o.margin < 0.04) weak++;
    return true;
  };
  const colT = [], rowT = [], col2T = [], row2T = [];
  for (const s of colPair.slots) { if (!ocrOne(green, s.g, colT) || !ocrOne(blue, s.b, col2T)) return null; }
  for (const s of rowPair.slots) { if (!ocrOne(green, s.g, rowT) || !ocrOne(blue, s.b, row2T)) return null; }
  if (!type2) { col2T.length = 0; row2T.length = 0; }

  if (debug) {
    debug.digitMode = true;
    debug.digitCols = colPair.slots.filter(s => s.g).map(s => [s.g.minx, s.g.miny, s.g.maxx, s.g.maxy]);
    debug.digitRows = rowPair.slots.filter(s => s.g).map(s => [s.g.minx, s.g.miny, s.g.maxx, s.g.maxy]);
    debug.weakDigits = weak;
    debug.ocrScores = ocrScores;
  }
  const charBoxes = colPair.slots.concat(rowPair.slots).flatMap(s => [s.g, s.b]).filter(Boolean).map(c => [c.minx, c.miny, c.maxx, c.maxy]);
  return { colCenters, rowCenters, pitchC, pitchR, colT, rowT, type2, col2T, row2T, charBoxes, weak };
}

// ---- 公共后段（计数条/数字两种网格来源共用）----

// 特殊格探测（禁用/常亮/锁定）+ 网格尺寸推算（含 0 目标行列的外扩）+ 单元格状态组装
function extractCellsAndSize(ctx) {
  const { W, H, green, blue, gray, comps, medArea, C, colCenters, rowCenters, pitchC, pitchR, debug } = ctx;
  const maxCol = colCenters.length - 1, maxRow = rowCenters.length - 1;
  const pitch = Math.min(pitchC, pitchR);
  // 特殊格（禁用/常亮）探测：限制在棋盘像素邻域内（计数范围外扩 1.2 格）
  const regionX = [colCenters[0] - pitchC * 0.7, colCenters[colCenters.length - 1] + pitchC * 1.7];
  const regionY = [rowCenters[0] - pitchR * 0.7, rowCenters[rowCenters.length - 1] + pitchR * 1.7];
  const inRegion = (c) => {
    const cx = (c.minx + c.maxx) / 2, cy = (c.miny + c.maxy) / 2;
    return cx >= regionX[0] && cx <= regionX[1] && cy >= regionY[0] && cy <= regionY[1];
  };
  const minSpecialArea = (pitch * pitch) / (C * C) / 3;
  const cellBBox = (c) => Math.max(c.maxx - c.minx, c.maxy - c.miny);
  const greenBig = comps.filter(c => c.n > (pitch * pitch) / (C * C) / 2 && c.n > medArea * 1.6 && cellBBox(c) <= pitch * 1.4 && inRegion(c));
  const blueComps = components(blue, W, H, C).filter(c => c.n > minSpecialArea && cellBBox(c) <= pitch * 1.4 && inRegion(c));
  // 把特殊格中心吸附到网格（偏离格点 > 0.35 间距的丢弃）
  function snapToGrid(cx0, cy0) {
    const c = Math.round((cx0 - colCenters[0]) / pitchC);
    const r = Math.round((cy0 - rowCenters[0]) / pitchR);
    const dx = Math.abs(cx0 - (colCenters[0] + c * pitchC)), dy = Math.abs(cy0 - (rowCenters[0] + r * pitchR));
    if (dx > pitchC * 0.35 || dy > pitchR * 0.35) return null;
    return [r, c];
  }
  const special = [];
  // 禁用格识别（混合）：
  // a) 连通域候选——在腐蚀 1 圈的 gray 上提取（断开禁用格与棋盘斜纹间的 1-2px 细桥，
  //    使桥接的禁用格重新独立成块），可吸附到网格外 1 行/列（0 目标行列无计数段/数字）；
  // b) 格点占比补扫——桥接且无同行列种子的格子仍会漏，故对已知网格全格用"腐蚀后 gray
  //    占比"补扫（实测禁用格腐蚀后 87-100%、半透明面板格 63-75%、普通格 ≤4%，阈值 0.8
  //    可分；腐蚀消除斜纹边缘的抗锯齿膨胀，面板的均匀蒙层占比几乎不降）。
  let ge = new Uint8Array(W * H);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const k = y * W + x;
    if (gray[k] && gray[k - 1] && gray[k + 1] && gray[k - W] && gray[k + W]) ge[k] = 1;
  }
  const grayHalf = Math.round(pitch * 0.32);
  const grayRatio = (r, c) => {
    const gx = Math.round(colCenters[0] + c * pitchC), gy = Math.round(rowCenters[0] + r * pitchR);
    let n = 0, tot = 0;
    for (let y = Math.max(0, gy - grayHalf); y <= Math.min(H - 1, gy + grayHalf); y += 2)
      for (let x = Math.max(0, gx - grayHalf); x <= Math.min(W - 1, gx + grayHalf); x += 2) {
        tot++; if (ge[y * W + x]) n++;
      }
    return tot ? n / tot : 0;
  };
  const grayComps = components(ge, W, H, C).filter(c => c.n > minSpecialArea && cellBBox(c) <= pitch * 1.4 && inRegion(c));
  const graySeed = [];
  for (const c of grayComps) {
    const s = snapToGrid((c.minx + c.maxx) / 2, (c.miny + c.maxy) / 2);
    if (s) { graySeed.push(s); special.push([s[0], s[1], 1]); }
  }
  // 补扫：已知网格全格（腐蚀后占比区分禁用格与面板/普通格，无需限制行列）
  const scanned = new Set(graySeed.map(s => s[0] + "," + s[1]));
  for (let r = 0; r < rowCenters.length; r++) for (let c = 0; c < colCenters.length; c++) {
    if (scanned.has(r + "," + c)) continue;
    if (grayRatio(r, c) > 0.8) { special.push([r, c, 1]); scanned.add(r + "," + c); }
  }
  for (const c of greenBig) { const s = snapToGrid((c.minx + c.maxx) / 2, (c.miny + c.maxy) / 2); if (s) special.push([s[0], s[1], 2]); }
  for (const c of blueComps) { const s = snapToGrid((c.minx + c.maxx) / 2, (c.miny + c.maxy) / 2); if (s) special.push([s[0], s[1], 3]); }
  // 扩展网格范围：特殊格可能落在数字/计数未覆盖的行/列（最多外扩 1 格，由 region 保证）
  let minRow = 0, minCol = 0;
  for (const [r, c] of special) { if (r < minRow) minRow = r; if (c < minCol) minCol = c; }
  const rows = Math.max(maxRow, special.length ? Math.max(...special.map(s => s[0])) : -1) + 1 - minRow;
  const cols = Math.max(maxCol, special.length ? Math.max(...special.map(s => s[1])) : -1) + 1 - minCol;
  const cells = Array(Math.max(0, rows) * Math.max(0, cols)).fill(0);
  for (const [r, c, st] of special) cells[(r - minRow) * cols + (c - minCol)] = st;
  if (debug) debug.specialCount = special.length;
  return { rows, cols, cells, special, shiftR: -minRow, shiftC: -minCol };
}

// 结果组装：元件托盘识别（不依赖题库）+ 预设交叉匹配 + 警告 + overlay
function assembleResult(ctx) {
  const { W, H, green, blue, comps, compsBlue, C, catalog, presets, pitchC, pitchR, colCenters, rowCenters,
    rows, cols, cells, special, shiftR, shiftC, type2, rowT, colT, row2T, col2T, tallyBoxes, debug, warnings } = ctx;

  // 元件托盘识别（旋转不变形状匹配，不依赖题库）
  const boardRight = colCenters[colCenters.length - 1] + pitchC * 0.5;
  const minTrayN = (pitchC * 0.3) ** 2 / 6;
  const inTray = (c) => (c.minx + c.maxx) / 2 > boardRight + pitchC * 0.35 && c.n > minTrayN;
  const trayGreenComps = comps.filter(inTray);
  const trayBlueComps = (compsBlue || []).filter(inTray);
  const trayGreen = recognizeTray(green, W, H, trayGreenComps, catalog, debug);
  const trayBlue = recognizeTray(blue, W, H, trayBlueComps, catalog, debug);

  // 格数守恒修正：托盘形状按卡片等比缩放渲染，IoU 对相似形状（1×3/1×4 横条、L3/L5）
  // 可能选错。用"元件总格数 == 行列目标总和"约束，在每 blob 的候选里重选
  // （DFS 全组合 ≤4^6，取 IoU 总分最高的守恒组合）。
  // 目标需扣除常亮格（锁定格已被覆盖、无需元件）；仅在 sumNow < target（识别偏小）时触发——
  // sumNow ≥ target 可能是备用元件（求解器弃置逻辑处理），不应强制守恒。
  const lockedG = special.filter(s => s[2] === 2).length;
  const lockedB = special.filter(s => s[2] === 3).length;
  const conserveFix = (matched, target) => {
    if (!matched.length || !target) return matched;
    const cellsOf = (id) => new Set(catalog[id].shape.map(p => p.join(","))).size;
    const sumNow = matched.reduce((s, m) => s + cellsOf(m.id), 0);
    if (sumNow >= target) return matched;
    let bestSel = null, bestScore = -1;
    const dfs = (i, sum, score, sel) => {
      if (i === matched.length) {
        if (sum === target && score > bestScore) { bestScore = score; bestSel = sel.slice(); }
        return;
      }
      const cands = matched[i].cands.length ? matched[i].cands : [{ id: matched[i].id, iou: matched[i].score, cells: cellsOf(matched[i].id) }];
      for (const cand of cands) { sel.push(cand); dfs(i + 1, sum + cand.cells, score + cand.iou, sel); sel.pop(); }
    };
    dfs(0, 0, 0, []);
    if (!bestSel) return matched;
    if (debug) debug.conserveFix = { from: sumNow, to: target, pick: bestSel.map(c => c.id) };
    // 返回"每 blob 一项"的选中列表（与 matched 同构，由调用方按次聚合）
    return bestSel.map(c => ({ id: c.id, score: c.iou }));
  };
  const pickG = conserveFix(trayGreen.matched, rowT.reduce((a, b) => a + b, 0) - lockedG);
  const pickB = type2 ? conserveFix(trayBlue.matched, row2T.reduce((a, b) => a + b, 0) - lockedB) : trayBlue.matched;

  const agg = new Map();
  for (const m of pickG) { const e = agg.get(m.id) || { count: 0, count2: 0 }; e.count++; agg.set(m.id, e); }
  for (const m of pickB) { const e = agg.get(m.id) || { count: 0, count2: 0 }; e.count2++; agg.set(m.id, e); }
  const componentsOut = [...agg.entries()].map(([id, c]) => ({ id, count: c.count, count2: c.count2 }));
  const componentsOutUnmatched = [...trayGreen.unmatched, ...trayBlue.unmatched];

  // 预设匹配（仅作交叉校验）
  let match = null;
  const key = (p) => JSON.stringify([p.n, p.m, !!p.isType2Activated, p.target.row, p.target.col, p.isType2Activated ? p.target.row2 : null, p.isType2Activated ? p.target.col2 : null,
    (p.gridCell || []).map(c => [c.r, c.c, c.state]).sort((a, b) => a[0] - b[0] || a[1] - b[1])]);
  const mineKey = JSON.stringify([rows, cols, type2, rowT, colT, type2 ? row2T : null, type2 ? col2T : null,
    cells.map((s, i) => s ? [Math.floor(i / cols), i % cols, s] : null).filter(Boolean).sort((a, b) => a[0] - b[0] || a[1] - b[1])]);
  const matches = [];
  for (const [k, p] of Object.entries(presets)) {
    if (key(p) === mineKey) matches.push({ key: k, name: p.name || k });
  }
  if (matches.length) match = { key: matches[0].key, name: matches[0].name, alternatives: matches.slice(1).map(m => m.name), score: 1 };

  if (match && componentsOut.length) {
    const presetComps = (presets[match.key].component || []).map(c => c.id + "×" + (c.count || 0) + (c.count2 ? "+" + c.count2 : "")).sort().join(", ");
    const mineComps = componentsOut.map(c => c.id + "×" + c.count + (c.count2 ? "+" + c.count2 : "")).sort().join(", ");
    if (presetComps !== mineComps) warnings.push(`识别的元件（${mineComps}）与官方预设（${presetComps}）不一致，请对照截图核对。`);
  }
  if (componentsOutUnmatched.length) {
    warnings.push(`有 ${componentsOutUnmatched.length} 个托盘形状未能识别——请确认截图包含完整的元件栏。`);
  }
  if (!match && !componentsOut.length) warnings.push("未识别到元件也未匹配到官方预设：请在右侧元件库手动设置元件数量后求解。");

  return {
    ok: true, rows, cols, type2, cells, rowT, colT, row2T, col2T,
    components: componentsOut,
    match, warnings,
    overlay: { colCenters, rowCenters, pitch: Math.min(pitchC, pitchR), pitchC, pitchR, shiftR, shiftC, special, tallyBoxes },
    ...(debug ? { debug } : {}),
  };
}

// 计数条模式（游戏"图形"显示模式）：小方块计数段聚类 → 网格 + 投影计数
function analyzeCircuitBars(data, presets, opts = {}) {
  const debug = opts.debug ? {} : null;
  const catalog = opts.catalog || {};
  const W = data.width, H = data.height, D = data.data;
  const warnings = [];
  const { green, blue, gray, gex, glo } = makeMasks(D, W, H);
  const C = 2; // 连通域降采样粒度

  // 1. 连通域（绿 + 蓝）→ 分为计数段（小长条）与大块（元件卡/大形状）
  const comps = components(green, W, H, C);
  const compsBlue = components(blue, W, H, C);
  if (!comps.length && !compsBlue.length) return { ok: false, reason: "未检测到绿色计数段或元件——请确认截图包含完整的电路谜题界面。" };
  const areas = comps.map(c => c.n).sort((a, b) => a - b);
  const medArea = median(areas);

  // 2. 聚类成"组"：顶部列组（x 中心相同、纵向堆叠）与左侧行组（y 中心相同、横向并排）
  //    组中心间距 = 网格间距。这里用简化法：先按 x 中心聚类列，按 y 中心聚类行。
  //    小条组件：max 边 ≤ 60px 且面积 ≤ 中位数×1.6（排除托盘大形状）
  //    双色模式：蓝色计数条与绿色条左右/上下并排（错开 ~30px），合并聚类后蓝绿互补，
  //    某色目标为 0 的行/列由另一色补齐（合并组中心 = 分色平均）。
  const barOk = (c) => {
    const w = c.maxx - c.minx, h = c.maxy - c.miny;
    if (Math.max(w, h) > 64) return false;
    if (c.n <= medArea * 1.6) return true;
    // 面积豁免（上限 400）：jpg 桥接会让多格实心条连成一整块（如行首 4-5 格条 n~370），
    // 单靠 medArea×1.6（~96）会误杀整段条。豁免仅限左半区——托盘卡/元件模块都在
    // 右半区（>55%），直接排除；左半区的豁免块由 hBars 位置判定归入行组。
    return c.n <= 400 && (c.minx + c.maxx) / 2 < W * 0.55;
  };
  const bars = [
    ...comps.filter(barOk).map(c => ({ ...c, isBlue: 0 })),
    ...compsBlue.filter(barOk).map(c => ({ ...c, isBlue: 1 })),
  ];
  if (bars.length < 4) return { ok: false, reason: "绿色计数段过少，无法定位目标——请使用游戏默认的“图形”显示模式截图。" };

  // 列组：按 x 中心聚类（容差 = 中位条宽 × 1.2）
  const barW = median(bars.map(c => c.maxx - c.minx));
  const barH = median(bars.map(c => c.maxy - c.miny));
  const tol = Math.max(barW, barH) * 0.9 + 6;
  function groupBy(key) {
    const groups = [];
    for (const c of bars) {
      const k = key(c);
      const g = groups.find(g => Math.abs(g.key - k) <= tol);
      if (g) { g.items.push(c); g.key = (g.key * (g.items.length - 1) + k) / g.items.length; }
      else groups.push({ key: k, items: [c] });
    }
    return groups.filter(g => g.items.length >= 1);
  }
  // 每个组件只应属于一组：先列后行，已分配的不再参与行聚类
  const colGroupsRaw = groupBy(c => (c.minx + c.maxx) / 2);
  // 行组：用"宽而扁"的组件聚集 y 中心 —— 但左右条(竖条)是按 y 对齐的
  // 更稳的做法：列组内组件的 y 范围在棋盘上方；行组内组件 x 范围在棋盘左侧。
  // 先假定列组 = 各组内组件纵向堆叠（组高度 > 单条高度），行组 = 横向并排。

  // 分离：一个组件属于列组还是行组？——列组的组件 x 中心几乎一致；行组的 y 中心几乎一致。
  // 同一根条既属于某个列组也可能是行组一员，需按几何区分：
  // 横条（w > h）只会出现在列组（顶部计数）；竖条（h > w）只会出现在行组（左侧计数）。
  // 横条（w ≥ h）→ 列目标；竖条 → 行目标。
  // 例外：n 超过 medArea×1.6 的"面积豁免块"（多格实心条被 jpg 连成一块，形状横宽）
  // 若位于行条区（图像左侧且在中下部）则归行目标——行首的长条整块属于行条，
  // 按形状会误分类为列条（且其 cx 会成为假列组把网格拉宽一列）。
  const hBars = bars.filter(c => {
    const w = c.maxx - c.minx, h = c.maxy - c.miny;
    if (w < h) return false;
    if (c.n > medArea * 1.6 && (c.minx + c.maxx) / 2 < W * 0.45 && c.maxy > H * 0.3) return false;
    return true;
  });
  const vBars = bars.filter(c => !hBars.includes(c));
  function clusterBars(list, keyFn, tolFn) {
    const groups = [];
    for (const c of list.sort((a, b) => keyFn(a) - keyFn(b))) {
      const k = keyFn(c);
      const g = groups.find(g => Math.abs(g.center - k) <= tolFn(g));
      if (g) { g.items.push(c); g.center = g.items.reduce((s, x) => s + keyFn(x), 0) / g.items.length; }
      else groups.push({ center: k, items: [c] });
    }
    return groups;
  }
  // 聚类容差需容纳双色的蓝绿条错开（~30px）：max(32, 条宽高)×1.3，同时仍远小于网格间距（≥56）
  const colTol = Math.max(32, barW) * 1.3;
  const rowTol = Math.max(32, barH) * 1.3;
  let colGroups = clusterBars(hBars, c => (c.minx + c.maxx) / 2, g => colTol);
  let rowGroups = clusterBars(vBars, c => (c.miny + c.maxy) / 2, g => rowTol);
  // 组中心 = 蓝绿分色平均（双色时蓝绿条各偏一侧，简单平均会被条数差带偏）
  const colorMean = (items, key) => {
    const gs = items.filter(c => !c.isBlue), bs = items.filter(c => c.isBlue);
    const mean = (arr) => arr.reduce((s, x) => s + key(x), 0) / arr.length;
    const mg = gs.length ? mean(gs) : null, mb = bs.length ? mean(bs) : null;
    return { center: mg != null && mb != null ? (mg + mb) / 2 : (mg != null ? mg : mb), hasBlue: bs.length > 0 };
  };
  for (const g of colGroups) { const r = colorMean(g.items, c => (c.minx + c.maxx) / 2); g.center = r.center; g.hasBlue = r.hasBlue; }
  for (const g of rowGroups) { const r = colorMean(g.items, c => (c.miny + c.maxy) / 2); g.center = r.center; g.hasBlue = r.hasBlue; }
  colGroups.sort((a, b) => a.center - b.center);
  rowGroups.sort((a, b) => a.center - b.center);

  // 2.5 位置约束：列组须在行区上方、行组须在列区左侧（排除界面右侧元件托盘等远处元素的误检）
  if (rowGroups.length && colGroups.length) {
    const gapsC = colGroups.slice(1).map((g, i) => g.center - colGroups[i].center).filter(v => v > 24);
    const pitchGuess = gapsC.length ? median(gapsC) : Math.max(barW, barH) * 6;
    const rowMinY = Math.min(...rowGroups.map(g => Math.min(...g.items.map(i => i.miny))));
    colGroups = colGroups.filter(g => Math.max(...g.items.map(i => i.maxy)) >= rowMinY - 1.0 * Math.max(pitchGuess, 40));
    if (colGroups.length) {
      // 行条必须整体位于"列条带左缘"的左侧（行条右端紧贴棋盘左缘）：阈值取
      // colMinX 左移一点——顶部计数条里的竖长碎片（h>w）会混入行组，其 x 位置
      // 落在列条带内（colMinX 右侧）——不剔除会成为 rowGroups[0] 锚点，
      // 把 refit 的间距拉偏、进而误触发倍距补全把网格展开成 10+ 列。
      const colMinX = Math.min(...colGroups.map(g => Math.min(...g.items.map(i => i.minx))));
      const xLimit = colMinX - Math.max(5, barH * 0.2);
      rowGroups = rowGroups.filter(g => Math.max(...g.items.map(i => i.maxx)) <= xLimit);
    }
    colGroups.sort((a, b) => a.center - b.center);
    rowGroups.sort((a, b) => a.center - b.center);
  }

  if (colGroups.length < 2 || rowGroups.length < 2) {
    return { ok: false, reason: `计数段不足以推断网格（列组 ${colGroups.length}、行组 ${rowGroups.length}）——请截取完整的谜题界面。`, ...(debug ? { debug } : {}) };
  }

  // 3. 网格间距：鲁棒估计（相邻差中位，排除跨格大值）+ 格点重拟合
  // 3. 网格间距：鲁棒估计（相邻差中位，排除跨格大值）+ 格点重拟合
  let pitchC = robustPitch(colGroups.slice(1).map((g, i) => g.center - colGroups[i].center));
  let pitchR = robustPitch(rowGroups.slice(1).map((g, i) => g.center - rowGroups[i].center));
  if (!pitchC || !pitchR) return { ok: false, reason: "计数段过少，无法估计网格间距。", debug };
  const pitch = Math.min(pitchC, pitchR);
  if (pitch < 24) return { ok: false, reason: "网格间距异常（" + Math.round(pitch) + "px），截图可能过小。", debug };

  // 3.5 剔除不在等差格点上的杂组（如界面托盘误检）：相对第一组，中心偏离格点 > 0.35 间距的丢弃
  const latticeKeep = (groups, p) => groups.filter(g => {
    const k = Math.round((g.center - groups[0].center) / p);
    return Math.abs(g.center - (groups[0].center + k * p)) <= p * 0.35;
  });
  // 护栏：间距样本少（组数 ≤3）时 robustPitch 可能取到倍距（上中位），latticeKeep 会把
  // 全部真实组判为"离格"删光——删到不足 2 组时回退原始组，把倍距修正交给下游的
  // 3.8 倍距分支（它以另一方向的正常间距为先验重新拟合）。
  const keepC = latticeKeep(colGroups, pitchC);
  colGroups = keepC.length >= 2 ? keepC : colGroups;
  const keepR = latticeKeep(rowGroups, pitchR);
  rowGroups = keepR.length >= 2 ? keepR : rowGroups;
  colGroups.sort((a, b) => a.center - b.center);
  rowGroups.sort((a, b) => a.center - b.center);
  if (colGroups.length < 2 || rowGroups.length < 2) {
    return { ok: false, reason: "计数段组过少，无法推断网格。", debug };
  }
  // 格点重拟合：按保留组的格点索引回归间距（消除碎片组中心的偏移）
  const refit = (groups, p0) => {
    const idx = groups.map(g => Math.round((g.center - groups[0].center) / p0));
    const ratios = groups.map((g, i) => idx[i] > 0 ? (g.center - groups[0].center) / idx[i] : null).filter(v => v);
    return ratios.length ? median(ratios) : p0;
  };
  pitchC = refit(colGroups, pitchC);
  pitchR = refit(rowGroups, pitchR);

  // 3.8 网格补全：格子为正方形（pitchC ≈ pitchR）。某方向的部分计数条颜色过暗、
  // 低于全局绿色阈值时，该方向相邻组间距 ≈ 2×真实间距（缺位倍距，refit 也被带偏）。
  // 此时以另一方向的间距为先验重拟合：吸附现有组到格点、外推补齐缺失行列（虚拟组），
  // 虚拟组的读数稍后用绿色溢出通道（gex，对暗色计数条灵敏）局部提取。
  if (pitchC / pitchR > 1.55 && pitchC / pitchR < 2.6 && colGroups.length >= 2) {
    const anchor = colGroups[0].center;
    // 吸附：偏离格点 > 0.3×间距的组是噪声（如托盘碎块），不参与拟合与范围扩展
    const byK = new Map();
    for (const g of colGroups) {
      const k = Math.round((g.center - anchor) / pitchR);
      if (Math.abs(g.center - (anchor + k * pitchR)) > pitchR * 0.3) continue;
      byK.set(k, g);
    }
    const kLast = Math.max(...byK.keys());
    const fitted = [];
    for (let k = 0; k <= kLast; k++) {
      if (byK.has(k)) fitted.push(byK.get(k));
      else fitted.push({ center: anchor + k * pitchR, items: [], virtual: true, hasBlue: false });
    }
    colGroups = fitted.sort((a, b) => a.center - b.center);
    pitchC = refit(colGroups, pitchR);
    if (debug) debug.colFilled = true;
  } else if (pitchR / pitchC > 1.55 && pitchR / pitchC < 2.6 && rowGroups.length >= 2) {
    const anchor = rowGroups[0].center;
    const byK = new Map();
    for (const g of rowGroups) {
      const k = Math.round((g.center - anchor) / pitchC);
      if (Math.abs(g.center - (anchor + k * pitchC)) > pitchC * 0.3) continue;
      byK.set(k, g);
    }
    const kLast = Math.max(...byK.keys());
    const fitted = [];
    for (let k = 0; k <= kLast; k++) {
      if (byK.has(k)) fitted.push(byK.get(k));
      else fitted.push({ center: anchor + k * pitchC, items: [], virtual: true, hasBlue: false });
    }
    rowGroups = fitted.sort((a, b) => a.center - b.center);
    pitchR = refit(rowGroups, pitchC);
    if (debug) debug.rowFilled = true;
  }

  // 3.85 gap 倍距填充：相邻组间距 ≈ k×另一方向间距（k ≥ 2）说明中间有整组漏检
  // （条过暗/过短），按等分位置补齐虚拟组（读数走暗条灵敏通道）。
  const fillGaps = (groups, pitch) => {
    const out = [];
    for (let i = 0; i < groups.length; i++) {
      out.push(groups[i]);
      if (i + 1 < groups.length) {
        const gap = groups[i + 1].center - groups[i].center;
        const k = Math.round(gap / pitch);
        if (k >= 2 && k <= 4 && Math.abs(gap / pitch - k) <= 0.35) {
          for (let j = 1; j < k; j++) {
            out.push({ center: groups[i].center + (gap * j) / k, items: [], virtual: true, hasBlue: false });
          }
        }
      }
    }
    return out;
  };
  const cBefore = colGroups.length, rBefore = rowGroups.length;
  colGroups = fillGaps(colGroups, pitchR);
  rowGroups = fillGaps(rowGroups, pitchC);
  // 补全成功说明原先的间距估计是倍距（样本少时 robustPitch 的上中位取到大值）——
  // 用补齐后的组重估间距（此时有正常间距样本），否则下游的投影窗口/探针全被带歪。
  if (colGroups.length > cBefore) pitchC = refit(colGroups, pitchR);
  if (rowGroups.length > rBefore) pitchR = refit(rowGroups, pitchC);
  if (debug) { debug.postGaps = { pitchC: Math.round(pitchC * 10) / 10, pitchR: Math.round(pitchR * 10) / 10 }; }

  // 3.9 信号驱动网格延展：某列/行的计数条过短（1-2 方块）且颜色暗时可能整组漏检，
  // 而 pitch 正常（非缺位倍距，3.8 不触发）→ 网格比真实棋盘少一列/行。
  // 在几何外推位置检查计数条带信号（低阈值绿 glo 的投影峰值 + 横向跨度是窄条
  // ——排除托盘卡片/装饰宽块的误判），有信号则补虚拟组。
  function probeBar(kind, center) {
    if (kind === "col") {
      const x0 = Math.round(center - pitchC * 0.5), x1 = Math.round(center + pitchC * 0.5);
      const y0 = Math.round(rowGroups[0].center - pitchR * 1.6), y1 = Math.round(rowGroups[0].center - pitchR * 0.5) - 2;
      let mnx = 1e9, mxx = -1, total = 0;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x < x1; x++) if (glo[y * W + x]) { total++; if (x < mnx) mnx = x; if (x > mxx) mxx = x; }
      }
      const spread = mxx - mnx;
      // 判据：信号总量 ≥15（极淡的短条整体也只有 ~27 像素，逐行峰值可能 ≤1）+ 窄条特征
      return total >= 15 && spread >= 4 && spread <= pitchC * 0.55;
    }
    const y0 = Math.round(center - pitchR * 0.5), y1 = Math.round(center + pitchR * 0.5);
    const x0 = Math.round(colGroups[0].center - pitchC * 1.6), x1 = Math.round(colGroups[0].center - pitchC * 0.5) - 2;
    let mny = 1e9, mxy = -1, total = 0;
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y < y1; y++) if (glo[y * W + x]) { total++; if (y < mny) mny = y; if (y > mxy) mxy = y; }
    }
    const spread = mxy - mny;
    return total >= 15 && spread >= 4 && spread <= pitchR * 0.55;
  }
  for (let step = 0; step < 4; step++) {
    const last = colGroups[colGroups.length - 1];
    if (!probeBar("col", last.center + pitchC)) break;
    colGroups.push({ center: last.center + pitchC, items: [], virtual: true, hasBlue: false });
    if (debug) debug.colExtended = (debug.colExtended || 0) + 1;
  }
  for (let step = 0; step < 4; step++) {
    const last = rowGroups[rowGroups.length - 1];
    if (!probeBar("row", last.center + pitchR)) break;
    rowGroups.push({ center: last.center + pitchR, items: [], virtual: true, hasBlue: false });
    if (debug) debug.rowExtended = (debug.rowExtended || 0) + 1;
  }
  if (debug) {
    const ginfo = g => ({ center: Math.round(g.center), n: g.items.length,
      bbox: [Math.min(...g.items.map(i => i.minx)), Math.min(...g.items.map(i => i.miny)),
             Math.max(...g.items.map(i => i.maxx)), Math.max(...g.items.map(i => i.maxy))] });
    debug.colGroups = colGroups.map(ginfo);
    debug.rowGroups = rowGroups.map(ginfo);
    debug.pitchC = Math.round(pitchC); debug.pitchR = Math.round(pitchR);
    debug.barW = barW; debug.barH = barH; debug.medArea = medArea;
    debug.hBars = hBars.length; debug.vBars = vBars.length; debug.compsAll = comps.length;
    debug.hBarsCenters = hBars.map(c => [Math.round((c.minx + c.maxx) / 2), Math.round((c.miny + c.maxy) / 2), c.n]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  }

  // 4. 网格原点：列 0 中心 = 最小列组中心；行 0 中心 = 最小行组中心。
  //    目标为 0 的行/列没有计数段——由禁用格/常亮格位置补齐（向外扩展）。
  const colCenters = colGroups.map(g => g.center);
  const rowCenters = rowGroups.map(g => g.center);
  const maxCol = colGroups.length - 1, maxRow = rowGroups.length - 1;

  // 5-6. 特殊格探测 + 网格尺寸推算 + 单元格状态（公共后段，数字模式共用）
  const sized = extractCellsAndSize({ W, H, green, blue, gray, comps, medArea, C, colCenters, rowCenters, pitchC, pitchR, debug });
  const rows = sized.rows, cols = sized.cols, cells = sized.cells, special = sized.special;
  const shiftR = sized.shiftR, shiftC = sized.shiftC;
  if (rows < 2 || cols < 2 || rows > 10 || cols > 10) {
    return { ok: false, reason: `推断棋盘尺寸异常（${rows}×${cols}）——请截取完整谜题界面后重试。`, ...(debug ? { debug } : {}) };
  }

  // 计数段计数：计数段的 UI 单元（空心矩形）按 unitPitch 等距排列。
  // 扫描窗口由网格推导（列组=棋盘上方竖条带，行组=棋盘左侧横条带）。
  // 步骤：投影 → 显著段 → 段中心按全局条距聚类 → 簇数 = 目标数
  const thickness = median(bars.map(c => Math.min(c.maxx - c.minx, c.maxy - c.miny))) || 8;
  // 投影窗口。内界必须停在棋盘格子边界之外（-0.5×pitch - 2）：越界会把棋盘
  // 装饰边框线/锁定格的绿色内容带进投影，读数被污染（多算方块或空转）。
  function tallyWindow(kind, g) {
    if (kind === "col") {
      return {
        axis: "y",
        x0: Math.round(g.center - pitchC * 0.5), x1: Math.round(g.center + pitchC * 0.5),
        y0: Math.round(rowCenters[0] - pitchR * 1.6), y1: Math.round(rowCenters[0] - pitchR * 0.5) - 2,
      };
    }
    return {
      axis: "x",
      y0: Math.round(g.center - pitchR * 0.5), y1: Math.round(g.center + pitchR * 0.5),
      x0: Math.round(colCenters[0] - pitchC * 1.6), x1: Math.round(colCenters[0] - pitchC * 0.5) - 2,
    };
  }
  function buildProj(mask, kind, g) {
    const w = tallyWindow(kind, g);
    const x0 = w.x0, x1 = w.x1, y0 = w.y0, y1 = w.y1, axis = w.axis;
    const proj = [];
    for (let v = (axis === "y" ? y0 : x0); v <= (axis === "y" ? y1 : x1); v++) {
      let n = 0;
      if (axis === "y") { for (let x = x0; x < x1; x++) if (mask[v * W + x]) n++; }
      else { for (let y = y0; y < y1; y++) if (mask[y * W + v]) n++; }
      proj.push(n);
    }
    return proj;
  }
  function spansOf(proj, th) {
    const spans = [];
    let s = -1;
    for (let i = 0; i <= proj.length; i++) {
      const on = i < proj.length && proj[i] >= th;
      if (on && s < 0) s = i;
      if (!on && s >= 0) { spans.push([(s + i - 1) / 2, i - s]); s = -1; } // [中心, 长度]
    }
    return spans;
  }
  // 自相关找主周期（取达到 0.8×峰值相关的最小滞后，排除倍频谐波）
  function tallyPeriod(proj, minLag, maxLag) {
    const n = proj.length;
    const mean = proj.reduce((a, b) => a + b, 0) / n;
    let c0 = 0;
    for (const v of proj) c0 += (v - mean) * (v - mean);
    if (c0 < 1e-6) return null;
    let maxNorm = 0;
    const norms = [];
    for (let lag = minLag; lag <= Math.min(maxLag, n - 3); lag++) {
      let s = 0;
      for (let i = 0; i + lag < n; i++) s += (proj[i] - mean) * (proj[i + lag] - mean);
      const norm = s / c0;
      norms.push([lag, norm]);
      if (norm > maxNorm) maxNorm = norm;
    }
    if (maxNorm < 0.15) return null;
    for (const [lag, norm] of norms) if (norm >= maxNorm * 0.8) return lag;
    return null;
  }
  function countTally(mask, kind, g, unitPitch, dbg) {
    const w = tallyWindow(kind, g);
    const proj = buildProj(mask, kind, g);
    const mx = Math.max(...proj, 0);
    if (mx < 3) { if (dbg) dbg.push({ kind, win: [w.x0, w.x1, w.y0, w.y1], mx, res: 0 }); return 0; }
    const th = Math.max(2, mx * 0.15);
    const spans = spansOf(proj, th);
    if (!spans.length) { if (dbg) dbg.push({ kind, win: [w.x0, w.x1, w.y0, w.y1], mx, res: 0 }); return 0; }
    // 计数原理：首末 span 的外沿跨距 = (n-1)×单元间距 + 单元投影宽 w。
    // 对实心（单峰 span）与空心（碎片双峰 span）渲染形态均成立，对碎片丢失也稳。
    // w 取最长 span（= 完整单元的投影宽），并用 0.85×间距限幅（单元宽必小于间距）。
    const wUnit = Math.min(Math.max(...spans.map(s => s[1])), unitPitch * 0.85);
    const first = spans[0], last = spans[spans.length - 1];
    const extent = (last[0] + last[1] / 2) - (first[0] - first[1] / 2);
    const res = Math.max(1, Math.round((extent - wUnit) / unitPitch) + 1);
    if (dbg) dbg.push({ kind, win: [w.x0, w.x1, w.y0, w.y1], mx, th: Math.round(th * 10) / 10,
      spans: spans.map(s => [Math.round(s[0] * 10) / 10, s[1]]),
      extent: Math.round(extent * 10) / 10, wUnit: Math.round(wUnit * 10) / 10, res });
    return res;
  }

  // 全局单元间距：相邻段中心差中，≥0.75×最大差 的中位数（排除碎片/半距差）。
  // （干净组的相邻段差 = 单元间距 ~12.5；碎片组的 4-8 差是单元内边缘对，被阈值过滤）
  // 双色：蓝色条同样贡献间距样本。低阈值绿掩码（glo）对暗色计数条也灵敏，
  // 且其 span 连续（不受渐暗断段影响）——间距估计用它更稳，失败回退 green。
  const diffs = [];
  for (const g of [...colGroups, ...rowGroups]) {
    const kind = colGroups.includes(g) ? "col" : "row";
    for (const mask of [glo, green, blue]) {
      const proj = buildProj(mask, kind, g);
      const mx = Math.max(...proj, 0);
      if (mx < 3) continue;
      const th = Math.max(2, mx * 0.15);
      const centers = spansOf(proj, th).map(s => s[0]);
      for (let i = 1; i < centers.length; i++) diffs.push(centers[i] - centers[i - 1]);
    }
  }
  let unitPitch = thickness * 1.3;
  if (diffs.length) {
    const p = clusterMode(diffs);
    unitPitch = p ? Math.max(6, p) : unitPitch;
  }
  if (debug) {
    debug.unitPitch = Math.round(unitPitch * 10) / 10;
    debug.diffs = diffs;
  }

  // 双色判定：含蓝色条的合并组数 ≥ 4（单色截图无蓝色计数条）
  const type2 = [...colGroups, ...rowGroups].filter(g => g.hasBlue).length >= 4;
  const tallyDbg = debug ? [] : null;

  // 暗色计数条读数：绿色溢出通道（g - max(r,b)，对暗色计数条灵敏、背景为 ~0）
  // 投影 + span 中心距计数（间距 = 全局 unitPitch）。
  // a) 相邻合并：差 ≤ 0.6×unitPitch 的两 span 是同一格的两条边线（空心描边方块渲染，
  //    每格贡献上下两条细线）——合并为一格的中心；b) 大段拆分：len ≥ 1.5×unitPitch
  //    的 span 是多个相邻实心方块合并的投影，按 unitPitch 拆多个中心。
  function tallyEx(mask, kind, g) {
    const proj = buildProj(mask, kind, g);
    const mx = Math.max(...proj, 0);
    if (mx < 2) return 0;
    const th = Math.max(1, mx * 0.12);
    const raw = spansOf(proj, th);
    if (!raw.length) return 0;
    const merged = [raw[0].slice()];
    for (let i = 1; i < raw.length; i++) {
      const last = merged[merged.length - 1];
      const gap = (raw[i][0] - raw[i][1] / 2) - (last[0] + last[1] / 2);
      // 合并条件：a) 间隙 ≤ 2px（同一块被 JPEG 噪声造成的断口）；
      // b) 两个都是细线（≤0.35×pitch）且间隙 ≤ 0.45×pitch（空心描边方块的上下边线对）
      const thin = last[1] <= unitPitch * 0.35 && raw[i][1] <= unitPitch * 0.35;
      if (gap <= 2 || (thin && gap <= unitPitch * 0.45)) {
        const lo = Math.min(last[0] - last[1] / 2, raw[i][0] - raw[i][1] / 2);
        const hi = Math.max(last[0] + last[1] / 2, raw[i][0] + raw[i][1] / 2);
        merged[merged.length - 1] = [(lo + hi) / 2, hi - lo];
      } else merged.push(raw[i].slice());
    }
    const centers = [];
    for (const [c, len] of merged) {
      const k = Math.max(1, Math.round(len / unitPitch));
      for (let j = 0; j < k; j++) centers.push(c - len / 2 + (len / k) * (j + 0.5));
    }
    if (centers.length < 2) return 1;
    return Math.max(1, Math.round((centers[centers.length - 1] - centers[0]) / unitPitch) + 1);
  }

  // 读数三套：主 = 严格绿阈值；辅 = 绿色溢出通道（暗条灵敏、信号弱）；
  // 低 = 低阈值绿掩码（暗条像素更多、噪声略多，实测读数最准）。
  // 虚拟组（网格补全的缺失行列）在严格阈值下无像素，用溢出/低阈值通道。
  // 格子正方形先验下行列总和必相等，且元件总格数应等于目标总和（无备用件时）——
  // 评分 = 行列和偏差 + 0.7×与托盘格数的偏差，三套取分最低者。
  const readTally = (mode) => {
    const rt = Array(rows).fill(0), ct = Array(cols).fill(0);
    const r2 = Array(rows).fill(0), c2 = Array(cols).fill(0);
    const pickMask = (g) => {
      if (mode === "lo") return glo;          // lo：全部低阈值通道
      if (mode === "ex") return gex;          // ex：全部溢出通道
      return g.virtual ? gex : green;         // main：实组严格绿、虚拟组溢出通道
    };
    const tallyFn = (mask, kind, g) => mask === green ? countTally(green, kind, g, unitPitch, mode === "main" ? tallyDbg : null) : tallyEx(mask, kind, g);
    for (const g of colGroups) {
      const i = Math.round((g.center - colCenters[0]) / pitchC) + shiftC;
      if (i < 0 || i >= cols) continue;
      ct[i] = tallyFn(pickMask(g), "col", g);
      if (type2 && g.hasBlue) c2[i] = countTally(blue, "col", g, unitPitch);
    }
    for (const g of rowGroups) {
      const i = Math.round((g.center - rowCenters[0]) / pitchR) + shiftR;
      if (i < 0 || i >= rows) continue;
      rt[i] = tallyFn(pickMask(g), "row", g);
      if (type2 && g.hasBlue) r2[i] = countTally(blue, "row", g, unitPitch);
    }
    return { rt, ct, r2, c2 };
  };
  const main = readTally("main");
  const alt = readTally("ex");
  const lo = readTally("lo");
  if (debug) debug.threeReads = { main: { r: main.rt, c: main.ct }, ex: { r: alt.rt, c: alt.ct }, lo: { r: lo.rt, c: lo.ct } };
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const cellsOf = (id) => new Set(catalog[id].shape.map(p => p.join(","))).size;
  const boardRight = colCenters[colCenters.length - 1] + pitchC * 0.5;
  const minTrayN = (pitchC * 0.3) ** 2 / 6;
  const inTray = (c) => (c.minx + c.maxx) / 2 > boardRight + pitchC * 0.35 && c.n > minTrayN;
  const trayG = recognizeTray(green, W, H, comps.filter(inTray), catalog);
  const trayB = recognizeTray(blue, W, H, (compsBlue || []).filter(inTray), catalog);
  const trayCellSum = [...trayG.matched, ...trayB.matched].reduce((s, m) => s + cellsOf(m.id), 0);
  // 行/列解耦联合择优：三套读数中行读数与列读数各自独立选，最小化
  // |行和 − 列和| + 0.7×|行和 − 托盘元件总格数|（不同掩码通道的强弱在行/列方向
  // 可能不对称——如空心描边条在 y 投影成边线对、x 投影成实心块，各自最优套不同）。
  let best = null;
  for (const rs of [main, alt, lo]) for (const cs of [main, alt, lo]) {
    const sc = Math.abs(sum(rs.rt) - sum(cs.ct)) + Math.abs(sum(rs.rt) - trayCellSum) * 0.7;
    if (!best || sc < best.sc) best = { sc, rs, cs };
  }
  const rowT = best.rs.rt, colT = best.cs.ct, row2T = best.rs.r2, col2T = best.cs.c2;
  if (debug) {
    const tag = (s) => s === main ? "main" : s === alt ? "ex" : "lo";
    debug.usedMode = tag(best.rs) + "/" + tag(best.cs);
  }
  if (tallyDbg && best.rs !== main && best.rs === lo) debug.tally = tallyDbg;
  else if (tallyDbg) debug.tally = tallyDbg;
  // 护栏校验：行/列两个方向的点亮格总数应相等，不等说明有计数段被漏数/多数
  const sumR = rowT.reduce((a, b) => a + b, 0), sumC = colT.reduce((a, b) => a + b, 0);
  if (sumR !== sumC) warnings.push(`行目标总和（${sumR}）与列目标总和（${sumC}）不一致——可能存在计数段漏识别，请核对。`);

  // 标注用：黄框 = 计数条的实际范围。实组用 items 的实际包围盒；虚拟组（暗条未被
  // 严格阈值检出）用暗条灵敏通道（glo/gex）在条带窗口内探测信号跨度，探测不到
  // 才回退窗口——所有框都贴合条的真实高度。
  const signalExtent = (kind, g) => {
    let lo = null, hi = null;
    if (kind === "col") {
      const x0 = Math.round(g.center - pitchC * 0.5), x1 = Math.round(g.center + pitchC * 0.5);
      const y0 = Math.round(rowCenters[0] - pitchR * 1.6), y1 = Math.round(rowCenters[0] - pitchR * 0.5) - 2;
      for (let y = y0; y <= y1; y++) {
        let n = 0;
        for (let x = x0; x < x1; x++) if (glo[y * W + x] || gex[y * W + x]) n++;
        if (n >= 2) { if (lo === null) lo = y; hi = y; }
      }
      return lo === null ? null : [lo - 2, hi + 2];
    }
    const y0 = Math.round(g.center - pitchR * 0.5), y1 = Math.round(g.center + pitchR * 0.5);
    const x0 = Math.round(colCenters[0] - pitchC * 1.6), x1 = Math.round(colCenters[0] - pitchC * 0.5) - 2;
    for (let x = x0; x <= x1; x++) {
      let n = 0;
      for (let y = y0; y < y1; y++) if (glo[y * W + x] || gex[y * W + x]) n++;
      if (n >= 2) { if (lo === null) lo = x; hi = x; }
    }
    return lo === null ? null : [lo - 2, hi + 2];
  };
  const tallyBoxes = [];
  for (const g of colGroups) {
    let yTop, yBot;
    if (g.items.length) {
      yTop = Math.min(...g.items.map(i => i.miny));
      yBot = Math.max(...g.items.map(i => i.maxy));
    } else {
      const ext = signalExtent("col", g);
      yTop = ext ? ext[0] : rowCenters[0] - pitchR * 1.6;
      yBot = ext ? ext[1] : rowCenters[0] - pitchR * 0.5 - 2;
    }
    tallyBoxes.push([g.center - pitchC * 0.5, yTop, g.center + pitchC * 0.5, yBot]);
  }
  for (const g of rowGroups) {
    let xL, xR;
    if (g.items.length) {
      xL = Math.min(...g.items.map(i => i.minx));
      xR = Math.max(...g.items.map(i => i.maxx));
    } else {
      const ext = signalExtent("row", g);
      xL = ext ? ext[0] : colCenters[0] - pitchC * 1.6;
      xR = ext ? ext[1] : colCenters[0] - pitchC * 0.5 - 2;
    }
    tallyBoxes.push([xL, g.center - pitchR * 0.5, xR, g.center + pitchR * 0.5]);
  }

  // 7-8. 托盘识别 + 预设交叉匹配 + 组装（公共后段）
  return assembleResult({ W, H, green, blue, comps, compsBlue, C, catalog, presets, pitchC, pitchR,
    colCenters, rowCenters, rows, cols, cells, special, shiftR, shiftC, type2, rowT, colT, row2T, col2T, tallyBoxes, debug, warnings });
}

// 数字显示模式：行列目标渲染为数字字符（棋盘上方/左侧），无计数方块条
function analyzeCircuitDigits(data, presets, opts = {}) {
  const debug = opts.debug ? {} : null;
  const catalog = opts.catalog || {};
  const W = data.width, H = data.height, D = data.data;
  const warnings = [];
  const { green, blue, gray, glo } = makeMasks(D, W, H);
  const C = 2;
  const comps = components(green, W, H, C);
  if (!comps.length) return { ok: false, reason: "未检测到绿色内容——请确认截图包含完整的电路谜题界面。" };
  const medArea = median(comps.map(c => c.n).sort((a, b) => a - b));
  const compsBlue = components(blue, W, H, C);

  const dig = detectDigitGrid(green, blue, comps, compsBlue, W, H, debug, !!opts.forceType2);
  if (!dig) return { ok: false, reason: "未识别到数字模式的行列目标（需要棋盘上方与左侧的等距数字序列）。", ...(debug ? { debug } : {}) };

  const { colCenters, rowCenters, pitchC, pitchR } = dig;
  const sized = extractCellsAndSize({ W, H, green, blue, gray, comps, medArea, C, colCenters, rowCenters, pitchC, pitchR, debug });
  const rows = sized.rows, cols = sized.cols, cells = sized.cells, special = sized.special;
  const shiftR = sized.shiftR, shiftC = sized.shiftC;
  if (rows < 2 || cols < 2 || rows > 10 || cols > 10) {
    return { ok: false, reason: `推断棋盘尺寸异常（${rows}×${cols}）——请截取完整谜题界面后重试。` };
  }

  // rowT/colT 对齐最终行号（特殊格可能使网格外扩）
  const rowT = Array(rows).fill(0), colT = Array(cols).fill(0);
  for (let i = 0; i < dig.rowT.length; i++) { const j = i + shiftR; if (j >= 0 && j < rows) rowT[j] = dig.rowT[i]; }
  for (let i = 0; i < dig.colT.length; i++) { const j = i + shiftC; if (j >= 0 && j < cols) colT[j] = dig.colT[i]; }
  const row2T = Array(rows).fill(0), col2T = Array(cols).fill(0);
  if (dig.type2) {
    for (let i = 0; i < dig.row2T.length; i++) { const j = i + shiftR; if (j >= 0 && j < rows) row2T[j] = dig.row2T[i]; }
    for (let i = 0; i < dig.col2T.length; i++) { const j = i + shiftC; if (j >= 0 && j < cols) col2T[j] = dig.col2T[i]; }
  }
  if (dig.weak) warnings.push(`有 ${dig.weak} 个数字识别置信度较低，请核对行列目标数值。`);
  // 一致性校验：同一谜题行/列两个方向的点亮格总数应相等
  const sumR = rowT.reduce((a, b) => a + b, 0), sumC = colT.reduce((a, b) => a + b, 0);
  if (sumR !== sumC) warnings.push(`行目标总和（${sumR}）与列目标总和（${sumC}）不一致——可能存在数字误识别，请核对。`);

  return assembleResult({ W, H, green, blue, comps, compsBlue, C, catalog, presets, pitchC, pitchR,
    colCenters, rowCenters, rows, cols, cells, special, shiftR, shiftC, type2: dig.type2, rowT, colT, row2T, col2T,
    tallyBoxes: dig.charBoxes, debug, warnings });
}

// 入口：先尝试数字模式（"数字"显示，识别便宜且不会误吃计数条截图——条的宽高比被字符过滤排除），
// 失败再走计数条模式（"图形"显示）。forceType2 = 用户确认是双色截图：只接受 type2 结果。
export function analyzeCircuitScreenshot(data, presets, opts = {}) {
  const r2 = analyzeCircuitDigits(data, presets, opts);
  if (r2.ok && (!opts.forceType2 || r2.type2)) return r2;
  const r1 = analyzeCircuitBars(data, presets, opts);
  if (r1.ok && (!opts.forceType2 || r1.type2)) return r1;
  if (opts.forceType2) {
    return { ok: false, reason: "强制双色：未能识别出蓝色目标（蓝/绿数字成对显示的截图才能强制双色）。",
      ...(r2.debug ? { debug: r2.debug } : {}) };
  }
  const merged = { ...r1, reason: r1.reason + "（已尝试“数字”显示模式：" + (r2.reason || "未识别") + "）" };
  if (r2.debug) merged.debug = { ...(r1.debug || {}), digitDebug: r2.debug };
  return merged;
}
