// Node 回归：加载电路元件目录与 109 道官方预设，逐一求解，断言全部有解
import { readFileSync } from "node:fs";
import { solveCircuit } from "../public/js/circuit-solver.js";

const catalog = JSON.parse(readFileSync(new URL("../public/data/circuit-config.json", import.meta.url), "utf8"));
const presets = JSON.parse(readFileSync(new URL("../public/data/circuit-presets.json", import.meta.url), "utf8"));

let pass = 0, fail = 0, slowest = 0, slowName = "";
const t0 = performance.now();
outer: for (const [key, p] of Object.entries(presets)) {
  const input = {
    rows: p.n,
    columns: p.m,
    type2Enabled: !!p.isType2Activated,
    targets: p.target,
    cells: (p.gridCell || []).map(c => ({ r: c.r, c: c.c, state: c.state })),
    components: p.component,
    catalog,
  };
  const t1 = performance.now();
  const res = solveCircuit(input);
  const ms = performance.now() - t1;
  if (ms > slowest) { slowest = ms; slowName = key; }
  if (res.status === "solved") {
    // 校验解：行/列目标精确满足（锁定常亮格计入目标，禁用格不可被覆盖）
    const grid = Array.from({ length: p.n }, () => Array(p.m).fill(0));
    const lockedG = new Set(), lockedB = new Set(), blocked = new Set();
    for (const cell of p.gridCell || []) {
      const key = cell.r + "," + cell.c;
      if (cell.state === 1) blocked.add(key);
      else if (cell.state === 2) { lockedG.add(key); grid[cell.r][cell.c] = 1; }
      else if (cell.state === 3) { lockedB.add(key); grid[cell.r][cell.c] = 2; }
    }
    let bad = false;
    for (const pl of res.placements) for (const [r, c] of pl.coordinates) {
      if (grid[r][c] !== 0 || blocked.has(r + "," + c)) { console.log(`${key} OVERLAP (${r},${c})`); bad = true; }
      grid[r][c] = pl.type;
    }
    let ok = !bad;
    for (let r = 0; r < p.n && ok; r++) {
      const g = grid[r].filter(v => v === 1).length, b = grid[r].filter(v => v === 2).length;
      if (g !== p.target.row[r] || (p.isType2Activated && b !== p.target.row2[r])) { ok = false; console.log(`${key} row${r} 不符: ${g}/${b} vs ${p.target.row[r]}/${p.target.row2[r]}`); }
    }
    for (let c = 0; c < p.m && ok; c++) {
      const g = grid.map(row => row[c]).filter(v => v === 1).length, b = grid.map(row => row[c]).filter(v => v === 2).length;
      if (g !== p.target.col[c] || (p.isType2Activated && b !== p.target.col2[c])) { ok = false; console.log(`${key} col${c} 不符: ${g}/${b} vs ${p.target.col[c]}/${p.target.col2[c]}`); }
    }
    if (ok) pass++;
    else { fail++; console.log(`✗ ${key} 解不满足目标`); }
  } else {
    fail++;
    console.log(`✗ ${key} status=${res.status} ${res.message}`);
  }
}
console.log(`\n通过 ${pass}/${pass + fail}，总耗时 ${(performance.now() - t0).toFixed(0)}ms，最慢 ${slowName} ${slowest.toFixed(0)}ms`);
process.exit(fail ? 1 : 0);
