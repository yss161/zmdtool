// 设备修复（源石电路模块）模式：棋盘编辑、元件库、官方预设加载、求解与答案渲染。
// 依赖 circuit-solver.js（求解）、circuit-vision.js（截图识别）与 data/*.json。
import { solveCircuit, rotationsOf } from "./circuit-solver.js";
import { analyzeCircuitScreenshot } from "./circuit-vision.js";

const $ = (sel, root = document) => root.querySelector(sel);
const boardWrap = $("#c-board-wrap");
const paletteEl = $("#c-palette");
const statusEl = $("#c-status");
const checkEl = $("#c-check");

const GREEN = "#97e04c";   // 绿色元件（与游戏一致的高亮绿）
const BLUE = "#52b7ff";    // 蓝色元件

// ---------- 状态 ----------
const state = {
  rows: 5, cols: 5,
  type2: false,
  cells: [],            // rows*cols 一维：0 空 / 1 禁用 / 2 绿锁定 / 3 蓝锁定
  rowT: [], colT: [], row2T: [], col2T: [],
  supply: {},           // id -> { g, b } 配置数量（含备用）
  placed: [],           // { uid, id, type, rotIdx, cells:[[r,c]..], source: 'manual'|'solver' }
  selected: null,       // { id, type, rotIdx }
  seq: 0,
  presetKey: "",
};

let CATALOG = null;
let PRESETS = null;
const rotsCache = new Map(); // id -> rotations
function rotsOf(id) {
  if (!rotsCache.has(id)) rotsCache.set(id, rotationsOf(CATALOG[id].shape));
  return rotsCache.get(id);
}

function setStatus(msg, cls = "") {
  statusEl.textContent = msg;
  statusEl.className = "status " + cls;
}

// ---------- 数据加载 ----------
// cache: "no-cache" 保证目录/关卡数据更新后浏览器不使用过期缓存
async function loadData() {
  const [cat, pre] = await Promise.all([
    fetch("data/circuit-config.json?v=20261008", { cache: "no-cache" }).then(r => r.json()),
    fetch("data/circuit-presets.json?v=20261008", { cache: "no-cache" }).then(r => r.json()),
  ]);
  CATALOG = cat;
  PRESETS = pre;
}

// ---------- 基础查询 ----------
const cellState = (r, c) => state.cells[r * state.cols + c];
function occMap() {
  const m = new Map();
  state.placed.forEach((p, i) => { for (const [r, c] of p.cells) m.set(r + "," + c, i); });
  return m;
}
function placedCount(id, type) {
  return state.placed.filter(p => p.id === id && p.type === type).length;
}
function remaining(id, type) {
  const s = state.supply[id] || { g: 0, b: 0 };
  return Math.max(0, (type === 1 ? s.g : s.b) - placedCount(id, type));
}
function targetSums() {
  const sum = a => a.reduce((x, y) => x + y, 0);
  return { g: sum(state.rowT), b: sum(state.row2T), lockedG: 0, lockedB: 0 };
}
function lockedCounts() {
  let g = 0, b = 0;
  for (const s of state.cells) { if (s === 2) g++; else if (s === 3) b++; }
  return { g, b };
}

// ---------- 棋盘渲染 ----------
function cellPx() {
  // 以棋盘列的实际可用宽度计算（目标表头 52 + 内边距 32），上限与气球模式一致
  const area = document.querySelector("#page-circuit .board-area");
  const colW = area && area.clientWidth > 100 ? area.clientWidth : Math.max(380, window.innerWidth - 720);
  const availH = window.innerHeight - 290;
  const off = state.type2 ? 2 : 1;
  return Math.max(36, Math.min(84, Math.floor(Math.min(availH / (state.rows + off), (colW - 32 - off * 52) / state.cols)) || 48));
}

function targetInput(kind, index, value) {
  // kind: 'row' | 'col' | 'row2' | 'col2'
  const inp = document.createElement("input");
  inp.type = "number";
  inp.min = "0"; inp.max = "10";
  inp.value = value || 0;
  inp.className = "c-target " + (kind.endsWith("2") ? "blue" : "green");
  inp.title = (kind.endsWith("2") ? "蓝色" : "绿色") + (kind.startsWith("row") ? "行" : "列") + "目标";
  inp.addEventListener("change", () => {
    const v = Math.max(0, Math.min(10, Math.round(Number(inp.value) || 0)));
    inp.value = v;
    state[kind][index] = v;
    refreshChecks();
  });
  return inp;
}

