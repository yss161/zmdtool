// 主应用：状态管理、棋盘/库存渲染、拖拽交互、截图识别（调 vision.js）、求解（Web Worker）
import { analyzeScreenshot } from "./vision.js";
import { buildPuzzle } from "./solver.js";
import { createCanvasDigitOcr } from "./ocr.js";

const $ = (sel) => document.querySelector(sel);
const boardEl = $("#board");
const invEl = $("#inventory");
const statusEl = $("#status");
const vectorEl = $("#vector");

const GAME_VALUES = [6, 3, 2, 1];      // 4级→1级
const LEVEL_NAME = { 6: "4级", 3: "3级", 2: "2级", 1: "1级", 5: "5级", 4: "4级" };

// 挂载点图标：与 efsim 的 MountPointGlyph 同款（三层 H 形底座 + 白描线 + 十字线 + 黄色双环）
const SOCKET_SVG = '<svg viewBox="0 0 100 88" aria-hidden="true">'
  + '<path class="mount-depth" d="M12 8H37V17H63V8H88V80H63V71H37V80H12Z"/>'
  + '<path class="mount-outer" d="M9 5H38V14H62V5H91V83H62V74H38V83H9Z"/>'
  + '<path class="mount-plate" d="M14 9H38V19H62V9H86V79H62V69H38V79H14Z"/>'
  + '<path class="mount-grid" d="M14 44H86M50 19V69"/>'
  + '<path class="mount-edge" d="M14 15H20M14 73H20M80 15H86M80 73H86"/>'
  + '<g class="mount-target"><circle cx="50" cy="44" r="10"/><circle cx="50" cy="44" r="6"/></g>'
  + '</svg>';

// ---------- 状态 ----------
const state = {
  cells: [],            // {gx,gy,x,y,state:'disabled'|'fillable'|'balloon',value,fixed?}
  cols: 5, rows: 5,     // 棋盘规模（截图导入可改变，如 6x6）
  inventory: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 }, // 剩余数量
  countsUncertain: new Set(),
  selectedValue: null,  // 点选库存后待放置的值
  lastImage: null,
  lastResult: null,
};

function defaultBoard() {
  state.cells = [];
  state.cols = 5; state.rows = 5;
  for (let gy = 0; gy < 5; gy++) for (let gx = 0; gx < 5; gx++) {
    state.cells.push({ x: gx - 2, y: gy - 2, state: "disabled", value: null, gx, gy });
  }
  state.inventory = { 1: 3, 2: 3, 3: 3, 4: 0, 5: 0, 6: 3 }; // 默认库存：3/3/3/3
}
defaultBoard();

// ---------- 渲染 ----------
function cellPx() {
  const availW = window.innerWidth - 780;
  const availH = window.innerHeight - 240;
  return Math.max(40, Math.min(84, Math.floor(Math.min(availW / state.cols, availH / state.rows))));
}

function renderBoard() {
  boardEl.style.setProperty("--cell-size", cellPx() + "px");
  boardEl.style.gridTemplateColumns = `repeat(${state.cols}, var(--cell-size))`;
  boardEl.innerHTML = "";
  state.cells.forEach((cell, idx) => {
    const el = document.createElement("div");
    el.className = `cell ${cell.state === "balloon" ? "fillable" : cell.state}`;
    el.dataset.idx = idx;
    if (cell.state === "balloon") {
      el.appendChild(balloonEl(cell.value));
    } else if (cell.state === "fillable") {
      const socket = document.createElement("div");
      socket.className = "socket";
      socket.innerHTML = SOCKET_SVG;
      el.appendChild(socket);
    }
    el.addEventListener("pointerdown", (ev) => onCellPointer(ev, idx));
    el.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      if (cell.state === "balloon") return;
      cell.state = cell.state === "fillable" ? "disabled" : "fillable";
      renderBoard(); updateCounter();
    });
    boardEl.appendChild(el);
  });
}

