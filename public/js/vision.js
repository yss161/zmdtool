// 截图自动识别：从游戏截图中提取棋盘状态与气球库存。
// 纯函数实现（不依赖 DOM），输入 ImageData 兼容对象 {data,width,height}。
// 识别内容：
//   1. 5x5 棋盘晶格（底座亮点投票拟合）
//   2. 每格状态：禁用 / 可放置(空) / 已放气球(含升力值)
//   3. 右侧库存：各升力值数量（圆盘色相家族分类 + 徽章数字 OCR 钩子）

const DEBUG = (...a) => { if (globalThis.__VISION_DEBUG) console.log("[vision]", ...a); };

// ---------- 基础工具 ----------

function buildMasks(img) {
  const { width: W, height: H, data } = img;
  const warm = new Uint8Array(W * H);   // 暖色（黄/橙）：底座、气球盘
  const white = new Uint8Array(W * H);  // 白色：格线括号、徽章数字
  const bright = new Uint8Array(W * H); // 亮而低饱和：银白色气球盘
  for (let p = 0, i = 0; p < W * H; p++, i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (r > 100 && r - b > 45 && g - b > 30) warm[p] = 1;
    const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
    const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
    if (mx > 165 && mx - mn < 50) white[p] = 1;
    if (mx > 150 && mx - mn < 55) bright[p] = 1;
  }
  return { warm, white, bright, W, H };
}

// 8 邻接连通域，累积外接框、质心、平均色与高饱和核心色
function blobsFromMask(mask, img) {
  const { width: W, height: H, data } = img;
  const seen = new Uint8Array(W * H);
  const blobs = [];
  const stack = new Int32Array(W * H);
  for (let p = 0; p < W * H; p++) {
    if (!mask[p] || seen[p]) continue;
    let top = 0;
    stack[top++] = p; seen[p] = 1;
    let n = 0, sx = 0, sy = 0, x0 = W, y0 = H, x1 = 0, y1 = 0;
    let rs = 0, gs = 0, bs = 0, cr = 0, cg = 0, cb = 0, cn = 0;
    while (top > 0) {
      const q = stack[--top];
      const x = q % W, y = (q / W) | 0;
      n++; sx += x; sy += y;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      const i = q * 4, r = data[i], g = data[i + 1], b = data[i + 2];
      rs += r; gs += g; bs += b;
      const chroma = Math.max(r, g) - b;
      if (chroma > 60) { cr += r; cg += g; cb += b; cn++; }
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const np = ny * W + nx;
        if (mask[np] && !seen[np]) { seen[np] = 1; stack[top++] = np; }
      }
    }
    blobs.push({
      cx: sx / n, cy: sy / n, x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, area: n,
      mean: [rs / n, gs / n, bs / n],
      core: cn > 4 ? [cr / cn, cg / cn, cb / cn] : [rs / n, gs / n, bs / n],
    });
  }
  return blobs;
}

// 合并外接框距离很近的碎块（底座环常碎裂成小块）
function mergeCloseBlobs(blobs, gap) {
  const list = blobs.slice();
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        const gx = Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1);
        const gy = Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1);
        if (gx <= gap && gy <= gap) {
          const n = a.area + b.area;
          list[i] = {
            cx: (a.cx * a.area + b.cx * b.area) / n,
            cy: (a.cy * a.area + b.cy * b.area) / n,
            x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0),
            x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1),
            w: 0, h: 0, area: n,
            mean: [(a.mean[0] * a.area + b.mean[0] * b.area) / n,
                   (a.mean[1] * a.area + b.mean[1] * b.area) / n,
                   (a.mean[2] * a.area + b.mean[2] * b.area) / n],
            core: a.area >= b.area ? a.core : b.core,
          };
          list[i].w = list[i].x1 - list[i].x0 + 1;
          list[i].h = list[i].y1 - list[i].y0 + 1;
          list.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return list;
}