function renderBoard() {
  const occ = occMap();
  // 每块元件的标签锚点（r,c 最小的格子）
  const anchors = new Map();
  state.placed.forEach((p, i) => {
    let ar = Infinity, ac = Infinity;
    for (const [r, c] of p.cells) { if (r < ar || (r === ar && c < ac)) { ar = r; ac = c; } }
    anchors.set(i, [ar, ac]);
  });
  const size = cellPx();
  boardWrap.style.setProperty("--cb-cell", size + "px");
  boardWrap.innerHTML = "";
  // 头部偏移：单色 1（1 行 1 列目标），双色 2（顶/左各两组目标，仿 efsim 分行分列）
  const off = state.type2 ? 2 : 1;
  boardWrap._off = off;
  const grid = document.createElement("div");
  grid.className = "cboard";
  grid.style.gridTemplateColumns = `repeat(${off}, 52px) repeat(${state.cols}, var(--cb-cell))`;
  grid.style.gridTemplateRows = `repeat(${off}, 46px) repeat(${state.rows}, var(--cb-cell))`;

  // 角标：行/列 斜分标签（双色时跨 2×2）——斜线用 SVG 直线（抗锯齿，渐变硬色标会有锯齿）
  const corner = document.createElement("div");
  corner.className = "c-corner";
  corner.innerHTML = '<svg class="c-corner-line" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><line x1="0" y1="0" x2="100" y2="100" vector-effect="non-scaling-stroke"/></svg><span class="c-h">行</span><span class="c-v">列</span>';
  corner.style.gridArea = `1 / 1 / ${off + 1} / ${off + 1}`;
  grid.appendChild(corner);

  // 目标组：双色时顶部第一行蓝、第二行绿；左侧第一列蓝、第二列绿（同 efsim 排布）
  // 组容器用与棋盘同宽/同高的网格轨道，数字盒逐格对齐到对应的列/行
  const kinds = state.type2 ? ["blue", "green"] : ["green"];
  kinds.forEach((kind, i) => {
    const pos = i + 1; // 头部中的序位
    const cg = document.createElement("div");
    cg.className = `tgroup ${kind} row-group`;
    cg.style.gridArea = `${pos} / ${off + 1} / ${pos + 1} / ${off + state.cols + 1}`;
    cg.style.gridTemplateColumns = `repeat(${state.cols}, var(--cb-cell))`;
    for (let c = 0; c < state.cols; c++) {
      cg.appendChild(targetInput(kind === "blue" ? "col2" : "col", c, kind === "blue" ? state.col2T[c] : state.colT[c]));
    }
    grid.appendChild(cg);
    const rg = document.createElement("div");
    rg.className = `tgroup ${kind} col-group`;
    rg.style.gridArea = `${off + 1} / ${pos} / ${off + state.rows + 1} / ${pos + 1}`;
    rg.style.gridTemplateRows = `repeat(${state.rows}, var(--cb-cell))`;
    for (let r = 0; r < state.rows; r++) {
      rg.appendChild(targetInput(kind === "blue" ? "row2" : "row", r, kind === "blue" ? state.row2T[r] : state.rowT[r]));
    }
    grid.appendChild(rg);
  });

  // 棋盘格（自动流入剩余区域；已放元件由上方 SVG 整体渲染，不在格内画块）
  const labelDefs = []; // [pi, ar, ac]
  for (let r = 0; r < state.rows; r++) {
    for (let c = 0; c < state.cols; c++) {
      const st = cellState(r, c);
      const el = document.createElement("div");
      el.className = "ccell s" + st;
      el.dataset.r = r; el.dataset.c = c;
      if (st === 1) el.title = "禁用格（右键切换状态）";
      else if (st === 2) el.title = "绿色常亮锁定（已计入目标）";
      else if (st === 3) el.title = "蓝色常亮锁定（已计入目标）";
      el.addEventListener("pointerenter", () => onCellHover(r, c));
      el.addEventListener("click", () => onCellClick(r, c));
      el.addEventListener("contextmenu", (ev) => { ev.preventDefault(); cycleCell(r, c); });
      grid.appendChild(el);
    }
  }
  boardWrap.appendChild(grid);

  // 元件整体渲染层：每块元件一个并集填充 + 外轮廓亮描边（圆角多联形状，仿 efsim）
  if (state.placed.length) {
    const SVG_NS = "http://www.w3.org/2000/svg";
    const overlay = document.createElementNS(SVG_NS, "svg");
    overlay.setAttribute("class", "pieces-overlay");
    overlay.setAttribute("viewBox", `0 0 ${state.cols} ${state.rows}`);
    overlay.style.left = 16 + off * 52 + "px";
    overlay.style.top = 16 + off * 46 + "px";
    overlay.style.width = state.cols * size + "px";
    overlay.style.height = state.rows * size + "px";
    for (const [pi, p] of state.placed.entries()) {
      const color = CATALOG[p.id]?.color || (p.type === 2 ? BLUE : GREEN);
      const rim = p.type === 2 ? "#52b7ff" : mixWhite(color, 0.62);
      for (const loop of pieceOutlineLoops(p.cells)) {
        const d = roundedLoopPath(loop, 0.16);
        const fill = document.createElementNS(SVG_NS, "path");
        fill.setAttribute("d", d);
        fill.setAttribute("fill", color);
        fill.setAttribute("fill-rule", "evenodd");
        overlay.appendChild(fill);
        const stroke = document.createElementNS(SVG_NS, "path");
        stroke.setAttribute("d", d);
        stroke.setAttribute("fill", "none");
        stroke.setAttribute("stroke", rim);
        stroke.setAttribute("stroke-width", 0.09);
        stroke.setAttribute("stroke-linejoin", "round");
        overlay.appendChild(stroke);
      }
    }
    boardWrap.appendChild(overlay);
    // 编号标签：锚定在元件左上角的格子上（置于覆盖层之上）
    for (const [pi, [ar, ac]] of anchors.entries()) {
      const lbl = document.createElement("span");
      lbl.className = "piece-label";
      lbl.textContent = pi + 1;
      lbl.style.left = 16 + off * 52 + ac * size + 4 + "px";
      lbl.style.top = 16 + off * 46 + ar * size + 4 + "px";
      boardWrap.appendChild(lbl);
    }
  }
  updateCounter();
  refreshChecks();
}

function cycleCell(r, c) {
  const idx = r * state.cols + c;
  const order = state.type2 ? [0, 1, 2, 3] : [0, 1, 2];  // 非蓝色模式没有蓝锁
  const cur = order.indexOf(state.cells[idx]);
  state.cells[idx] = order[(cur + 1) % order.length];
  renderBoard();
}