function balloonSVG(value) {
  return `<svg class="balloon-icon v${value}" viewBox="0 0 100 100" aria-hidden="true" pointer-events="none">
  <circle class="bi-edge" cx="50" cy="50" r="46"></circle>
  <circle class="bi-outer" cx="50" cy="50" r="43.5"></circle>
  <circle class="bi-middle" cx="50" cy="50" r="38.5"></circle>
  <circle class="bi-inner" cx="50" cy="50" r="29.5"></circle>
  <circle class="bi-seam" cx="50" cy="50" r="36"></circle>
  <circle class="bi-face" cx="50" cy="50" r="25.5"></circle>
  <path class="bi-micro" d="M25 50H28.5M25.8 53H28.5"></path>
  <g class="bi-hatch"><path d="M51 57L63 45"></path><path d="M53 62L68 47"></path><path d="M58 64L73 49"></path></g>
  <text class="bi-num" x="46" y="65.5" text-anchor="middle">${value}</text>
  <path class="bi-arrow" d="M64 30.8L72 40.2H68.4V50H61.1V40.2H56.8Z"></path>
</svg>`;
}

function balloonEl(value) {
  const b = document.createElement("div");
  b.className = "balloon";
  b.innerHTML = balloonSVG(value);
  return b;
}

function renderInventory() {
  invEl.innerHTML = "";
  for (const v of GAME_VALUES) {
    const count = state.inventory[v] || 0;
    const row = document.createElement("div");
    row.className = "inv-row" + (state.selectedValue === v ? " selected" : "") + (state.countsUncertain.has(v) ? " count-uncertain" : "");
    row.dataset.value = v;
    const disc = document.createElement("div");
    disc.className = `disc` + (count === 0 ? " empty" : "");
    disc.innerHTML = balloonSVG(v) + `<span class="count">${count}</span>`;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.innerHTML = `<div class="name">${LEVEL_NAME[v]}回收气球</div><div class="lift">[升力 … ${v}↑]</div>`;
    const stepper = document.createElement("div");
    stepper.className = "stepper";
    stepper.innerHTML =
      `<button type="button" data-d="-1" title="减少">−</button>` +
      `<input type="number" min="0" max="99" value="${count}" aria-label="${LEVEL_NAME[v]}气球剩余数量">` +
      `<button type="button" data-d="1" title="增加">+</button>`;
    stepper.addEventListener("click", (ev) => {
      const btn = ev.target.closest("button");
      if (!btn) return;
      setCount(v, (state.inventory[v] || 0) + Number(btn.dataset.d));
    });
    stepper.querySelector("input").addEventListener("change", (ev) => {
      const n = Math.round(Number(ev.target.value));
      setCount(v, Number.isFinite(n) ? n : (state.inventory[v] || 0));
    });
    row.append(disc, meta, stepper);
    row.title = "拖拽到格子放置；或点击选中后再点格子";
    disc.addEventListener("pointerdown", (ev) => {
      if ((state.inventory[v] || 0) <= 0) return;
      ev.preventDefault();
      startDrag(ev, v, null);
    });
    invEl.appendChild(row);
  }
}

function setCount(v, n) {
  n = Math.max(0, Math.min(99, n));
  state.countsUncertain.delete(v);
  state.inventory[v] = n;
  renderInventory(); updateCounter();
}

function placedLift() {
  return state.cells.reduce((s, c) => s + (c.state === "balloon" ? c.value : 0), 0);
}
function totalLift() {
  let s = 0;
  for (const v of GAME_VALUES) s += v * (state.inventory[v] || 0);
  return s + placedLift();
}
function currentVector() {
  let x = 0, y = 0;
  for (const c of state.cells) if (c.state === "balloon") { x += c.value * c.x; y += c.value * c.y; }
  return { x, y };
}

