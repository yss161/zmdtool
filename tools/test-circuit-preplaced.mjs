// preplaced（预放置/中途求解）逻辑测试
// API 语义：components 传完整配置数量；preplaced 中的实例由求解器内部自动从数量中扣除
import fs from "node:fs";
import { solveCircuit } from "../public/js/circuit-solver.js";

const catalog = JSON.parse(fs.readFileSync(new URL("../public/data/circuit-config.json", import.meta.url), "utf8"));
const presets = JSON.parse(fs.readFileSync(new URL("../public/data/circuit-presets.json", import.meta.url), "utf8"));

let pass = 0, fail = 0;
function expect(cond, name) {
  if (cond) { pass++; } else { fail++; console.log("✗", name); }
}

const mk = (p, preplaced) => ({
  rows: p.n, columns: p.m, type2Enabled: !!p.isType2Activated, targets: p.target,
  cells: (p.gridCell || []).map(c => ({ r: c.r, c: c.c, state: c.state })),
  components: p.component, preplaced, catalog,
});

// 用例：V40002（4 块 22lshape）
const p = presets["V4_BOT_0002"];
const base = solveCircuit(mk(p, undefined));
expect(base.status === "solved", "基准 V40002 应有解");

// 1) 逐块预放置 1、2、3 块（components 始终传原始数量）→ 每步仍应有解，
//    且解的剩余块数 = 4 - 已放数
const sols = [];
for (let i = 0; i < 3; i++) {
  const res = solveCircuit(mk(p, sols.map(s => ({ id: s.id, type: s.type, coordinates: s.coordinates }))));
  expect(res.status === "solved", `预放置 ${i} 块后仍应有解, got: ${res.status} ${res.message || ""}`);
  if (res.status !== "solved") break;
  // 新解不应覆盖已预放置的格子
  const occ = new Set(sols.flatMap(s => s.coordinates.map(c => c.join(","))));
  const overlap = res.placements.some(pl => pl.coordinates.some(co => occ.has(co.join(","))));
  expect(!overlap, "新解不应覆盖预放置格");
  sols.push(res.placements[0]);
}

// 2) 非法 preplaced：坐标越界 → invalid
const oob = solveCircuit(mk(p, [{ id: "22lshape", type: 1, coordinates: [[-1, 0], [-1, 1], [-1, 2]] }]));
expect(oob.status === "invalid", "越界预放置应判 invalid, got: " + oob.status);

// 3) 非法 preplaced：覆盖禁用格 → invalid（找 V40002 的禁用格）
const dis = (p.gridCell || []).find(c => c.state === 1);
if (dis) {
  const bad = solveCircuit(mk(p, [{ id: "22lshape", type: 1, coordinates: [[dis.r, dis.c], [dis.r, dis.c + 1], [dis.r + 1, dis.c]] }]));
  expect(bad.status === "invalid", "覆盖禁用格的预放置应判 invalid, got: " + bad.status);
}

// 4) 非法 preplaced：互相重叠 → invalid
const dup = solveCircuit(mk(p, [
  { id: "22lshape", type: 1, coordinates: [[0, 3], [0, 4], [1, 4]] },
  { id: "22lshape", type: 1, coordinates: [[0, 3], [1, 3], [1, 4]] },
]));
expect(dup.status === "invalid", "重叠预放置应判 invalid, got: " + dup.status);

// 5) 蓝色题：预放置一块（绿或蓝）后仍应有解
const key2 = Object.keys(presets).find(k => presets[k].isType2Activated);
if (key2) {
  const q = presets[key2];
  const base2 = solveCircuit(mk(q, undefined));
  expect(base2.status === "solved", `蓝色题 ${key2} 基准应有解`);
  const f2 = base2.placements[0];
  const mid2 = solveCircuit(mk(q, [{ id: f2.id, type: f2.type, coordinates: f2.coordinates }]));
  expect(mid2.status === "solved", "蓝色题预放置后仍应有解, got: " + mid2.status + " " + (mid2.message || ""));
}

// 6) 全部预放置 = 完整解 → 直接成功（instances 为空）
const fullSol = solveCircuit(mk(p, undefined));
const all = solveCircuit(mk(p, fullSol.placements.map(s => ({ id: s.id, type: s.type, coordinates: s.coordinates }))));
expect(all.status === "solved", "全部预放置应直接成功, got: " + all.status + " " + (all.message || ""));

console.log(`\npreplaced 测试通过 ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