function onCellHover(r, c) {
  clearGhost();
  if (!state.selected) return;
  const { id, type, rotIdx } = state.selected;
  const shape = rotsOf(id)[rotIdx % rotsOf(id).length];
  const maxR = Math.max(...shape.map(p => p[0]));
  const maxC = Math.max(...shape.map(p => p[1]));
  const r0 = Math.max(0, Math.min(r, state.rows - 1 - maxR));
  const c0 = Math.max(0, Math.min(c, state.cols - 1 - maxC));
  const occ = occMap();
  const ok = remaining(id, type) > 0 && shape.every(([dr, dc]) => {
    const rr = r0 + dr, cc = c0 + dc;
    return cellState(rr, cc) === 0 && !occ.has(rr + "," + cc);
  });
  const grid = boardWrap.querySelector(".cboard");
  // 子元素序：角标(1) + 列目标组(off) + 行目标组(off) + 格子按行主序
  const off = boardWrap._off || 1;
  for (const [dr, dc] of shape) {
    const el = grid.children[1 + 2 * off + (r0 + dr) * state.cols + (c0 + dc)];
    if (el) el.classList.add(ok ? "ghost-ok" : "ghost-bad");
  }
  boardWrap._ghost = { r0, c0, shape, ok };
}

function clearGhost() {
  boardWrap._ghost = null;
  boardWrap.querySelectorAll(".ghost-ok, .ghost-bad").forEach(el => el.classList.remove("ghost-ok", "ghost-bad"));
}

function onCellClick(r, c) {
  const occ = occMap();
  const pi = occ.get(r + "," + c);
  if (pi !== undefined) {
    // 点击已放元件 → 收回
    const [p] = state.placed.splice(pi, 1);
    setStatus(`已收回 1 块「${CATALOG[p.id].name}」${p.type === 2 ? "（蓝）" : ""}。`);
    renderBoard(); renderPalette();
    return;
  }
  if (!state.selected) return;
  const g = boardWrap._ghost;
  if (!g || !g.ok) { setStatus(remaining(state.selected.id, state.selected.type) <= 0 ? "该元件数量不足，可调大右侧库存或先收回已放的。" : "这里放不下：元件不能压到禁用/锁定格或已放元件。"); return; }
  state.placed.push({
    uid: ++state.seq, id: state.selected.id, type: state.selected.type,
    rotIdx: state.selected.rotIdx, cells: g.shape.map(([dr, dc]) => [g.r0 + dr, g.c0 + dc]),
    source: "manual",
  });
  renderBoard(); renderPalette();
}

function updateCounter() {
  // 已放格数 / 目标格数
  const placedCells = state.placed.reduce((s, p) => s + p.cells.length, 0);
  const { g, b } = targetSums();
  const lk = lockedCounts();
  const total = g + b - lk.g - lk.b;
  $("#c-placed").textContent = placedCells;
  $("#c-total").textContent = Math.max(0, total);
  $("#c-bar").style.width = total > 0 ? Math.min(100, placedCells / total * 100) + "%" : "0%";
}

function refreshChecks() {
  const { g, b } = targetSums();
  const lk = lockedCounts();
  const rowSum = state.rowT.reduce((a, b2) => a + b2, 0);
  const colSum = state.colT.reduce((a, b2) => a + b2, 0);
  const row2Sum = state.row2T.reduce((a, b2) => a + b2, 0);
  const col2Sum = state.col2T.reduce((a, b2) => a + b2, 0);
  const lines = [];
  let ok = true;
  if (rowSum !== colSum) { lines.push(`⚠ 绿色目标 行合计 ${rowSum} ≠ 列合计 ${colSum}`); ok = false; }
  if (state.type2 && row2Sum !== col2Sum) { lines.push(`⚠ 蓝色目标 行合计 ${row2Sum} ≠ 列合计 ${col2Sum}`); ok = false; }
  if (lk.g > rowSum || (state.type2 && lk.b > row2Sum)) { lines.push("⚠ 锁定常亮格数超过目标"); ok = false; }
  // 物理可行性：每行/列 绿+蓝 点亮数不能超过该行/列的格子数
  for (let r = 0; r < state.rows; r++) {
    const total = (state.rowT[r] || 0) + (state.type2 ? (state.row2T[r] || 0) : 0);
    if (total > state.cols) { lines.push(`⚠ 第 ${r + 1} 行 绿+蓝目标 ${total} 超过列数 ${state.cols}——目标不可能满足`); ok = false; }
  }
  for (let c = 0; c < state.cols; c++) {
    const total = (state.colT[c] || 0) + (state.type2 ? (state.col2T[c] || 0) : 0);
    if (total > state.rows) { lines.push(`⚠ 第 ${c + 1} 列 绿+蓝目标 ${total} 超过行数 ${state.rows}——目标不可能满足`); ok = false; }
  }
  // 元件面积 vs 目标面积
  let supplyCells = 0;
  for (const [id, s] of Object.entries(state.supply)) {
    const area = CATALOG[id]?.shape.length || 0;
    supplyCells += (s.g + (state.type2 ? s.b : 0)) * area;
  }
  const need = rowSum + row2Sum - lk.g - lk.b;
  const diff = supplyCells - need;
  lines.unshift(`目标面积 ${need}（绿${rowSum - lk.g}${state.type2 ? " + 蓝" + (row2Sum - lk.b) : ""}） · 元件面积 ${supplyCells}`);
  if (diff > 0) lines.push(`元件多 ${diff} 格：可弃置备用元件（求解时自动尝试）`);
  else if (diff < 0) { lines.push(`⚠ 元件少 ${-diff} 格：数量不足`); ok = false; }
  const legend = state.type2 ? '<span class="dot g"></span>绿色目标&ensp;&ensp;<span class="dot b"></span>蓝色目标<br>' : "";
  checkEl.innerHTML = legend + lines.map(l => l.replace(/&/g, "&amp;").replace(/</g, "&lt;")).join("\n");
  checkEl.className = "c-check" + (ok ? "" : " warn");
}