function updateCounter() {
  const placed = placedLift(), total = totalLift();
  $("#placed").textContent = placed;
  $("#total").textContent = total;
  $("#bar").style.width = total ? (placed / total * 100) + "%" : "0%";
  const vec = currentVector();
  vectorEl.textContent = `(${vec.x}, ${vec.y})`;
  vectorEl.className = "vec " + (vec.x === 0 && vec.y === 0 ? "zero" : "off");
}

function setStatus(msg, cls = "") {
  statusEl.textContent = msg;
  statusEl.className = "status " + cls;
}

// ---------- 拖拽（Pointer Events，兼容触屏） ----------
// 按下即进入拖拽；抬起时位移 <6px 视为点击：
//   点棋盘上的气球 → 收回；点库存盘 → 选中/取消选中
let drag = null;
function startDrag(ev, value, fromIdx) {
  drag = { value, fromIdx, startX: ev.clientX, startY: ev.clientY };
  const ghost = document.createElement("div");
  const size = (parseFloat(getComputedStyle(boardEl).getPropertyValue("--cell-size")) || 64) * 0.86;
  ghost.className = "drag-ghost";
  ghost.style.width = ghost.style.height = size + "px";
  ghost.innerHTML = balloonSVG(value);
  document.body.appendChild(ghost);
  drag.ghost = ghost;
  moveGhost(ev);
  window.addEventListener("pointermove", moveGhost);
  window.addEventListener("pointerup", endDrag, { once: true });
  window.addEventListener("pointercancel", cancelDrag, { once: true });
}
function moveGhost(ev) {
  if (!drag) return;
  drag.ghost.style.left = ev.clientX + "px";
  drag.ghost.style.top = ev.clientY + "px";
  const target = document.elementFromPoint(ev.clientX, ev.clientY);
  document.querySelectorAll(".cell.drop-target").forEach(c => c.classList.remove("drop-target"));
  const cellEl = target && target.closest(".cell");
  if (cellEl) cellEl.classList.add("drop-target");
}
function cleanupDrag() {
  if (drag) drag.ghost.remove();
  drag = null;
  document.querySelectorAll(".cell.drop-target").forEach(c => c.classList.remove("drop-target"));
  window.removeEventListener("pointermove", moveGhost);
}
function cancelDrag() { cleanupDrag(); }
function endDrag(ev) {
  const d = drag;
  cleanupDrag();
  if (!d) return;
  const moved = Math.hypot(ev.clientX - d.startX, ev.clientY - d.startY) >= 6;
  if (!moved) {
    if (d.fromIdx !== null) removeBalloon(d.fromIdx);   // 点击棋盘气球 → 收回
    else {                                              // 点击库存盘 → 选中
      state.selectedValue = state.selectedValue === d.value ? null : d.value;
      renderInventory();
    }
    return;
  }
  const target = document.elementFromPoint(ev.clientX, ev.clientY);
  const cellEl = target && target.closest(".cell");
  if (!cellEl) return;                                   // 拖到格子外：还原
  placeAt(d.value, Number(cellEl.dataset.idx), d.fromIdx);
}
function onCellPointer(ev, idx) {
  if (ev.button === 2) return;
  const cell = state.cells[idx];
  if (cell.state === "balloon") {
    ev.preventDefault();
    startDrag(ev, cell.value, idx);
  } else if (state.selectedValue) {
    placeAt(state.selectedValue, idx);
    state.selectedValue = null;
    renderInventory();
  }
}
function placeAt(value, idx, fromIdx = null) {
  const cell = state.cells[idx];
  if (cell.state === "disabled") { setStatus("这个格子不能放置气球（禁用格）。"); return; }
  if (fromIdx !== null) {
    // 移动：目标格若已有气球则交换
    const src = state.cells[fromIdx];
    const swap = state.cells[idx];
    if (swap.state === "balloon") {
      const t = swap.value;
      swap.value = value;
      src.state = "balloon"; src.value = t;
    } else {
      src.state = "fillable"; src.value = null;
      swap.state = "balloon"; swap.value = value;
    }
  } else {
    if (cell.state === "balloon") { setStatus("目标格已有气球，请先移开。"); return; }
    if ((state.inventory[value] || 0) <= 0) { setStatus(`${value} 级气球数量不足。`); return; }
    state.inventory[value]--;
    state.countsUncertain.delete(value);
    cell.state = "balloon"; cell.value = value;
  }
  state.selectedValue = null;
  renderBoard(); renderInventory(); updateCounter();
}
function removeBalloon(idx) {
  const cell = state.cells[idx];
  if (cell.state !== "balloon") return;
  state.inventory[cell.value] = (state.inventory[cell.value] || 0) + 1;
  cell.state = "fillable"; cell.value = null;
  renderBoard(); renderInventory(); updateCounter();
}