// ---------- 晶格拟合：成对间距投票 ----------
// 点集里大部分是棋盘底座（等间距网格），杂点（UI 图标等）不参与投票也能被排除。
// 注意：底座不满圈时，晶格原点存在“整格平移”歧义（物理网格相同、格编号不同），
// 用格边界带平均亮度裁决——正确原点的格边界正好落在格间深色缝隙上。
function gapScore(img, originX, originY, spacing) {
  const { width: W, height: H, data } = img;
  const R = Math.ceil(spacing * 0.55);
  let sum = 0, n = 0;
  for (let gy = 0; gy < 5; gy++) for (let gx = 0; gx < 5; gx++) {
    const cx = originX + gx * spacing, cy = originY + gy * spacing;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const rr = Math.max(Math.abs(dx), Math.abs(dy)) / spacing;
      if (rr < 0.44 || rr > 0.55) continue;
      const x = Math.round(cx + dx), y = Math.round(cy + dy);
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = (y * W + x) * 4;
      sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
      n++;
    }
  }
  return n ? sum / n : 255;
}

// 棋盘四角外侧的白色/亮色角标（游戏 UI 固定元素，位于角点外 ~0.1 格距处）。
// 用于裁决“整格平移”歧义：正确原点的四角区域能命中角标，错误原点落在背景上。
function cornerScore(img, masks, originX, originY, spacing) {
  const { width: W, height: H } = img;
  const { white, warm } = masks;
  const R = Math.max(3, Math.round(spacing * 0.12));
  let total = 0;
  for (const [zx, zy] of [
    [originX - 0.6 * spacing, originY - 0.6 * spacing],
    [originX + 4.6 * spacing, originY - 0.6 * spacing],
    [originX - 0.6 * spacing, originY + 4.6 * spacing],
    [originX + 4.6 * spacing, originY + 4.6 * spacing],
  ]) {
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const x = Math.round(zx + dx), y = Math.round(zy + dy);
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const p = y * W + x;
      if (white[p] || warm[p]) total++;
    }
  }
  return total;
}

// 括号白像素落在全部 25 格边带内的总量——真实间距下括号与边带对齐，倍频/分频间距会错位
function whiteBandTotal(img, masks, originX, originY, spacing) {
  const { width: W, height: H } = img;
  const { white } = masks;
  const R = Math.ceil(spacing * 0.47);
  let total = 0;
  for (let gy = 0; gy < 5; gy++) for (let gx = 0; gx < 5; gx++) {
    const cx = originX + gx * spacing, cy = originY + gy * spacing;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const rr = Math.max(Math.abs(dx), Math.abs(dy)) / spacing;
      if (rr < 0.3 || rr > 0.47) continue;
      const x = Math.round(cx + dx), y = Math.round(cy + dy);
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      if (white[y * W + x]) total++;
    }
  }
  return total;
}

