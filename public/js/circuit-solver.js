// 源石电路模块（设备修复）求解器。
// 规则：n×m 棋盘，格子四态：0 空 / 1 禁用 / 2 绿色锁定 / 3 蓝色锁定。
// 目标：每行/列的绿色占用数 = row/col，蓝色占用数 = row2/col2（启用蓝色组件时）。
// 元件：目录中的多联方块，可旋转，绿色 count 份 + 蓝色 count2 份，全部放置
//       （部分题目提供备用元件，允许弃置若干块），锁定格计入目标但不能被元件覆盖，
//       其余空格允许留空。
// 输入 input: { rows, columns, targets:{row,col,row2?,col2?}, cells:[{r,c,state}],
//   components:[{id,count,count2?}], catalog:{id:{name,shape,color}},
//   preplaced?:[{id,type,coordinates:[[r,c],...]}] }
// 输出: { status: "solved"|"unsatisfiable"|"invalid"|"timeout", message, placements,
//   placements: [{id,name,color,type,instance,coordinates:[[r,c],...]}], visited, elapsedMs }

const ROTATIONS = [
  ([r, c]) => [r, c],
  ([r, c]) => [c, -r],
  ([r, c]) => [-r, -c],
  ([r, c]) => [-c, r],
];

function normalize(cells) {
  const pts = cells.map(([r, c]) => [Number(r), Number(c)]);
  const minR = Math.min(...pts.map(p => p[0]));
  const minC = Math.min(...pts.map(p => p[1]));
  const out = pts.map(([r, c]) => [r - minR, c - minC]);
  out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return out;
}

function rotationsOf(shape) {
  const base = normalize(shape);
  const seen = new Set();
  const out = [];
  for (const rot of ROTATIONS) {
    const cand = normalize(base.map(rot));
    const key = cand.map(p => p.join(",")).join("|");
    if (!seen.has(key)) { seen.add(key); out.push(cand); }
  }
  return out;
}
export { rotationsOf };