// ---------- 求解 ----------
const worker = new Worker("js/worker.js", { type: "module" });
let solveSeq = 0;
function requestSolve(mode) {
  const remaining = Object.fromEntries(GAME_VALUES.map(v => [v, state.inventory[v] || 0]));
  const totalLeft = GAME_VALUES.reduce((s, v) => s + v * remaining[v], 0);
  if (totalLeft === 0) { setStatus("没有待放置的气球：先收回一些，或用截图识别加载题目。", "warn"); return; }
  const puzzle = buildPuzzle(state.cells, remaining);
  const id = ++solveSeq;
  setStatus(mode === "unique" ? "正在判断唯一性…" : "正在搜索解…");
  worker.postMessage({ id, puzzle, mode, timeoutMs: 10000 });
  worker.onmessage = (e) => {
    if (e.data.id !== id) return;
    if (e.data.error) { setStatus("出错：" + e.data.error, "warn"); return; }
    const { solutions, summary } = e.data;
    if (!solutions.length) { setStatus(summary, "warn"); return; }
    if (mode === "unique") {
      setStatus(`判断结果：${summary}\n（已找到 ${solutions.length} 个不同布局）`, solutions.length >= 2 ? "" : "ok");
      return;
    }
    applySolution(solutions[0], () => {
      setStatus(`${summary}：已把答案摆上棋盘。\n总向量 (0, 0)，升力 ${placedLift()}/${totalLift()}。`, "ok");
    });
  };
}
function applySolution(solution, onDone) {
  // 求解时棋盘上已有的气球作为固定项保留；解中的气球逐个“放上去”并从库存扣除
  const cellByPos = new Map(state.cells.map(c => [`${c.x},${c.y}`, c]));
  solution.placements.forEach((p, i) => {
    setTimeout(() => {
      const cell = cellByPos.get(`${p.position.x},${p.position.y}`);
      if (!cell || cell.state === "balloon") return;
      cell.state = "balloon"; cell.value = p.value;
      state.inventory[p.value] = Math.max(0, (state.inventory[p.value] || 0) - 1);
      renderBoard(); renderInventory(); updateCounter();
    }, i * 70);
  });
  setTimeout(() => {
    renderBoard(); renderInventory(); updateCounter();
    if (onDone) onDone();
  }, solution.placements.length * 70 + 80);
}

// ---------- 截图识别 ----------
async function fileToImageData(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const scale = Math.min(1, 2600 / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  } finally { URL.revokeObjectURL(url); }
}

// 徽章数字 OCR 模板见 ocr.js（浏览器 canvas 渲染）