// ---------- 元件库 ----------
// 颜色向白色混合 t∈[0,1]（efsim 的 rim：元件色 75% 混白）
function mixWhite(hex, t) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const ch = (v) => Math.round(v + (255 - v) * t).toString(16).padStart(2, "0");
  return "#" + ch((n >> 16) & 255) + ch((n >> 8) & 255) + ch(n & 255);
}

// 多联方块的外轮廓路径（仅边界线段，r,c → x,y 坐标）
function outlinePath(shape, unit) {
  const key = new Set(shape.map(([r, c]) => r + "," + c));
  const segs = [];
  for (const [r, c] of shape) {
    const x = c * unit, y = r * unit;
    if (!key.has((r - 1) + "," + c)) segs.push(`M${x} ${y}L${x + unit} ${y}`);
    if (!key.has((r + 1) + "," + c)) segs.push(`M${x} ${y + unit}L${x + unit} ${y + unit}`);
    if (!key.has(r + "," + (c - 1))) segs.push(`M${x} ${y}L${x} ${y + unit}`);
    if (!key.has(r + "," + (c + 1))) segs.push(`M${x + unit} ${y}L${x + unit} ${y + unit}`);
  }
  return segs.join("");
}

function shapeSVG(id, type, rotIdx = 0, unit = 13) {
  const shape = rotsOf(id)[rotIdx % rotsOf(id).length];
  const maxR = Math.max(...shape.map(p => p[0])) + 1;
  const maxC = Math.max(...shape.map(p => p[1])) + 1;
  const color = CATALOG[id]?.color || (type === 2 ? BLUE : GREEN);
  const rim = mixWhite(color, 0.62);
  // 仿 efsim：格子相邻、25% 圆角、纯色填充 + 白色发丝内描边 + 整体外轮廓对应色边框
  const P = 2; // 外描边留白
  const rects = shape.map(([r, c]) => {
    const x = c * unit, y = r * unit;
    const hair = `<rect x="${x + 1.3}" y="${y + 1.3}" width="${unit - 2.6}" height="${unit - 2.6}" rx="${(unit * 0.2).toFixed(1)}" fill="none" stroke="rgba(255,255,255,0.26)" stroke-width="1.1"/>`;
    return `<rect x="${x}" y="${y}" width="${unit}" height="${unit}" rx="${(unit * 0.25).toFixed(1)}" fill="${color}"/>` + hair;
  }).join("");
  const outline = `<path d="${outlinePath(shape, unit)}" fill="none" stroke="${rim}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
  const w = maxC * unit + P * 2, h = maxR * unit + P * 2;
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><g transform="translate(${P} ${P})">${rects}${outline}</g></svg>`;
}

// ---------- 多联方块轮廓（SVG 整体渲染用） ----------
// 追踪多联方块的外边界，返回闭合环列表（环上为格角坐标，单位=格）
function pieceOutlineLoops(cells) {
  const set = new Set(cells.map(([r, c]) => r + "," + c));
  // 有向边界边（形状始终在行进方向左侧；外圈顺时针、内圈逆时针各自成环）
  const next = new Map(); // "x,y" 起点 → 终点 "x,y"（x=列，y=行）
  const addEdge = (x1, y1, x2, y2) => next.set(x1 + "," + y1, x2 + "," + y2);
  for (const [r, c] of cells) {
    if (!set.has((r - 1) + "," + c)) addEdge(c, r, c + 1, r);
    if (!set.has(r + "," + (c + 1))) addEdge(c + 1, r, c + 1, r + 1);
    if (!set.has((r + 1) + "," + c)) addEdge(c + 1, r + 1, c, r + 1);
    if (!set.has(r + "," + (c - 1))) addEdge(c, r + 1, c, r);
  }
  const loops = [];
  while (next.size) {
    const startKey = next.keys().next().value;
    const pts = [];
    let cur = startKey;
    while (next.has(cur)) {
      const [x, y] = cur.split(",").map(Number);
      pts.push([x, y]);
      const nk = next.get(cur);
      next.delete(cur);
      cur = nk;
    }
    loops.push(pts);
  }
  return loops;
}

// 闭合多边形 → 圆角路径（所有凸/凹角以半径 r 圆弧过渡）
function roundedLoopPath(pts, r) {
  const n = pts.length;
  let d = "";
  for (let i = 0; i < n; i++) {
    const p = pts[i], prev = pts[(i - 1 + n) % n], next = pts[(i + 1) % n];
    const v1 = [prev[0] - p[0], prev[1] - p[1]], l1 = Math.hypot(v1[0], v1[1]) || 1;
    const v2 = [next[0] - p[0], next[1] - p[1]], l2 = Math.hypot(v2[0], v2[1]) || 1;
    const rr = Math.min(r, l1 / 2, l2 / 2);
    const ax = p[0] + v1[0] / l1 * rr, ay = p[1] + v1[1] / l1 * rr;
    const bx = p[0] + v2[0] / l2 * rr, by = p[1] + v2[1] / l2 * rr;
    d += (i === 0 ? `M${ax} ${ay}` : `L${ax} ${ay}`) + `Q${p[0]} ${p[1]} ${bx} ${by}`;
  }
  return d + "Z";
}