function fitLattice(points, img, masks, imgMin) {
  if (points.length < 5) return null;
  // 1) 间距投票：同一行/列上成对距离 → 聚类。底座分散时可能只有倍频票，
  //    因此聚类均值及其 1/2、1/3、1/4 分频都作为间距假设参与后续择优
  const dists = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dx = Math.abs(points[i].cx - points[j].cx);
      const dy = Math.abs(points[i].cy - points[j].cy);
      if (dy < 0.18 * dx && dx > 8) dists.push(dx);
      else if (dx < 0.18 * dy && dy > 8) dists.push(dy);
    }
  }
  if (!dists.length) return null;
  dists.sort((a, b) => a - b);
  const clusters = [];
  for (let i = 0; i < dists.length;) {
    let sum = dists[i], n = 1, j = i + 1;
    while (j < dists.length && dists[j] - dists[i] <= dists[i] * 0.08) { sum += dists[j]; n++; j++; }
    clusters.push({ mean: sum / n, n });
    i = j;
  }
  const spacingCands = [];
  for (const c of clusters) {
    if (c.n < 2) continue;
    for (const k of [1, 2, 3, 4]) {
      const s = c.mean / k;
      if (s < 0.04 * imgMin || s > 0.2 * imgMin) continue;
      if (!spacingCands.some(v => Math.abs(v - s) < s * 0.05)) spacingCands.push(s);
    }
  }
  if (!spacingCands.length) return null;
  DEBUG("spacing cands", spacingCands.map(s => s.toFixed(1)).join(" "));

  // 2) 逐间距假设：原点投票 → 同票数候选按 括号对齐度/角标/计数条/缝隙亮度 择优
  let best = null;
  for (const spacing of spacingCands) {
    const usable = points.filter(p =>
      p.area >= 0.015 * spacing * spacing
      && Math.max(p.w, p.h) <= 1.15 * spacing
      && Math.max(p.w, p.h) / Math.max(1, Math.min(p.w, p.h)) <= 1.9);
    if (usable.length < 5) continue;

    // 计数条（棋盘上方的橙色长条）：中心 x 对齐棋盘中心，辅助裁决列偏移
    let barCx = null;
    for (const p of points) {
      if (p.w >= 1.2 * spacing && p.w <= 3.2 * spacing && p.h >= 0.15 * spacing && p.h <= 0.5 * spacing && p.w / p.h > 2) {
        if (!barCx || p.area > 500) barCx = p.cx;
      }
    }

    let maxCount = 0;
    const cands = [];
    const seenOrigin = new Set();
    for (const p of usable) {
      for (let ox = 0; ox < 5; ox++) for (let oy = 0; oy < 5; oy++) {
        const originX = p.cx - ox * spacing, originY = p.cy - oy * spacing;
        const okey = Math.round(originX) + "|" + Math.round(originY);
        if (seenOrigin.has(okey)) continue;
        seenOrigin.add(okey);
        let count = 0;
        for (const q of usable) {
          const gx = Math.round((q.cx - originX) / spacing);
          const gy = Math.round((q.cy - originY) / spacing);
          if (gx < 0 || gx > 4 || gy < 0 || gy > 4) continue;
          const ex = originX + gx * spacing, ey = originY + gy * spacing;
          if (Math.hypot(q.cx - ex, q.cy - ey) < spacing * 0.28) count++;
        }
        if (count > maxCount) maxCount = count;
        cands.push({ originX, originY, count });
      }
    }
    if (maxCount < 5) continue;

    let localBest = null, localKey = -Infinity;
    for (const c of cands) {
      if (c.count !== maxCount) continue;
      c.white = whiteBandTotal(img, masks, c.originX, c.originY, spacing);
      c.corner = cornerScore(img, masks, c.originX, c.originY, spacing);
      c.gap = gapScore(img, c.originX, c.originY, spacing);
      const counterMiss = barCx === null ? 0 : Math.abs(barCx - (c.originX + 2 * spacing));
      // 括号对齐度是间距真值的最强信号；角标/计数条裁决平移歧义；缝隙亮度兜底
      const key = Math.min(c.white, 4000) + Math.min(c.corner, 40) * 8 - Math.min(counterMiss, 200) * 2 - c.gap * 0.5;
      DEBUG("lattice cand", spacing.toFixed(1), c.count, "white", c.white, "corner", c.corner, "barMiss", Math.round(counterMiss), "origin", Math.round(c.originX), Math.round(c.originY));
      if (key > localKey) { localKey = key; localBest = c; }
    }
    DEBUG("spacing", spacing.toFixed(1), "bestkey", Math.round(localKey), "white", localBest && localBest.white);
    if (best === null || localKey > best.key) best = { ...localBest, spacing, key: localKey };
  }
  if (!best) return null;
  DEBUG("lattice winner", "spacing", best.spacing.toFixed(1), "count", best.count, "white", best.white, "corner", best.corner);

  // 3) 用内点微调原点与间距（两轮最小平方）
  const fit = { originX: best.originX, originY: best.originY };
  let spacing = best.spacing;
  for (let iter = 0; iter < 2; iter++) {
    const usable = points.filter(p =>
      p.area >= 0.015 * spacing * spacing
      && Math.max(p.w, p.h) <= 1.15 * spacing
      && Math.max(p.w, p.h) / Math.max(1, Math.min(p.w, p.h)) <= 1.9);
    const inl = [];
    for (const q of usable) {
      const gx = Math.round((q.cx - fit.originX) / spacing);
      const gy = Math.round((q.cy - fit.originY) / spacing);
      if (gx < 0 || gx > 4 || gy < 0 || gy > 4) continue;
      const ex = fit.originX + gx * spacing, ey = fit.originY + gy * spacing;
      if (Math.hypot(q.cx - ex, q.cy - ey) < spacing * 0.28) inl.push({ q, gx, gy });
    }
    if (inl.length < 5) return null;
    let sx = 0, sy = 0, sxy = 0, syyy = 0, n = 0;
    for (const { q, gx, gy } of inl) {
      sx += q.cx - gx * spacing; sy += q.cy - gy * spacing;
      sxy += gx; syyy += gy; n++;
    }
    const originX = sx / n, originY = sy / n;
    let numX = 0, denX = 0, numY = 0, denY = 0;
    for (const { q, gx, gy } of inl) {
      numX += (gx - (sxy / n)) * (q.cx - originX); denX += (gx - (sxy / n)) ** 2;
      numY += (gy - (syyy / n)) * (q.cy - originY); denY += (gy - (syyy / n)) ** 2;
    }
    const spX = denX > 0 ? numX / denX : spacing;
    const spY = denY > 0 ? numY / denY : spacing;
    spacing = (spX + spY) / 2;
    const baseGX = Math.round((originX - fit.originX) / spacing);
    const baseGY = Math.round((originY - fit.originY) / spacing);
    fit.originX = originX - baseGX * spacing;
    fit.originY = originY - baseGY * spacing;
    fit.count = inl.length;
  }
  DEBUG("lattice fit", fit, "spacing", spacing);
  return { originX: fit.originX, originY: fit.originY, spacing, inliers: fit.count };
}