async function analyzeFile(file) {
  setStatus("正在识别截图…");
  try {
    const img = await fileToImageData(file);
    state.lastImage = img;
    const res = analyzeScreenshot(img, { ocrDigit: createCanvasDigitOcr() });
    state.lastResult = res;
    if (!res.ok) { setStatus("识别失败：" + res.reason, "warn"); return; }
    state.cells = res.board.cells.map(c => ({ x: c.x, y: c.y, state: c.state, value: c.value, fixed: c.state === "balloon", gx: c.gx, gy: c.gy }));
    state.cols = Math.max(...state.cells.map(c => c.gx)) + 1;
    state.rows = Math.max(...state.cells.map(c => c.gy)) + 1;
    state.inventory = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
    state.countsUncertain = new Set();
    for (const [v, n] of Object.entries(res.inventory)) state.inventory[v] = n;
    for (const b of res.badgeCrops || []) if (!b.ocrScore) state.countsUncertain.add(b.value);
    renderBoard(); renderInventory(); updateCounter();
    let msg = `识别成功：可放置格 ${state.cells.filter(c => c.state === "fillable").length} 个，已放气球 ${state.cells.filter(c => c.state === "balloon").length} 个\n` +
      `库存 ` + GAME_VALUES.filter(v => state.inventory[v] > 0).map(v => `${v}×${state.inventory[v]}`).join("  ");
    const odd = Object.entries(state.inventory).filter(([v, n]) => n > 0 && !GAME_VALUES.includes(Number(v)));
    if (odd.length) msg += `\n⚠ 检测到非常规升力值 ${odd.map(([v, n]) => v + "×" + n).join("、")}（面板未展示）`;
    if (res.warnings.length) msg += "\n⚠ " + res.warnings.join("\n⚠ ");
    setStatus(msg, res.warnings.length || odd.length ? "warn" : "ok");
    $("#btn-overlay").hidden = false;
    if ($("#auto-solve").checked) setTimeout(() => requestSolve("one"), 80);
  } catch (err) {
    setStatus("识别出错：" + (err?.message || err), "warn");
  }
}

function drawOverlay() {
  const img = state.lastImage, res = state.lastResult;
  if (!img || !res || !res.ok) return;
  const tmp = document.createElement("canvas");
  tmp.width = img.width; tmp.height = img.height;
  tmp.getContext("2d").putImageData(img, 0, 0);
  const cv = $("#overlay-canvas");
  const scale = Math.min(1, 1000 / img.width);
  cv.width = Math.round(img.width * scale);
  cv.height = Math.round(img.height * scale);
  const ctx = cv.getContext("2d");
  ctx.drawImage(tmp, 0, 0, cv.width, cv.height);
  const g = res.geometry, s = g.spacing * scale;
  const ox = g.originX * scale, oy = g.originY * scale;
  ctx.lineWidth = 2;
  ctx.font = "bold 13px sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (const c of res.board.cells) {
    const x = ox + c.gx * s, y = oy + c.gy * s;
    ctx.strokeStyle = c.state === "balloon" ? "#ff5040" : c.state === "fillable" ? "#40ff90" : "#8a929c88";
    ctx.strokeRect(x - s * 0.42, y - s * 0.42, s * 0.84, s * 0.84);
    if (c.state === "balloon") { ctx.fillStyle = "#ff5040"; ctx.fillText(String(c.value), x, y); }
  }
  ctx.strokeStyle = "#ffd23a";
  for (const b of res.badgeCrops || []) {
    ctx.strokeRect(b.box[0] * scale - 10, b.box[1] * scale - 10, (b.box[2] - b.box[0]) + 20, (b.box[3] - b.box[1]) + 20);
  }
}