function renderPalette() {
  paletteEl.innerHTML = "";
  // 双色模式下若没有任何蓝色元件，在元件库顶部给出提示
  if (state.type2 && !Object.values(state.supply).some(s => s.b > 0)) {
    const note = document.createElement("div");
    note.className = "pal-note";
    note.textContent = "当前未设置蓝色元件——双色关卡请为需要的元件设置“蓝”数量";
    paletteEl.appendChild(note);
  }
  for (const [id, info] of Object.entries(CATALOG)) {
    const s = state.supply[id] || { g: 0, b: 0 };
    const item = document.createElement("div");
    item.className = "pal-item" + (state.selected?.id === id ? " selected" : "");
    item.dataset.id = id;
    // 元件专属色：用于卡片左边框、选中态边框与光晕（仿 efsim）
    item.style.setProperty("--pc", info.color || GREEN);

    const prev = document.createElement("div");
    prev.className = "pal-shape" + (state.selected?.id === id && state.selected.type === 2 ? " blue" : "");
    prev.innerHTML = shapeSVG(id, state.selected?.id === id ? state.selected.type : 1, state.selected?.id === id ? state.selected.rotIdx : 0);
    prev.title = "点击选中/再点旋转（R）";
    prev.addEventListener("click", () => selectPiece(id, 1));

    const meta = document.createElement("div");
    meta.className = "pal-meta";
    const name = document.createElement("div");
    name.className = "pal-name";
    const rem1 = remaining(id, 1);
    const rem2 = state.type2 ? remaining(id, 2) : 0;
    name.innerHTML = `${info.name} <span class="pal-rem${rem1 + rem2 <= 0 ? " zero" : ""}">剩${state.type2 ? rem1 + "+" + rem2 : rem1}</span>`;
    meta.appendChild(name);

    const steppers = document.createElement("div");
    steppers.className = "pal-steppers";
    steppers.appendChild(makeStepper(id, 1, s.g));
    if (state.type2) steppers.appendChild(makeStepper(id, 2, s.b));
    meta.appendChild(steppers);

    item.append(prev, meta);
    paletteEl.appendChild(item);
  }
}

function makeStepper(id, type, value) {
  const wrap = document.createElement("div");
  wrap.className = "mini-stepper" + (type === 2 ? " blue" : "");
  const key = type === 1 ? "g" : "b";
  wrap.innerHTML =
    `<span class="mini-tag">${type === 1 ? "绿" : "蓝"}</span>` +
    `<button type="button" data-d="-1">−</button>` +
    `<input type="number" min="0" max="20" value="${value}">` +
    `<button type="button" data-d="1">+</button>`;
  const apply = (n) => {
    state.supply[id] = state.supply[id] || { g: 0, b: 0 };
    state.supply[id][key] = Math.max(0, Math.min(20, n));
    renderPalette(); refreshChecks();
  };
  wrap.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button");
    if (!btn) return;
    apply((state.supply[id]?.[key] || 0) + Number(btn.dataset.d));
  });
  wrap.querySelector("input").addEventListener("change", (ev) => {
    apply(Math.round(Number(ev.target.value) || 0));
  });
  return wrap;
}

function selectPiece(id, type) {
  if (state.selected && state.selected.id === id && state.selected.type === type) {
    state.selected.rotIdx = (state.selected.rotIdx + 1) % rotsOf(id).length; // 再点 = 旋转
  } else {
    state.selected = { id, type, rotIdx: 0 };
  }
  renderPalette();
}

function rotateSelected() {
  if (!state.selected) return;
  state.selected.rotIdx = (state.selected.rotIdx + 1) % rotsOf(state.selected.id).length;
  renderPalette();
  // 重新在悬停位置画 ghost
  const hover = boardWrap._hoverCell;
  if (hover) onCellHover(hover[0], hover[1]);
}

// ---------- 尺寸 / 重置 ----------
function initBoardArrays({ keepCells = false } = {}) {
  const n = state.rows * state.cols;
  if (!keepCells || state.cells.length !== n) {
    state.cells = Array(n).fill(0);
  }
  const fit = (arr, len) => Array.from({ length: len }, (_, i) => Math.min(10, arr[i] ?? 0));
  state.rowT = fit(state.rowT, state.rows);
  state.colT = fit(state.colT, state.cols);
  state.row2T = fit(state.row2T, state.rows);
  state.col2T = fit(state.col2T, state.cols);
  state.placed = [];
  state.selected = null;
}

// ---------- 预设 ----------
function presetLabel(key, p) {
  return p.name || key;
}
function buildPresetSelect(filter = "") {
  const sel = $("#c-preset");
  sel.innerHTML = "";
  const groups = [
    ["V4 系列 · 维序者区", []],
    ["WL 系列 · 武陵区", []],
    ["主线 / 据点 / 活动", []],
  ];
  for (const [key, p] of Object.entries(PRESETS)) {
    const label = presetLabel(key, p);
    if (filter && !(label + " " + key).toLowerCase().includes(filter.toLowerCase())) continue;
    const bucket = key.startsWith("V4_BOT") ? 0 : key.startsWith("WL_BOT") ? 1 : 2;
    groups[bucket][1].push([key, p, label]);
  }
  for (const [title, items] of groups) {
    if (!items.length) continue;
    items.sort((a, b) => a[2].localeCompare(b[2], "zh-CN", { numeric: true }));
    const og = document.createElement("optgroup");
    og.label = title;
    for (const [key, p, label] of items) {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = label;
      sel.appendChild(opt);
    }
    sel.appendChild(og);
  }
  if (state.presetKey) sel.value = state.presetKey;
}

function loadPreset(key, { autoSolve } = {}) {
  const p = PRESETS[key];
  if (!p) return;
  state.presetKey = key;
  state.rows = p.n; state.cols = p.m;
  state.type2 = !!p.isType2Activated;
  $("#c-type2").checked = state.type2;
  $("#c-rows").value = state.rows;
  $("#c-cols").value = state.cols;
  state.cells = Array(state.rows * state.cols).fill(0);
  for (const cell of p.gridCell || []) {
    const idx = cell.r * state.cols + cell.c;
    if (idx >= 0 && idx < state.cells.length) state.cells[idx] = cell.state;
  }
  state.rowT = p.target.row.slice();
  state.colT = p.target.col.slice();
  state.row2T = (p.target.row2 || []).slice();
  state.col2T = (p.target.col2 || []).slice();
  state.supply = {};
  for (const comp of p.component || []) {
    state.supply[comp.id] = { g: Number(comp.count) || 0, b: Number(comp.count2) || 0 };
  }
  state.placed = [];
  state.selected = null;
  history.replaceState(null, "", "#" + encodeURIComponent(p.name || key));
  buildPresetSelect($("#c-preset-search").value);
  $("#c-preset").value = key;
  renderBoard(); renderPalette();
  setStatus(`已载入「${p.name || key}」（${state.rows}×${state.cols}${state.type2 ? "，蓝色组件" : ""}）。`, "ok");
  if (autoSolve ?? $("#c-auto-solve").checked) setTimeout(onSolve, 60);
}