export function solveCircuit(input) {
  const t0 = performance.now();
  const rows = Number(input.rows), columns = Number(input.columns);
  if (!Number.isInteger(rows) || rows < 1 || rows > 10 || !Number.isInteger(columns) || columns < 1 || columns > 10) {
    return { status: "invalid", message: "棋盘尺寸应为 1 至 10 的整数", placements: [] };
  }
  const T = input.targets || {};
  const nums = (arr, len, label) => {
    if (!Array.isArray(arr) || arr.length !== len) return { error: `${label}数量与棋盘尺寸不符` };
    const v = arr.map(Number);
    if (v.some(x => !Number.isInteger(x) || x < 0 || x > columns)) return { error: `${label}目标数字超出范围` };
    return { v };
  };
  const g1 = nums(T.row, rows, "绿色行目标");
  if (g1.error) return { status: "invalid", message: g1.error, placements: [] };
  const g2 = nums(T.col, columns, "绿色列目标");
  if (g2.error) return { status: "invalid", message: g2.error, placements: [] };
  const blue = !!input.type2Enabled;
  const b1 = blue ? nums(T.row2, rows, "蓝色行目标") : { v: Array(rows).fill(0) };
  if (b1.error) return { status: "invalid", message: b1.error, placements: [] };
  const b2 = blue ? nums(T.col2, columns, "蓝色列目标") : { v: Array(columns).fill(0) };
  if (b2.error) return { status: "invalid", message: b2.error, placements: [] };
  const rowT = g1.v, colT = g2.v, row2T = b1.v, col2T = b2.v;
  if (rowT.reduce((a, b) => a + b, 0) !== colT.reduce((a, b) => a + b, 0)) {
    return { status: "invalid", message: "绿色组件行目标之和与列目标之和不一致", placements: [] };
  }
  if (blue && row2T.reduce((a, b) => a + b, 0) !== col2T.reduce((a, b) => a + b, 0)) {
    return { status: "invalid", message: "蓝色组件行目标之和与列目标之和不一致", placements: [] };
  }

  // 格子状态
  const state = Array(rows * columns).fill(0);
  for (const cell of input.cells || []) {
    const r = Number(cell.r), c = Number(cell.c), st = Number(cell.state);
    if (r >= 0 && r < rows && c >= 0 && c < columns && [0, 1, 2, 3].includes(st)) state[r * columns + c] = st;
  }
  const lockedG = Array(rows).fill(0), lockedB = Array(rows).fill(0);
  const lockedGC = Array(columns).fill(0), lockedBC = Array(columns).fill(0);
  let emptyTotal = 0;
  const emptyInRow = Array(rows).fill(0), emptyInCol = Array(columns).fill(0);
  for (let r = 0; r < rows; r++) for (let c = 0; c < columns; c++) {
    const st = state[r * columns + c];
    if (st === 0) { emptyTotal++; emptyInRow[r]++; emptyInCol[c]++; }
    else if (st === 2) lockedG[r]++;
    else if (st === 3) lockedB[r]++;
    if (st === 2) lockedGC[c]++;
    if (st === 3) lockedBC[c]++;
  }
  const lockedGTotal = lockedG.reduce((a, b) => a + b, 0);
  const lockedBTotal = lockedB.reduce((a, b) => a + b, 0);
  for (let r = 0; r < rows; r++) {
    if (lockedG[r] > rowT[r] || lockedB[r] > row2T[r]) {
      return { status: "invalid", message: "某行的锁定常亮格数量超过该行目标", placements: [] };
    }
  }
  for (let c = 0; c < columns; c++) {
    if (lockedGC[c] > colT[c] || lockedBC[c] > col2T[c]) {
      return { status: "invalid", message: "某列的锁定常亮格数量超过该列目标", placements: [] };
    }
  }

  // 元件目录
  const catalog = input.catalog || {};

  // 预放置元件（手动摆上的固定项）：占用空格、计入已放置数，并从元件计数中扣除
  const preOcc = new Uint8Array(rows * columns);
  const preByKey = new Map(); // "id:type" -> 已放实例数
  const preGRow = Array(rows).fill(0), preGCol = Array(columns).fill(0);
  const preBRow = Array(rows).fill(0), preBCol = Array(columns).fill(0);
  let preGCells = 0, preBCells = 0;
  for (const pp of input.preplaced || []) {
    const coords = (Array.isArray(pp.coordinates) ? pp.coordinates : []).map(p => [Number(p[0]), Number(p[1])]);
    const ty = Number(pp.type) === 2 ? 2 : 1;
    if (!coords.length) continue;
    if (!catalog[pp.id]) return { status: "invalid", message: `预放置元件 ${pp.id} 不在元件目录中`, placements: [] };
    let ok = true;
    for (const [r, c] of coords) {
      if (!(r >= 0 && r < rows && c >= 0 && c < columns)) { ok = false; break; }
      const idx = r * columns + c;
      if (state[idx] !== 0 || preOcc[idx]) { ok = false; break; }
    }
    if (!ok) return { status: "invalid", message: "预放置元件与棋盘冲突（越界、覆盖锁定/禁用格或互相重叠）", placements: [] };
    for (const [r, c] of coords) {
      const idx = r * columns + c;
      preOcc[idx] = 1;
      if (ty === 1) { preGRow[r]++; preGCol[c]++; preGCells++; }
      else { preBRow[r]++; preBCol[c]++; preBCells++; }
    }
    const key = pp.id + ":" + ty;
    preByKey.set(key, (preByKey.get(key) || 0) + 1);
  }

  // 元件定义
  const defs = (input.components || []).filter(def => {
    if (!catalog[def.id]) return false;
    const pre = (preByKey.get(def.id + ":1") || 0) + (preByKey.get(def.id + ":2") || 0);
    return (Number(def.count) || 0) + (blue ? (Number(def.count2) || 0) : 0) + pre > 0;
  });
  const shapes = new Map(); // id -> rotations (归一化坐标数组)
  for (const id of new Set(defs.map(d => d.id))) {
    shapes.set(id, rotationsOf(catalog[id].shape));
  }
  const areaOf = (id) => shapes.get(id)[0].length;
  // 剩余待放数量 = 配置数量 - 预放置数量
  const remainingOf = (def) => [
    Math.max(0, (Number(def.count) || 0) - (preByKey.get(def.id + ":1") || 0)),
    blue ? Math.max(0, (Number(def.count2) || 0) - (preByKey.get(def.id + ":2") || 0)) : 0,
  ];

  // 目标面积 = 目标总数 - 锁定数 - 预放置数
  const targetArea = rowT.reduce((a, b) => a + b, 0) + row2T.reduce((a, b) => a + b, 0)
    - lockedGTotal - lockedBTotal - preGCells - preBCells;

  // dropSig 形如 { "defIndex:type": 弃置数 }
  const buildInstances = (dropSig) => {
    const out = [];
    for (let di = 0; di < defs.length; di++) {
      const def = defs[di];
      const rem = remainingOf(def);
      const count1 = Math.max(0, rem[0] - (dropSig[di + ":0"] || 0));
      const count2 = Math.max(0, rem[1] - (dropSig[di + ":1"] || 0));
      for (let i = 0; i < count1; i++) out.push({ defIndex: di, id: def.id, type: 1, area: areaOf(def.id), rots: shapes.get(def.id) });
      for (let i = 0; i < count2; i++) out.push({ defIndex: di, id: def.id, type: 2, area: areaOf(def.id), rots: shapes.get(def.id) });
    }
    return out;
  };
  const areaOfInstances = (list) => list.reduce((s, i) => s + i.area, 0);

  // 备用元件弃置方案枚举：在剩余实例里选出一个子集，面积和恰为 excess。
  // 同一 (def,type) 的实例彼此相同，按签名去重；生成器惰性产出，逐个配合搜索尝试。
  function* dropPlans(excess) {
    if (excess <= 0) return;
    const units = [];
    for (let di = 0; di < defs.length; di++) {
      const rem = remainingOf(defs[di]);
      for (let i = 0; i < rem[0]; i++) units.push([di, 0]);
      for (let i = 0; i < rem[1]; i++) units.push([di, 1]);
    }
    units.sort((a, b) => areaOf(defs[b[0]].id) - areaOf(defs[a[0]].id));
    const seen = new Set();
    const pick = [];
    function* rec(start, rest) {
      if (rest === 0) {
        const sig = {};
        for (const u of pick) sig[u[0] + ":" + u[1]] = (sig[u[0] + ":" + u[1]] || 0) + 1;
        const key = JSON.stringify(sig);
        if (!seen.has(key)) { seen.add(key); yield sig; }
        return;
      }
      for (let i = start; i < units.length; i++) {
        const a = areaOf(defs[units[i][0]].id);
        if (a > rest) continue;
        pick.push(units[i]);
        yield* rec(i + 1, rest - a);
        pick.pop();
      }
    }
    yield* rec(0, excess);
  }

  // 每个实例的放置候选：旋转 × 位置（按 id:type 缓存）
  const candidatesFor = new Map();
  function candidates(instance) {
    const key = instance.id + ":" + instance.type;
    if (candidatesFor.has(key)) return candidatesFor.get(key);
    const list = [];
    for (let ri = 0; ri < instance.rots.length; ri++) {
      const shape = instance.rots[ri];
      const maxR = Math.max(...shape.map(p => p[0])), maxC = Math.max(...shape.map(p => p[1]));
      for (let r = 0; r + maxR < rows; r++) for (let c = 0; c + maxC < columns; c++) {
        const cellIdx = [], rowCount = new Map(), colCount = new Map();
        let ok = true;
        for (const [dr, dc] of shape) {
          const rr = r + dr, cc = c + dc, idx = rr * columns + cc;
          if (state[idx] !== 0 || preOcc[idx]) { ok = false; break; }
          cellIdx.push(idx);
          rowCount.set(rr, (rowCount.get(rr) || 0) + 1);
          colCount.set(cc, (colCount.get(cc) || 0) + 1);
        }
        if (!ok) continue;
        list.push({ ri, r, c, cellIdx, rows: [...rowCount.entries()], cols: [...colCount.entries()], size: shape.length });
      }
    }
    candidatesFor.set(key, list);
    return list;
  }

  // 搜索状态（跨弃置方案复用；dfs 完整回溯后状态还原）
  let instances = [];
  let order = [];
  let assignment = [];
  const placedG = preGRow.slice(), placedB = preBRow.slice();
  const placedGC = preGCol.slice(), placedBC = preBCol.slice();
  const emptyRowLeft = emptyInRow.slice(), emptyColLeft = emptyInCol.slice();
  for (let i = 0; i < preOcc.length; i++) {
    if (!preOcc[i]) continue;
    const r = (i / columns) | 0, c = i % columns;
    emptyRowLeft[r]--; emptyColLeft[c]--;
  }
  let placedGTotal = preGCells, placedBTotal = preBCells;
  const occupied = new Uint8Array(rows * columns);
  const timeoutMs = 10000;
  const started = performance.now();
  let visited = 0;
  let cancelled = false;

  // 同组对称剪枝：同组件同类实例只按候选序递增尝试
  const lastCand = new Map(); // groupKey -> index in candidate list

  function success() {
    if (placedGTotal + lockedGTotal !== rowT.reduce((a, b) => a + b, 0)) return false;
    if (placedBTotal + lockedBTotal !== row2T.reduce((a, b) => a + b, 0)) return false;
    for (let r = 0; r < rows; r++) if (placedG[r] + lockedG[r] !== rowT[r] || placedB[r] + lockedB[r] !== row2T[r]) return false;
    for (let c = 0; c < columns; c++) if (placedGC[c] + lockedGC[c] !== colT[c] || placedBC[c] + lockedBC[c] !== col2T[c]) return false;
    return true;
  }

  function canPlace(inst, cand) {
    for (const idx of cand.cellIdx) if (occupied[idx]) return false;
    const pRow = inst.type === 1 ? placedG : placedB;
    const pCol = inst.type === 1 ? placedGC : placedBC;
    const lRow = inst.type === 1 ? lockedG : lockedB;
    const lCol = inst.type === 1 ? lockedGC : lockedBC;
    const tRow = inst.type === 1 ? rowT : row2T;
    const tCol = inst.type === 1 ? colT : col2T;
    for (const [rr, cnt] of cand.rows) if (pRow[rr] + lRow[rr] + cnt > tRow[rr]) return false;
    for (const [cc, cnt] of cand.cols) if (pCol[cc] + lCol[cc] + cnt > tCol[cc]) return false;
    return true;
  }

  function apply(inst, cand, sign) {
    const pRow = inst.type === 1 ? placedG : placedB;
    const pCol = inst.type === 1 ? placedGC : placedBC;
    for (const idx of cand.cellIdx) occupied[idx] = sign > 0 ? 1 : 0;
    for (const [rr, cnt] of cand.rows) pRow[rr] += sign * cnt;
    for (const [cc, cnt] of cand.cols) pCol[cc] += sign * cnt;
    for (const idx of cand.cellIdx) {
      const r = (idx / columns) | 0, c = idx % columns;
      emptyRowLeft[r] -= sign; emptyColLeft[c] -= sign;
    }
    if (inst.type === 1) placedGTotal += sign * inst.area; else placedBTotal += sign * inst.area;
  }

  function feasible(depth) {
    if (placedGTotal > rowT.reduce((a, b) => a + b, 0)) return false;
    if (placedBTotal > row2T.reduce((a, b) => a + b, 0)) return false;
    // 剩余待放置数 = 目标 - 锁定 - 已放置（含预放置），不得超过剩余空格
    const needG = rowT.reduce((a, b) => a + b, 0) - lockedGTotal - placedGTotal;
    const needB = row2T.reduce((a, b) => a + b, 0) - lockedBTotal - placedBTotal;
    if (needG + needB > emptyTotal - preGCells - preBCells) return false;
    for (let r = 0; r < rows; r++) {
      if ((rowT[r] - lockedG[r] - placedG[r]) + (row2T[r] - lockedB[r] - placedB[r]) > emptyRowLeft[r]) return false;
    }
    for (let c = 0; c < columns; c++) {
      if ((colT[c] - lockedGC[c] - placedGC[c]) + (col2T[c] - lockedBC[c] - placedBC[c]) > emptyColLeft[c]) return false;
    }
    return true;
  }

  function dfs(depth) {
    if (visited++ % 4096 === 0 && performance.now() - started > timeoutMs) cancelled = true;
    if (cancelled) return false;
    if (depth === order.length) return success();
    if (!feasible(depth)) return false;

    const inst = instances[order[depth]];
    const groupKey = inst.id + ":" + inst.type;
    const cands = candidates(inst);
    const start = lastCand.get(groupKey) ?? -1;
    for (let ci = start + 1; ci < cands.length; ci++) {
      const cand = cands[ci];
      if (!canPlace(inst, cand)) continue;
      const prev = lastCand.get(groupKey);
      lastCand.set(groupKey, ci);
      apply(inst, cand, +1);
      assignment[depth] = { inst, cand };
      if (dfs(depth + 1)) return true;
      assignment[depth] = null;
      apply(inst, cand, -1);
      lastCand.set(groupKey, prev);
      if (cancelled) return false;
    }
    return false;
  }

  function runSearch() {
    // 实例排序：候选少的先放（最约束优先），面积大的先放
    order = instances
      .map((inst, i) => ({ inst, i, candCount: candidates(inst).length }))
      .sort((a, b) => a.candCount - b.candCount || b.inst.area - a.inst.area || a.i - b.i)
      .map(e => e.i);
    assignment = new Array(order.length).fill(null);
    return dfs(0);
  }

  // 主流程：先按"全部放置"尝试；面积不符时逐个尝试弃置组合
  const remainingUnitsArea = (() => {
    let s = 0;
    for (let di = 0; di < defs.length; di++) {
      const rem = remainingOf(defs[di]);
      s += (rem[0] + rem[1]) * areaOf(defs[di].id);
    }
    return s;
  })();
  const excess = remainingUnitsArea - targetArea;
  let solved = false;
  if (excess === 0) {
    instances = buildInstances({});
    solved = runSearch();
  } else if (excess > 0) {
    for (const sig of dropPlans(excess)) {
      instances = buildInstances(sig);
      if (areaOfInstances(instances) !== targetArea) continue;
      solved = runSearch();
      if (solved || cancelled) break;
    }
  }

  const elapsed = performance.now() - started;
  if (!solved) {
    const reason = cancelled ? "搜索超时，未能找到解。"
      : excess < 0 ? "元件总格数少于目标格数，无解。"
      : excess > 0 ? "无解：即使考虑弃置备用元件，元件也无法满足行列目标。请检查目标数字与元件数量。"
      : "此输入无匹配解：请检查目标数字、禁用格与元件数量。";
    return {
      status: cancelled ? "timeout" : "unsatisfiable",
      message: reason,
      placements: [],
      visited,
      elapsedMs: elapsed,
    };
  }
  const placements = [];
  let seq = 0;
  for (const { inst, cand } of assignment) {
    const info = catalog[inst.id];
    placements.push({
      id: inst.id,
      name: info.name,
      color: info.color,
      type: inst.type,
      instance: ++seq,
      coordinates: cand.cellIdx.map(idx => [(idx / columns) | 0, idx % columns]),
    });
  }
  return { status: "solved", message: "成功找到可行解。", placements, visited, elapsedMs: elapsed };
}
