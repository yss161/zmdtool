import { solvePuzzle, buildPuzzle } from "../public/js/solver.js";

const cells = [];
for (let gy = 0; gy < 5; gy++) for (let gx = 0; gx < 5; gx++) {
  const ring = gx === 0 || gx === 4 || gy === 0 || gy === 4;
  cells.push({ x: gx - 2, y: gy - 2, state: ring ? "fillable" : "disabled", value: null });
}
const puzzle = buildPuzzle(cells, { 1: 3, 2: 3, 3: 3, 6: 3 });
const r1 = solvePuzzle(puzzle, { mode: "one" });
console.log("one:", r1.summary, r1.elapsedMs.toFixed(1) + "ms", "nodes", r1.nodesVisited);
const s = r1.solutions[0];
let vx = 0, vy = 0;
const grid = Array.from({ length: 5 }, () => [".", ".", ".", ".", "."]);
for (const p of s.placements) {
  grid[p.position.y + 2][p.position.x + 2] = String(p.value);
  vx += p.value * p.position.x; vy += p.value * p.position.y;
}
console.log("vector", vx, vy);
console.log(grid.map(r => r.join(" ")).join("\n"));

const r2 = solvePuzzle(puzzle, { mode: "unique" });
console.log("unique:", r2.summary, r2.elapsedMs.toFixed(1) + "ms", "nodes", r2.nodesVisited, "count", r2.solutions.length);
if (!s || vx !== 0 || vy !== 0) { console.log("FAIL"); process.exit(1); }
console.log("PASS");