function findPresetByName(text) {
  text = text.trim().toLowerCase();
  if (!text) return null;
  for (const [key, p] of Object.entries(PRESETS)) {
    if ((p.name || "").toLowerCase() === text || key.toLowerCase() === text) return key;
  }
  return null;
}

// ---------- 求解 ----------
let solveGen = 0; // 求解代数令牌：新求解作废旧求解的延迟放置（防双重求解竞态）
function onSolve() {
  const gen = ++solveGen;
  const components = Object.entries(state.supply)
    .filter(([, s]) => s.g > 0 || s.b > 0)
    .map(([id, s]) => ({ id, count: s.g, count2: state.type2 ? s.b : 0 }));
  if (!components.length) { setStatus("还没有任何元件：在右侧元件库设置数量，或先载入一道官方预设。", "warn"); return; }
  const input = {
    rows: state.rows, columns: state.cols, type2Enabled: state.type2,
    targets: { row: state.rowT, col: state.colT, row2: state.row2T, col2: state.col2T },
    cells: state.cells.map((s, i) => ({ r: (i / state.cols) | 0, c: i % state.cols, state: s })),
    components,
    preplaced: state.placed.filter(p => p.source === "manual").map(p => ({ id: p.id, type: p.type, coordinates: p.cells })),
    catalog: CATALOG,
  };
  const res = solveCircuit(input);
  if (res.status !== "solved") {
    setStatus(`${res.message}\n（搜索 ${res.visited ?? "-"} 个节点，${(res.elapsedMs ?? 0).toFixed(0)}ms）`, "warn");
    return;
  }
  // 保留手动摆放，替换旧的求解答案，逐块动画上板（过期代数的回调直接跳过）
  state.placed = state.placed.filter(p => p.source !== "solver");
  res.placements.forEach((pl, i) => {
    setTimeout(() => {
      if (gen !== solveGen) return;
      state.placed.push({ uid: ++state.seq, id: pl.id, type: pl.type, rotIdx: 0, cells: pl.coordinates, source: "solver" });
      renderBoard(); renderPalette();
    }, i * 55);
  });
  setTimeout(() => {
    if (gen !== solveGen) return;
    renderBoard(); renderPalette();
    setStatus(`✅ 找到可行解（${(res.elapsedMs ?? 0).toFixed(0)}ms，搜索 ${res.visited} 节点）：已把 ${res.placements.length} 块元件摆上棋盘。\n绿色/蓝色行、列目标已全部满足。`, "ok");
  }, res.placements.length * 55 + 80);
}

// ---------- 事件绑定 ----------
$("#c-solve").addEventListener("click", onSolve);
$("#c-rotate").addEventListener("click", rotateSelected);
$("#c-clear").addEventListener("click", () => {
  state.placed = [];
  renderBoard(); renderPalette();
  setStatus("已清空所有摆放（棋盘与库存不变）。");
});
$("#c-reset").addEventListener("click", () => {
  initBoardArrays();
  state.supply = {};
  state.presetKey = "";
  history.replaceState(null, "", location.pathname);
  renderBoard(); renderPalette();
  buildPresetSelect($("#c-preset-search").value);
  setStatus("棋盘已重置：所有格子为空、目标清零、元件清空。");
});
$("#c-apply-size").addEventListener("click", () => {
  state.rows = Math.max(1, Math.min(10, Math.round(Number($("#c-rows").value) || 5)));
  state.cols = Math.max(1, Math.min(10, Math.round(Number($("#c-cols").value) || 5)));
  $("#c-rows").value = state.rows; $("#c-cols").value = state.cols;
  initBoardArrays({ keepCells: false });
  renderBoard(); renderPalette();
  setStatus(`棋盘尺寸已设为 ${state.rows} 行 × ${state.cols} 列（内容已清空）。`);
});
$("#c-type2").addEventListener("change", (ev) => {
  state.type2 = ev.target.checked;
  // 蓝色目标默认 0（不复制绿色目标——盲目复制会产生物理上不可行的目标）
  if (state.type2 && state.row2T.every(v => !v) && state.col2T.every(v => !v)) {
    const hasBlue = Object.values(state.supply).some(s => s.b > 0);
    setStatus(state.type2 ? (hasBlue
      ? "蓝色组件模式已启用：蓝色目标默认 0，请输入各行/列的蓝色目标数字。"
      : "蓝色组件模式已启用：当前关卡没有蓝色元件——请在右侧元件库为需要的元件设置“蓝”数量，并输入蓝色目标（仅当截图/关卡确实包含蓝色组件时）。")
      : "", "");
  }
  renderBoard(); renderPalette();
});
$("#c-preset-search").addEventListener("input", (ev) => buildPresetSelect(ev.target.value));
$("#c-preset").addEventListener("change", (ev) => loadPreset(ev.target.value));

window.addEventListener("keydown", (ev) => {
  if (document.body.dataset.mode !== "circuit") return;
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
  if (ev.key === "r" || ev.key === "R") { ev.preventDefault(); rotateSelected(); }
});

// 记录悬停格（旋转后重建 ghost 用）
boardWrap.addEventListener("pointermove", (ev) => {
  const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.(".ccell");
  if (el) boardWrap._hoverCell = [Number(el.dataset.r), Number(el.dataset.c)];
});
boardWrap.addEventListener("pointerleave", clearGhost);