// ---------- 事件绑定 ----------
$("#btn-upload").addEventListener("click", () => $("#file-input").click());
$("#file-input").addEventListener("change", (e) => { if (e.target.files[0]) analyzeFile(e.target.files[0]); e.target.value = ""; });
// 直接读取剪贴板里的截图（需要 https/localhost 与剪贴板读取权限）
$("#btn-clipboard").addEventListener("click", async () => {
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
        await analyzeFile(new File([blob], "clipboard." + type.split("/")[1], { type }));
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
$("#btn-solve").addEventListener("click", () => requestSolve("one"));
$("#btn-unique").addEventListener("click", () => requestSolve("unique"));
$("#btn-clear").addEventListener("click", () => {
  state.cells.forEach(c => {
    if (c.state === "balloon" && !c.fixed) {
      state.inventory[c.value] = (state.inventory[c.value] || 0) + 1;
      c.state = "fillable"; c.value = null;
    }
  });
  renderBoard(); renderInventory(); updateCounter();
  setStatus("已收回全部可移动气球（识别出的固定气球保留）。");
});
$("#btn-overlay").addEventListener("click", () => { drawOverlay(); $("#overlay-modal").hidden = false; });
$("#btn-close-overlay").addEventListener("click", () => { $("#overlay-modal").hidden = true; });
$("#overlay-modal").addEventListener("click", (e) => { if (e.target.id === "overlay-modal") $("#overlay-modal").hidden = true; });

// ---------- 设置弹层（主题配色） ----------
const settingsBtn = document.getElementById("settings-btn");
const settingsPop = document.getElementById("settings-pop");
settingsBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  settingsPop.hidden = !settingsPop.hidden;
  settingsBtn.classList.toggle("open", !settingsPop.hidden);
});
document.addEventListener("click", (e) => {
  if (!settingsPop.hidden && !settingsPop.contains(e.target) && !settingsBtn.contains(e.target)) {
    settingsPop.hidden = true;
    settingsBtn.classList.remove("open");
  }
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !settingsPop.hidden) {
    settingsPop.hidden = true;
    settingsBtn.classList.remove("open");
  }
});

// ---------- 主题配色 ----------
const THEMES = [
  { id: "amber", name: "经典橙", a: "#f0a12e" },
  { id: "cyan", name: "苍青", a: "#2ec5d9" },
  { id: "emerald", name: "翠绿", a: "#34d399" },
  { id: "violet", name: "紫电", a: "#a78bfa" },
  { id: "crimson", name: "绯红", a: "#f0564f" },
  { id: "silver", name: "钨银", a: "#c3cede" },
  { id: "efsim", name: "计算器", a: "#35b8a4" },
];
(function initThemes() {
  const row = $("#theme-row");
  const saved = localStorage.getItem("balloon-theme");
  const current = THEMES.some(t => t.id === saved) ? saved : "amber";
  document.body.dataset.theme = current;
  for (const t of THEMES) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "theme-dot" + (t.id === current ? " active" : "");
    b.title = t.name;
    b.setAttribute("aria-label", "主题：" + t.name);
    b.style.setProperty("--sw", t.a);
    b.addEventListener("click", () => {
      document.body.dataset.theme = t.id;
      localStorage.setItem("balloon-theme", t.id);
      row.querySelectorAll(".theme-dot").forEach(d => d.classList.toggle("active", d === b));
    });
    row.appendChild(b);
  }
})();

let resizeTimer = null;
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderBoard, 120); });

// 粘贴截图（电路模式下不处理，避免干扰）
window.addEventListener("paste", (e) => {
  if (document.body.dataset.mode === "circuit") return;
  const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith("image/"));
  if (item) analyzeFile(item.getAsFile());
});
// 拖放截图
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  if (document.body.dataset.mode === "circuit") return;
  e.preventDefault(); if (++dragDepth === 1) $("#drop-hint").hidden = false;
});
window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("#drop-hint").hidden = true; } });
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault(); dragDepth = 0; $("#drop-hint").hidden = true;
  if (document.body.dataset.mode === "circuit") return;
  const file = [...(e.dataTransfer?.files || [])].find(f => f.type.startsWith("image/"));
  if (file) analyzeFile(file);
});

// ---------- 初始化 ----------
renderBoard();
renderInventory();
updateCounter();
setStatus("默认棋盘全部为禁用格：右键格子切换 可放置/禁用，或上传/粘贴截图自动识别。\n调好格子后拖入气球即可求解。");
// 测试钩子：e2e 用
window.__state = state;
window.__analyzeFile = analyzeFile;
window.__analyzeScreenshot = analyzeScreenshot;
