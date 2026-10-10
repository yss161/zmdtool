// 端到端：电路模式截图导入（无官方预设的题）→ 托盘元件识别（不依赖题库）→ 自动求解
// 样例：tools/vision-dev/tray-sample.png（6×6，元件托盘 4 个形状，目标总和 23）
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
const expect = (cond, name, extra) => { if (cond) { pass++; console.log("  ✓", name); } else { fail++; console.log("  ✗", name, extra !== undefined ? JSON.stringify(extra) : ""); } };

// 打开首页并切到电路模式
await send("Network.enable");
await send("Network.setCacheDisabled", { cacheDisabled: true });
await send("Page.navigate", { url: "http://127.0.0.1:8123/?t=e2e-tray" });
await sleep(1200);
await evalJs(`document.querySelector('.mode-tab[data-mode="circuit"]').click()`);

// 注入截图（base64）并走 analyzeScreenshotFile 全流程
const b64 = fs.readFileSync(new URL("./tray-sample.b64", import.meta.url), "utf8").trim();
await evalJs(`window.__shotB64 = "${b64}";`);
console.log("→ 注入托盘样例截图并调用 analyzeScreenshotFile");
await evalJs(`(async () => {
  const buf = Uint8Array.from(atob(window.__shotB64), c => c.charCodeAt(0));
  const file = new File([buf], "tray.png", { type: "image/png" });
  await window.__analyzeScreenshotFile(file);
})()`);
await sleep(1500); // 等自动求解动画（4 个元件 × 55ms 间隔 + 求解）

const v = await evalJs(`({
  rowsCols: __cstate.rows + "x" + __cstate.cols,
  supply: Object.entries(__cstate.supply).map(([id, s]) => id + ":" + (s.g + (s.b || 0))).sort().join(","),
  supplyTotal: Object.values(__cstate.supply).reduce((a, s) => a + s.g + (s.b || 0), 0),
  pieces: __cstate.placed.reduce((acc, p) => acc + p.cells.length, 0),
  counter: document.getElementById("c-placed").textContent + "/" + document.getElementById("c-total").textContent,
  status: document.getElementById("c-status").textContent,
  overlayShown: !document.getElementById("c-overlay").hidden,
})`);
console.log("  结果:", JSON.stringify({ ...v, status: v.status.split("\n")[0] }));

expect(v.rowsCols === "6x6", "棋盘 6×6", v.rowsCols);
expect(v.supply === "33chlu:1,33lshape:1,33lusquare:1,33wshape:1", "托盘识别 4 元件（不依赖题库）", v.supply);
expect(v.supplyTotal === 4, "托盘元件共 4 块", v.supplyTotal);
expect(v.counter === "23/23", "计数器 23/23（行/列目标识别正确）", v.counter);
expect(v.pieces === 23, "答案铺满 23 格", v.pieces);
expect(v.status.includes("找到可行解"), "自动求解成功", v.status.split("\n")[0]);
expect(v.overlayShown, "识别标注画布就绪");

console.log(`\n托盘识别端到端通过 ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