let resizeTimer = null;
window.addEventListener("resize", () => {
  if (document.body.dataset.mode !== "circuit") return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderBoard, 120);
});

// ---------- 截图导入 ----------
let lastShot = null; // { image, result } 供识别标注浮层使用

function fileToImageData(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, 2600 / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const cv = document.createElement("canvas");
        cv.width = w; cv.height = h;
        const ctx = cv.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(ctx.getImageData(0, 0, w, h));
      } catch (err) { URL.revokeObjectURL(url); reject(err); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("图片解码失败")); };
    img.src = url;
  });
}

function drawCircuitOverlay() {
  if (!lastShot || !lastShot.result) return;
  const { image, result } = lastShot;
  const cv = $("#c-overlay-canvas");
  const scale = Math.min(1, 1100 / image.width);
  cv.width = Math.round(image.width * scale);
  cv.height = Math.round(image.height * scale);
  const ctx = cv.getContext("2d");
  ctx.drawImage(lastShot.canvas || image, 0, 0, cv.width, cv.height);
  const ov = result.overlay;
  if (!ov) return;
  const S = scale;
  const colX = (c) => (ov.colCenters[0] + (c - ov.shiftC) * ov.pitchC) * S;
  const rowY = (r) => (ov.rowCenters[0] + (r - ov.shiftR) * ov.pitchR) * S;
  const half = ov.pitch * S / 2;
  ctx.lineWidth = 2;
  ctx.font = "bold 14px sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  // 格子状态
  const colorOf = { 0: "#40ff90", 1: "#9aa4ae", 2: "#2fd4b0", 3: "#4aa8ff" };
  for (let r = 0; r < result.rows; r++) for (let c = 0; c < result.cols; c++) {
    const st = result.cells[r * result.cols + c];
    ctx.strokeStyle = colorOf[st];
    ctx.strokeRect(colX(c) - half, rowY(r) - half, half * 2, half * 2);
  }
  // 目标数字（列=上方，行=左侧）
  ctx.fillStyle = "#8ee06a";
  for (let c = 0; c < result.cols; c++) ctx.fillText(String(result.colT[c]), colX(c), rowY(0) - half - 14);
  for (let r = 0; r < result.rows; r++) ctx.fillText(String(result.rowT[r]), colX(0) - half - 16, rowY(r));
  if (result.type2) {
    ctx.fillStyle = "#6cc4ff";
    for (let c = 0; c < result.cols; c++) ctx.fillText(String(result.col2T[c]), colX(c), rowY(0) - half - 30);
    for (let r = 0; r < result.rows; r++) ctx.fillText(String(result.row2T[r]), colX(0) - half - 34, rowY(r));
  }
  // 计数段框（黄色）
  ctx.strokeStyle = "#ffd23a";
  for (const c of ov.tallyBoxes || []) ctx.strokeRect(c[0] * S, c[1] * S, (c[2] - c[0]) * S, (c[3] - c[1]) * S);
}

async function analyzeScreenshotFile(file) {
  setStatus("正在识别截图…");
  try {
    const imageData = await fileToImageData(file);
    const force2 = !!$("#c-force2")?.checked;
    const result = analyzeCircuitScreenshot(imageData, PRESETS, { catalog: CATALOG, forceType2: force2 });
    // 供标注浮层：保留位图 canvas
    const cv = document.createElement("canvas");
    cv.width = imageData.width; cv.height = imageData.height;
    cv.getContext("2d").putImageData(imageData, 0, 0);
    lastShot = { image: imageData, canvas: cv, result };
    $("#c-overlay").hidden = false;
    if (!result.ok) {
      setStatus("识别失败：" + result.reason, "warn");
      return;
    }
    // 填充棋盘
    state.rows = result.rows; state.cols = result.cols;
    $("#c-rows").value = state.rows; $("#c-cols").value = state.cols;
    state.type2 = result.type2;
    $("#c-type2").checked = state.type2;
    state.cells = result.cells.slice();
    state.rowT = result.rowT.slice(); state.colT = result.colT.slice();
    state.row2T = result.row2T.slice(); state.col2T = result.col2T.slice();
    state.placed = []; state.selected = null;
    let msg;
    if (result.components && result.components.length) {
      // 托盘元件识别成功：直接采用识别结果（不依赖题库）
      state.supply = {};
      for (const comp of result.components) state.supply[comp.id] = { g: comp.count, b: comp.count2 || 0 };
      const total = result.components.reduce((s, c) => s + c.count + c.count2, 0);
      if (result.match) {
        const p = PRESETS[result.match.key];
        state.presetKey = result.match.key;
        history.replaceState(null, "", "#" + encodeURIComponent(p.name || result.match.key));
        buildPresetSelect($("#c-preset-search").value);
        $("#c-preset").value = result.match.key;
        const same = (p.component || []).length === result.components.length;
        msg = `识别成功：棋盘 ${result.rows}×${result.cols}${result.type2 ? "（蓝色组件）" : ""}，元件 ${total} 块（托盘识别）。` +
          (same ? `\n与官方关卡「${p.name || result.match.key}」一致。` : `\n⚠ 与官方关卡「${p.name || result.match.key}」的元件略有出入，已按识别结果处理。`);
      } else {
        state.presetKey = "";
        msg = `识别成功：棋盘 ${result.rows}×${result.cols}${result.type2 ? "（蓝色组件）" : ""}，元件 ${total} 块（托盘识别，未匹配到官方关卡）。`;
      }
    } else if (result.match) {
      // 托盘未识别（截图未包含元件栏）：回退到官方预设的元件
      const p = PRESETS[result.match.key];
      state.supply = {};
      for (const comp of p.component || []) state.supply[comp.id] = { g: Number(comp.count) || 0, b: Number(comp.count2) || 0 };
      state.presetKey = result.match.key;
      history.replaceState(null, "", "#" + encodeURIComponent(p.name || result.match.key));
      buildPresetSelect($("#c-preset-search").value);
      $("#c-preset").value = result.match.key;
      msg = `识别成功，匹配官方关卡「${p.name || result.match.key}」。\n棋盘 ${result.rows}×${result.cols}${result.type2 ? "（蓝色组件）" : ""}，元件已按关卡载入。`;
    } else {
      state.presetKey = "";
      msg = `识别成功：棋盘 ${result.rows}×${result.cols}${result.type2 ? "（蓝色组件）" : ""}。\n未识别到元件也未匹配到官方预设——请在右侧元件库手动设置元件数量后求解。`;
    }
    for (const w of result.warnings || []) msg += "\n⚠ " + w;
    renderBoard(); renderPalette();
    setStatus(msg, "ok");
    if ($("#c-auto-solve").checked) setTimeout(onSolve, 80);
  } catch (err) {
    setStatus("识别出错：" + (err?.message || err), "warn");
  }
}