// ---------- 色相家族（对应游戏 1/2/3/4 级气球） ----------
// 从原图盘面圆环（避开盘内数字）采样均色后分类：
//   6=橙(r-g大)  3=亮黄绿(g-b很大)  2=奶油金(g-b中等)  1=银白(几乎无彩度)
function discFamily(img, blob) {
  const { width: W, height: H, data } = img;
  const rEff = Math.max(4, Math.sqrt(blob.area / Math.PI)); // 用面积反推半径，避开装饰环干扰
  let rs = 0, gs = 0, bs = 0, n = 0;
  for (let a = 0; a < 360; a += 5) {
    for (const rr of [0.55, 0.68, 0.8]) {
      const x = Math.round(blob.cx + rr * rEff * Math.cos(a * Math.PI / 180));
      const y = Math.round(blob.cy + rr * rEff * Math.sin(a * Math.PI / 180));
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = (y * W + x) * 4;
      rs += data[i]; gs += data[i + 1]; bs += data[i + 2]; n++;
    }
  }
  if (!n) return 0;
  const r = rs / n, g = gs / n, b = bs / n;
  DEBUG("disc ring", Math.round(blob.cx), Math.round(blob.cy), "rgb", Math.round(r), Math.round(g), Math.round(b));
  if (r - g >= 26) return 6;
  if (g - b >= 95) return 3;
  if (g - b >= 16) return 2;
  return 1;
}

// ---------- 数字 OCR（模板由调用方注入，浏览器用 canvas 渲染字体） ----------
function ocrMaskFromRegion(img, x0, y0, x1, y1, white) {
  const { width: W } = img;
  const ptSet = new Set();
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (x < 0 || y < 0 || x >= W || y >= img.height) continue;
    const p = y * W + x;
    if (white[p]) ptSet.add(p);
  }
  if (ptSet.size < 6) return null;
  // 只保留最大的连通域（数字笔画相连；装饰环弧线/杂点是独立小块）
  let best = null;
  while (ptSet.size) {
    const start = ptSet.values().next().value;
    ptSet.delete(start);
    const stack = [start];
    const pixels = [];
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    while (stack.length) {
      const p = stack.pop();
      pixels.push(p);
      const x = p % W, y = (p / W) | 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const np = p + dy * W + dx;
        if (ptSet.has(np)) { ptSet.delete(np); stack.push(np); }
      }
    }
    if (!best || pixels.length > best.pixels.length) best = { pixels, minX, minY, maxX, maxY };
  }
  const { pixels, minX, minY, maxX, maxY } = best;
  if (pixels.length < 6 || maxX - minX < 1 || maxY - minY < 4) return null; // 允许"1"这类细数字
  const w = maxX - minX + 1, h = maxY - minY + 1;
  const m = new Uint8Array(w * h);
  for (const p of pixels) {
    const x = p % W, y = (p / W) | 0;
    m[(y - minY) * w + (x - minX)] = 1;
  }
  return { mask: m, w, h, count: pixels.length };
}

