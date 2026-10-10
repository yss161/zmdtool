// 裁决 WL-A1006 的真实棋盘：对候选格子组合跑求解器，看哪种假设有解
import { solvePuzzle } from "../public/js/solver.js";

const inv = { 1: 3, 2: 3, 3: 1, 4: 0, 5: 0, 6: 0 };

function tryCells(name, cells) {
  const puzzle = {
    fillablePositions: cells.map(([x, y]) => ({ x, y })),
    fixedPlacements: [],
    tileCounts: { ...inv },
  };
  const r = solvePuzzle(puzzle, { mode: "one", timeoutMs: 8000 });
  console.log(`${name}: ${r.solutions.length ? "有解 ✓" : "无解 ✗"} (${r.summary}, ${r.elapsedMs.toFixed(0)}ms)`);
  if (r.solutions.length) {
    const grid = Array.from({ length: 5 }, () => ["·", "·", "·", "·", "·"]);
    for (const p of r.solutions[0].placements) grid[p.position.y + 2][p.position.x + 2] = String(p.value);
    console.log(grid.map(g => g.join(" ")).join("\n"));
  }
}

// 假设A：括号识别出的 7 格 (gx,gy) → 坐标
tryCells("A: 7格 (2,1)(3,1)(1,2)(3,2)(1,3)(2,3)(3,3)", [
  [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1],
]);
// A + 浅灰格也算可放置（8格放7球）
tryCells("A8: 上述7格 + (0,0)", [
  [0, -1], [1, -1], [-1, 0], [0, 0], [1, 0], [-1, 1], [0, 1], [1, 1],
]);
// 假设B/C/D 已知 y 不平衡，跳过；再试底座列=0-2 行=1-3 的组合（格 gy 与列错位 variants）
tryCells("变体: 列0-2, 行1-3: (0,1)(1,1)(−1,0)... i.e. (2,1)→gx0", [
  [-2 + 0, -1], [-2 + 1, -1], [-2 + 0, 0], [-2 + 2, 0], [-2 + 0, 1], [-2 + 1, 1], [-2 + 2, 1],
].map(([x, y]) => [x, y]));