$("#c-upload").addEventListener("click", () => $("#c-file-input").click());
$("#c-file-input").addEventListener("change", (e) => { if (e.target.files[0]) analyzeScreenshotFile(e.target.files[0]); e.target.value = ""; });
// 读剪贴板（与气球模式一致：需要 https/localhost 与剪贴板读取权限）
$("#c-clipboard").addEventListener("click", async () => {
  if (!navigator.clipboard || !navigator.clipboard.read) {
    setStatus("当前浏览器不支持读取剪贴板（Firefox 未开放该 API）。请改用 Ctrl+V 粘贴，或上传截图文件。", "warn");
    return;
  }
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = item.types.find(t => t.startsWith("image/"));
      if (type) {
        const blob = await item.getType(type);
        await analyzeScreenshotFile(new File([blob], "clipboard." + type.split("/")[1], { type }));
        return;
      }
    }
    setStatus("剪贴板里没有图片。先复制一张游戏截图，再点此按钮。", "warn");
  } catch (err) {
    if (err?.name === "NotAllowedError") {
      setStatus("读取剪贴板被拒绝：请在弹出的权限框里允许，或改用 Ctrl+V 粘贴 / 上传文件。", "warn");
    } else {
      setStatus("读取剪贴板失败：" + (err?.message || err), "warn");
    }
  }
});
// 测试钩子：e2e 用
window.__analyzeScreenshotFile = analyzeScreenshotFile;
window.__cstate = state; // 测试钩子
window.__analyzeCircuit = analyzeCircuitScreenshot; // 测试钩子
$("#c-overlay").addEventListener("click", () => { drawCircuitOverlay(); $("#c-overlay-modal").hidden = false; });
$("#c-btn-close-overlay").addEventListener("click", () => { $("#c-overlay-modal").hidden = true; });
$("#c-overlay-modal").addEventListener("click", (e) => { if (e.target.id === "c-overlay-modal") $("#c-overlay-modal").hidden = true; });
// 粘贴 / 拖入截图（仅电路模式）
window.addEventListener("paste", (e) => {
  if (document.body.dataset.mode !== "circuit") return;
  const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith("image/"));
  if (item) analyzeScreenshotFile(item.getAsFile());
});
window.addEventListener("dragenter", (e) => {
  if (document.body.dataset.mode !== "circuit") return;
  e.preventDefault();
});
window.addEventListener("dragover", (e) => { if (document.body.dataset.mode === "circuit") e.preventDefault(); });
window.addEventListener("drop", (e) => {
  if (document.body.dataset.mode !== "circuit") return;
  e.preventDefault();
  const file = [...(e.dataTransfer?.files || [])].find(f => f.type.startsWith("image/"));
  if (file) analyzeScreenshotFile(file);
});

// ---------- 模式切换 ----------
function setMode(mode) {
  document.body.dataset.mode = mode;
  $("#page-balloon").hidden = mode !== "balloon";
  $("#page-circuit").hidden = mode !== "circuit";
  document.querySelectorAll(".mode-tab").forEach(b => b.classList.toggle("active", b.dataset.mode === mode));
  localStorage.setItem("zmd-mode", mode);
  if (mode === "circuit") renderBoard();
}
document.querySelectorAll(".mode-tab").forEach(btn =>
  btn.addEventListener("click", () => setMode(btn.dataset.mode)));

// ---------- 初始化 ----------
(async function init() {
  try {
    await loadData();
  } catch (err) {
    setStatus("数据加载失败（circuit-config / circuit-presets）：" + (err?.message || err), "warn");
    return;
  }
  initBoardArrays();
  buildPresetSelect();
  renderPalette();
  // 深链：#V40020 或 #V4_BOT_0020（直接落到电路模式并求解）
  const hash = decodeURIComponent(location.hash.slice(1) || "");
  const key = hash && (PRESETS[hash] ? hash : findPresetByName(hash));
  if (key) {
    setMode("circuit");
    loadPreset(key);
  } else {
    renderBoard();
    setStatus("载入左侧官方预设一键求解，或手动摆棋盘：\n右键格子循环切换：空 → 禁用 ⊘ → 绿色锁定 → 蓝色锁定。");
  }
  if (localStorage.getItem("zmd-mode") === "circuit") setMode("circuit");
})();

// 同文档 hash 变化（如直接改地址栏换关卡）也响应
window.addEventListener("hashchange", () => {
  if (!PRESETS) return;
  const hash = decodeURIComponent(location.hash.slice(1) || "");
  const key = hash && (PRESETS[hash] ? hash : findPresetByName(hash));
  if (key) {
    setMode("circuit");
    loadPreset(key);
  }
});