export function padNormalize(digitMask, DW = 20, DH = 28) {
  const { mask, w, h } = digitMask;
  const out = new Float32Array(DW * DH);
  const scale = Math.min((DW - 2) / w, (DH - 2) / h);
  const nw = Math.max(1, Math.round(w * scale)), nh = Math.max(1, Math.round(h * scale));
  const offX = (DW - nw) >> 1, offY = (DH - nh) >> 1;
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
    const sx = Math.min(w - 1, Math.floor(x / scale)), sy = Math.min(h - 1, Math.floor(y / scale));
    if (mask[sy * w + sx]) out[(y + offY) * DW + (x + offX)] = 1;
  }
  return out;
}

function matchDigit(digitMask, ocr) {
  if (!ocr) return null;
  const target = padNormalize(digitMask);
  let best = null;
  for (let d = 0; d <= 9; d++) {
    for (const tmpl of ocr.templates(d)) {
      let inter = 0, union = 0;
      for (let i = 0; i < target.length; i++) {
        const a = target[i], b = tmpl[i];
        if (a || b) union++;
        if (a && b) inter++;
      }
      const iou = union ? inter / union : 0;
      if (!best || iou > best.score) best = { digit: d, score: iou };
    }
  }
  return best;
}

// ---------- 棋盘方块检测（主晶格来源） ----------
// 棋盘格子是中灰圆角方块（亮度高于格间深色缝隙），直接检测其中心得到完整晶格：
// 没有"整格平移歧义"，天然支持任意行列数（5x5 / 6x6 / 6x5…）。
// 容忍格子被气球盘覆盖（盘周围仍有一圈灰环可检）、容忍个别格子漏检（格点索引连续性推断范围）。
function medianOf(arr) { const a = [...arr].sort((x, y) => x - y); return a.length ? a[(a.length / 2) | 0] : 0; }

