// 端到端：气球模式粘贴截图 → 识别（6列布局兼容）→ 渲染 → 求解
import fs from "node:fs";

const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = list.find(t => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pend = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("页面异常: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const expect = (cond, name) => { if (cond) { pass++; console.log("  ✓", name); } else { fail++; console.log("  ✗", name); } };

await send("Network.enable");
  await send("Network.setCacheDisabled", { cacheDisabled: true });
  await send("Page.navigate", { url: "http://127.0.0.1:8123/?t=e2e-balloon" });
await sleep(1200);

// 注入截图并模拟粘贴事件
const b64 = fs.readFileSync(new URL("./shot-balloon.b64", import.meta.url), "utf8").trim();
await evalJs(`window.__shotB64 = "${b64}";`);
console.log("→ 模拟粘贴 WL-A1006 截图");
await evalJs(`(async () => {
  const buf = Uint8Array.from(atob(window.__shotB64), c => c.charCodeAt(0));
  const file = new File([buf], "shot.png", { type: "image/png" });
  await window.__analyzeFile(file);
})()`);
await sleep(1000);

const v = await evalJs(`({
  cols: __state.cols,
  rows: __state.rows,
  cells: __state.cells.length,
  balloonPositions: __state.cells.filter(c => c.state === "balloon").map(c => c.gx + "," + c.gy).sort().join(" "),
  inventory: JSON.stringify(__state.inventory),
  gridCols: document.getElementById("board").style.gridTemplateColumns,
  status: document.getElementById("status").textContent.slice(0, 50),
})`);
console.log("  识别+自动求解:", JSON.stringify({ ...v, status: v.status.replace(/\n/g, " ") }));
expect(v.cols === 5 && v.rows === 5, "棋盘 5×5");
expect(v.cells === 25, "25 格");
// 识别出的 7 个可放置格即求解后气球所在位置（自动求解在识别后立即触发）
const expectedCells = ["1,2", "2,1", "3,1", "1,3", "2,3", "3,3", "3,2"].sort().join(" ");
expect(v.balloonPositions === expectedCells, "7 个可放置格位置正确（气球已由自动求解放置）", v.balloonPositions);
expect(v.gridCols.startsWith("repeat(5"), "CSS 网格按 5 列渲染");

// 再次求解（按钮）：应维持平衡
console.log("→ 再次自动求解");
await evalJs(`document.getElementById("btn-solve").click()`);
await sleep(2500);
const s = await evalJs(`({
  status: document.getElementById("status").textContent,
  vec: document.getElementById("vector").textContent,
  placed: __state.cells.filter(c => c.state === "balloon").length,
  balanced: Math.abs(__state.cells.reduce((acc, c) => c.state === "balloon" ? { x: acc.x + c.value * c.x, y: acc.y + c.value * c.y } : acc, { x: 0, y: 0 }).x) < 0.01 &&
            Math.abs(__state.cells.reduce((acc, c) => c.state === "balloon" ? { x: acc.x + c.value * c.x, y: acc.y + c.value * c.y } : acc, { x: 0, y: 0 }).y) < 0.01,
})`);
console.log("  求解:", JSON.stringify({ status: s.status.slice(0, 60), vec: s.vec, placed: s.placed, balanced: s.balanced }));
expect(s.placed === 7, "7 个气球全部放置");
expect(s.balanced, "总向量为零（平衡）");

console.log(`\n气球截图导入端到端通过 ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
