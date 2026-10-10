// 浮空气球谜题求解器。
// 规则：5x5 棋盘，坐标 x,y ∈ [-2,2]（中心为原点）。在格 (x,y) 放置升力 v 的气球
// 产生分量 (v·x, v·y)；所有气球放置完毕后总向量必须为 (0,0)（保持平衡）。
// 算法：DFS + 双轴可达区间剪枝（排序不等式）+ 死状态记忆化。

export const VALUES = [1, 2, 3, 4, 5, 6];
const key = ({ x, y }) => `${x},${y}`;

export function expandValues(counts) {
  const out = [];
  for (const v of VALUES) for (let i = 0; i < (counts[v] || 0); i++) out.push(v);
  return out;
}

// 对剩余位置与剩余数字（含空位 0），某一轴上 Σ coord·value 的可达区间。
// 将 coord 升序、value 升/降序逐位相乘分别给出最小/最大值（排序不等式）。
function axisBounds(coords, valuesWithZeros) {
  const cs = coords.slice().sort((a, b) => a - b);
  const vs = valuesWithZeros.slice().sort((a, b) => a - b);
  let lo = 0, hi = 0;
  for (let i = 0; i < cs.length; i++) {
    lo += cs[i] * vs[i];
    hi += cs[i] * vs[vs.length - 1 - i];
  }
  return [Math.min(lo, hi), Math.max(lo, hi)];
}

export function solvePuzzle(puzzle, options = {}) {
  const mode = options.mode || "one";
  const maxSolutions = options.maxSolutions || (mode === "one" ? 1 : mode === "unique" ? 2 : 100);
  const timeoutMs = options.timeoutMs ?? 10000;
  const startedAt = performance.now();

  // 待填格：按离中心距离降序（先放约束强的角落）
  const positions = puzzle.fillablePositions.slice().sort(
    (a, b) => (Math.abs(b.x) + Math.abs(b.y)) - (Math.abs(a.x) + Math.abs(a.y)) ||
      Math.max(Math.abs(b.x), Math.abs(b.y)) - Math.max(Math.abs(a.x), Math.abs(a.y)));
  const fixed = puzzle.fixedPlacements || [];
  for (const f of fixed) {
    if (positions.some(p => p.x === f.position.x && p.y === f.position.y)) {
      return { error: `固定气球位置 (${f.position.x},${f.position.y}) 与待填格重叠` };
    }
  }
  const fixedVec = fixed.reduce((s, f) => ({ x: s.x + f.value * f.position.x, y: s.y + f.value * f.position.y }), { x: 0, y: 0 });
  const target = { x: -fixedVec.x, y: -fixedVec.y };

  const remaining = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  for (const v of VALUES) remaining[v] = puzzle.tileCounts[v] || 0;
  let empties = positions.length - expandValues(remaining).length;
  if (empties < 0) {
    return { error: `数字块共 ${positions.length - empties} 块，但只有 ${positions.length} 个可放置格` };
  }
  if (positions.length === 0 && fixed.length === 0) {
    return { error: "请先放置或识别至少一个格子" };
  }

  const solutions = [];
  const dead = new Set();
  const placed = [];
  let nodes = 0, timedOut = false;

  const stateKey = (depth, sx, sy) =>
    `${depth}|${sx}|${sy}|${empties}|${VALUES.map(v => remaining[v]).join(",")}`;

  const dfs = (depth, sx, sy) => {
    if (++nodes % 2048 === 0 && performance.now() - startedAt > timeoutMs) timedOut = true;
    if (timedOut) return;
    if (depth === positions.length) {
      if (sx === target.x && sy === target.y) {
        solutions.push({ placements: placed.map(p => ({ position: { ...p.position }, value: p.value })) });
      }
      return;
    }
    // 双轴剪枝：剩余位置与剩余数字（含空位0）在两轴上的可达区间
    const needX = target.x - sx, needY = target.y - sy;
    const restCoordsX = [], restCoordsY = [];
    for (let i = depth; i < positions.length; i++) { restCoordsX.push(positions[i].x); restCoordsY.push(positions[i].y); }
    const restVals = [];
    for (const v of VALUES) for (let i = 0; i < remaining[v]; i++) restVals.push(v);
    for (let i = 0; i < empties; i++) restVals.push(0);
    const [loX, hiX] = axisBounds(restCoordsX, restVals);
    const [loY, hiY] = axisBounds(restCoordsY, restVals);
    if (needX < loX || needX > hiX || needY < loY || needY > hiY) return;

    const sk = stateKey(depth, sx, sy);
    if (dead.has(sk)) return;

    const pos = positions[depth];
    for (const v of VALUES.slice().reverse()) {
      if (!remaining[v]) continue;
      remaining[v]--; placed.push({ position: pos, value: v });
      dfs(depth + 1, sx + v * pos.x, sy + v * pos.y);
      placed.pop(); remaining[v]++;
      if (timedOut || solutions.length >= maxSolutions) return;
    }
    if (empties > 0) {
      empties--;
      dfs(depth + 1, sx, sy);
      empties++;
      if (timedOut || solutions.length >= maxSolutions) return;
    }
    dead.add(sk);
  };

  dfs(0, 0, 0);
  const elapsedMs = performance.now() - startedAt;
  const exhausted = !timedOut && solutions.length < maxSolutions;
  let summary;
  if (solutions.length === 0) summary = timedOut ? "暂未找到答案（搜索超时，不能断定无解）" : "这个局面无解";
  else if (mode === "unique") {
    if (solutions.length >= 2) summary = timedOut ? `已找到 ${solutions.length} 个答案（非唯一）` : "这个局面有多个答案，不唯一";
    else summary = timedOut ? "超时前仅找到 1 个答案，无法判断唯一性" : "这个局面有唯一答案";
  } else summary = "找到合法答案";
  return { solutions, exhausted, timedOut, nodesVisited: nodes, elapsedMs, summary };
}

// 由当前棋盘（格子状态 + 已放气球）与库存构造 puzzle 输入
export function buildPuzzle(cells, inventory) {
  const fillablePositions = [];
  const fixedPlacements = [];
  for (const c of cells) {
    if (c.state === "balloon") fixedPlacements.push({ position: { x: c.x, y: c.y }, value: c.value });
    else if (c.state === "fillable") fillablePositions.push({ x: c.x, y: c.y });
  }
  return { fillablePositions, fixedPlacements, tileCounts: { ...inventory } };
}