function detectSquareLattice(img) {
  const { width: W, height: H, data } = img;
  const minWH = Math.min(W, H);
  const gray = new Uint8Array(W * H);
  for (let p = 0, i = 0; p < W * H; p++, i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    if (l >= 36 && l <= 122 && Math.abs(r - g) < 30 && Math.abs(g - b) < 30) gray[p] = 1;
  }
  // 方块候选：近方形、边长在 [0.07, 0.34]×minWH
  const cands = [];
  const seen = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) {
    if (!gray[p] || seen[p]) continue;
    const stack = [p]; seen[p] = 1;
    let n = 0, sx = 0, sy = 0, x0 = W, y0 = H, x1 = 0, y1 = 0;
    while (stack.length) {
      const q = stack.pop(); const x = q % W, y = (q / W) | 0;
      n++; sx += x; sy += y;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const np = ny * W + nx;
        if (gray[np] && !seen[np]) { seen[np] = 1; stack.push(np); }
      }
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (n < 120) continue;
    if (w < 0.07 * minWH || w > 0.34 * minWH || h < 0.07 * minWH || h > 0.34 * minWH) continue;
    if (w / h > 1.5 || h / w > 1.5) continue;
    cands.push({ cx: sx / n, cy: sy / n, w, h, n });
  }
  if (cands.length < 8) return null;

  // 单轴等距格点拟合：先聚类同轴抖动值（同一列方块的质心有 ±2px 抖动），
  // 再取簇间距中位为 pitch（容忍缺格：间隙为 2×pitch），格点索引连续性推断范围
  function fitAxis(values, mergeTol) {
    const vs0 = values.map(v => Math.round(v)).sort((a, b) => a - b);
    const vs = [];
    for (const v of vs0) {
      if (vs.length && v - vs[vs.length - 1] <= mergeTol) vs[vs.length - 1] = Math.round((vs[vs.length - 1] + v) / 2);
      else vs.push(v);
    }
    if (vs.length < 3) return null;
    const diffs = [];
    for (let i = 1; i < vs.length; i++) diffs.push(vs[i] - vs[i - 1]);
    const mn = diffs[0];
    let pitch = medianOf(diffs.filter(d => d <= mn * 1.7));
    if (!pitch || pitch < 0.04 * minWH) return null;
    let origin = vs[0];
    for (let iter = 0; iter < 2; iter++) {
      const kept = vs.filter(v => Math.abs(v - (origin + Math.round((v - origin) / pitch) * pitch)) <= pitch * 0.3);
      if (kept.length < 3) return null;
      let sx = 0, n = 0;
      for (const v of kept) { sx += v - Math.round((v - origin) / pitch) * pitch; n++; }
      origin = sx / n;
      const pairs = kept.map(v => [Math.round((v - origin) / pitch), v - origin]).filter(q => q[0] > 0);
      if (pairs.length >= 2) {
        const mx = pairs.reduce((s, q) => s + q[0], 0) / pairs.length;
        let num = 0, den = 0;
        for (const [k, v] of pairs) { num += (k - mx) * v; den += (k - mx) * (k - mx); }
        if (den > 0) pitch = num / den;
      }
    }
    // 索引连续性：从 0 开始允许最多 2 格缺口，之外的方块视为异物丢弃
    const idx = vs.map(v => Math.round((v - origin) / pitch));
    const keptIdx = [];
    for (let i = 0; i < vs.length; i++) {
      if (idx[i] > keptIdx.length && idx[i] - keptIdx.length > 2) continue;
      keptIdx.push(idx[i]);
    }
    const count = (keptIdx.length ? Math.max(...keptIdx) : -1) + 1;
    if (count < 3) return null;
    return { origin, pitch, count };
  }
  const fx = fitAxis(cands.map(c => c.cx), Math.max(6, medianOf(cands.map(c => c.w)) * 0.5));
  const fy = fitAxis(cands.map(c => c.cy), Math.max(6, medianOf(cands.map(c => c.h)) * 0.5));
  if (!fx || !fy) return null;
  // 方块中心须同时落在 x/y 格点上
  const kept = cands.filter(c => {
    const kx = Math.round((c.cx - fx.origin) / fx.pitch);
    const ky = Math.round((c.cy - fy.origin) / fy.pitch);
    return Math.abs(c.cx - (fx.origin + kx * fx.pitch)) <= fx.pitch * 0.3
      && Math.abs(c.cy - (fy.origin + ky * fy.pitch)) <= fy.pitch * 0.3;
  });
  if (kept.length < 8) return null;
  // 范围：只统计与保留方块相连的格点（防止远处 UI 方块撑大范围）
  const cols = Math.min(fx.count, Math.max(...kept.map(c => Math.round((c.cx - fx.origin) / fx.pitch))) + 1);
  const rows = Math.min(fy.count, Math.max(...kept.map(c => Math.round((c.cy - fy.origin) / fy.pitch))) + 1);
  if (cols < 3 || rows < 3 || cols > 9 || rows > 9) return null;
  DEBUG("square lattice", "origin", Math.round(fx.origin), Math.round(fy.origin),
    "pitch", fx.pitch.toFixed(1), fy.pitch.toFixed(1), "cols", cols, "rows", rows, "kept", kept.length, "/", cands.length);
  return { originX: fx.origin, originY: fy.origin, spacing: (fx.pitch + fy.pitch) / 2, cols, rows, count: kept.length };
}

// ---------- 主入口 ----------
export function analyzeScreenshot(img, opts = {}) {
  const ocr = opts.ocrDigit || null;
  const warnings = [];
  const { data } = img;
  const { warm, white, bright, W, H } = buildMasks(img);
  const warmBlobs = mergeCloseBlobs(blobsFromMask(warm, img), 3);
  DEBUG("warm blobs", warmBlobs.length);

  const minWH = Math.min(W, H);
  const smallish = warmBlobs.filter(b => b.w >= 4 && b.w <= 0.25 * minWH && b.h >= 4 && b.h <= 0.25 * minWH);

  // 第 0 优先：直接检测棋盘格子方块（格子是中灰圆角方块，比缝隙亮）。
  // 方块中心即完整晶格——没有"整格平移歧义"，且天然支持任意行列数（5x5/6x6/6x5…）。
  // 失败时回退：暖色亮点投票拟合（5x5 假设，兼容旧截图）。
  let lattice = detectSquareLattice(img);
  let latticeSource = "squares";
  let cols = lattice ? lattice.cols : 5;
  let rows = lattice ? lattice.rows : 5;
  if (!lattice) {
    const discish = warmBlobs.filter(b =>
      (b.w > 0.25 * minWH || b.h > 0.25 * minWH) && b.w < 0.6 * minWH
      && Math.max(b.w, b.h) / Math.max(1, Math.min(b.w, b.h)) <= 1.9);
    lattice = fitLattice(smallish.concat(discish), img, { white, warm }, minWH);
    latticeSource = "warm-vote";
  }
  if (!lattice) {
    return { ok: false, reason: "未能在截图中定位棋盘（找不到足够的有规律底座亮点）", warnings };
  }
  const spacing = lattice.spacing;
  DEBUG("lattice", lattice, "spacing", spacing, latticeSource);

  // 棋盘右边界（用于划分棋盘区 / 库存区）
  const boardRight = lattice.originX + spacing * (cols - 1 + 0.62);

  // 分配色块：实心圆核=气球盘，小暖点=底座
  const discMask = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) discMask[p] = warm[p] | bright[p];
  const isDiscSize = (b) => b.w >= spacing * 0.38 && b.h >= spacing * 0.36 && b.w <= spacing * 1.05 && b.h <= spacing * 1.05;
  const solid = (b) => b.area >= 0.42 * b.w * b.h; // 盘面是实心圆；文字笔画/装饰环填充率低
  // 候选盘：实心核，或核+装饰环粘连后的整体；嵌套重叠时保留填充率高的内核
  const rawDiscs = blobsFromMask(discMask, img)
    .filter(b => isDiscSize(b) && (b.fill = b.area / (b.w * b.h)) >= 0.24);
  const discCands = rawDiscs.filter(a =>
    !rawDiscs.some(b => b !== a && b.fill > a.fill &&
      Math.abs(b.cx - a.cx) < (a.w + b.w) / 4 && Math.abs(b.cy - a.cy) < (a.h + b.h) / 4));
  const sockets = warmBlobs.filter(b => b.w < spacing * 0.3 && b.h < spacing * 0.3 && b.area >= 3);

  // 每格分类（cols × rows 任意规模；坐标以棋盘中心为原点，偶数规模允许半格）
  const cells = [];
  for (let gy = 0; gy < rows; gy++) for (let gx = 0; gx < cols; gx++) {
    const cx = lattice.originX + gx * spacing, cy = lattice.originY + gy * spacing;
    const half = spacing * 0.44;
    let disc = null;
    for (const d of discCands) {
      if (Math.abs(d.cx - cx) < spacing * 0.32 && Math.abs(d.cy - cy) < spacing * 0.32) { disc = d; break; }
    }
    if (disc) {
      cells.push({ gx, gy, x: gx - (cols - 1) / 2, y: gy - (rows - 1) / 2, state: "balloon", value: discFamily(img, disc), blob: disc });
      continue;
    }
    // 可放置判定：以格中心是否有黄点底座为准（悬停高亮格、装饰角标都没有黄点）
    let hasSocket = false;
    for (const s of sockets) {
      if (Math.abs(s.cx - cx) < spacing * 0.3 && Math.abs(s.cy - cy) < spacing * 0.3) { hasSocket = true; break; }
    }
    const state = hasSocket ? "fillable" : "disabled";
    cells.push({ gx, gy, x: gx - (cols - 1) / 2, y: gy - (rows - 1) / 2, state, value: null });
    DEBUG(`cell(${gx},${gy}) socket=${hasSocket} -> ${state}`);
  }

  const fillable = cells.filter(c => c.state === "fillable").length;
  const balloons = cells.filter(c => c.state === "balloon");
  if (fillable + balloons.length < 5) {
    warnings.push("棋盘可识别的格子较少，识别结果可能不可靠，请核对棋盘。");
  }

  // ---------- 库存识别：棋盘右侧的气球盘列 ----------
  // 先按 x 聚类找“盘列”（排除右侧文字等杂块），再按 y 分行；
  // 行序必须为降序（4级→1级），以此剔除水印图标等混入的假盘
  const boardTopY = lattice.originY - spacing * 0.5;
  const invCands = discCands.filter(d => d.cx > boardRight + spacing * 0.4 && d.cy > boardTopY - spacing);
  let invDiscs = invCands;
  if (invCands.length > 2) {
    const colClusters = [];
    for (const d of invCands.slice().sort((a, b) => a.cx - b.cx)) {
      const c = colClusters.find(c => Math.abs(c.cx - d.cx) < spacing * 0.3);
      if (c) { c.items.push(d); c.cx = (c.cx * (c.items.length - 1) + d.cx) / c.items.length; }
      else colClusters.push({ cx: d.cx, items: [d] });
    }
    colClusters.sort((a, b) => b.items.length - a.items.length);
    if (colClusters[0].items.length >= 3) invDiscs = colClusters[0].items;
  }
  const invRows = [];
  for (const d of invDiscs.slice().sort((a, b) => a.cy - b.cy)) {
    const invRow = invRows.find(r => Math.abs(r.cy - d.cy) < spacing * 0.6);
    if (invRow) { invRow.items.push(d); invRow.cy = (invRow.cy * (invRow.items.length - 1) + d.cy) / invRow.items.length; }
    else invRows.push({ cy: d.cy, items: [d] });
  }
  const inventory = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  const badgeCrops = [];
  const orderValues = [6, 3, 2, 1]; // 游戏内从上到下：4级→1级
  // 类别初判：环形采样色相家族；顺序兜底
  const rowDiscs = invRows.map(invRow => invRow.items.sort((a, b) => b.area - a.area)[0]);
  const rawValues = rowDiscs.map((disc, idx) => discFamily(img, disc) || orderValues[idx] || 0);
  // 行序校验：值序列必须严格降序且来自 [6,3,2,1]；不满足时（水印假盘/误判）按行数取
  // 最匹配的降序子序列校正；行数超过 4 时只保留最下方 4 行
  let values = rawValues.slice();
  const descending = (arr) => arr.every((v, i) => i === 0 || v < arr[i - 1]);
  if (invRows.length > 4) {
    invRows.splice(0, invRows.length - 4);
    rowDiscs.splice(0, rowDiscs.length - 4);
    values = rawValues.slice(-4);
  }
  if (!descending(values)) {
    let bestSub = null, bestAgree = -1;
    for (let mask = 0; mask < 16; mask++) {
      const sub = orderValues.filter((_, i) => mask & (1 << i));
      if (sub.length !== invRows.length) continue;
      const agree = sub.filter((v, i) => v === values[i]).length;
      if (agree > bestAgree) { bestAgree = agree; bestSub = sub; }
    }
    if (bestSub) {
      DEBUG("invRow order fix", values.join(","), "->", bestSub.join(","));
      values = bestSub;
    }
  }
  invRows.forEach((invRow, idx) => {
    const disc = rowDiscs[idx];
    const value = values[idx];
    // 徽章数量：盘右下角暗圆里的白色数字。框用间距相对尺寸锚定，
    // 锚点取盘外接框中心（质心会被粘连的装饰环拉偏）
    const rDisc = spacing * 0.237;
    const acx = (disc.x0 + disc.x1) / 2, acy = (disc.y0 + disc.y1) / 2;
    const bx0 = Math.round(acx + rDisc * 1.5), by0 = Math.round(acy + rDisc * 1.2);
    const bx1 = Math.round(acx + rDisc * 2.8), by1 = Math.round(acy + rDisc * 2.6);
    const dm = ocrMaskFromRegion(img, bx0, by0, bx1, by1, white);
    let count = null, ocrScore = 0;
    if (dm) {
      const m = matchDigit(dm, ocr);
      DEBUG("badge digit", value, dm.w, dm.h, m);
      if (m && m.score >= 0.45) { count = m.digit; ocrScore = m.score; }
    }
    badgeCrops.push({ value, box: [bx0, by0, bx1, by1], ocrScore });
    if (count === null) {
      count = 3; // 常见默认（本关 3/3/3/3）
      warnings.push(`无法读取 ${value} 级气球的数量徽章，已按 3 处理，请手动核对。`);
    }
    if (inventory[value] !== undefined) inventory[value] += count;
  });

  // 已放气球若与库存同类，需要从库存里扣除（中途截图场景）
  for (const b of balloons) {
    if (b.value && inventory[b.value] > 0) inventory[b.value]--;
  }

  return {
    ok: true,
    board: { cells },
    inventory,
    balloonsOnBoard: balloons.map(b => ({ x: b.x, y: b.y, value: b.value })),
    geometry: { originX: lattice.originX, originY: lattice.originY, spacing, scale: 1 },
    badgeCrops,
    warnings,
  };
}
