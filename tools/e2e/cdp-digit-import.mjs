// 端到端：电路模式截图导入（数字显示模式）→ 数字 OCR 识别行列目标 → 托盘识别 → 自动求解
// 样例：tools/vision-dev/digit-sample.png（5×5，目标 [3,5,5,5,3]，锁定格 (2,2)，元件 33cross×2 + 33wshape×2）
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
await send("Page.navigate", { url: "http://127.0.0.1:8123/?t=e2e-digit" });
await sleep(1200);
await evalJs(`document.querySelector('.mode-tab[data-mode="circuit"]').click()`);

// 注入截图（base64）并走 analyzeScreenshotFile 全流程
const b64 = fs.readFileSync(new URL("./digit-sample.b64", import.meta.url), "utf8").trim();
await evalJs(`window.__shotB64 = "${b64}";`);
console.log("→ 注入数字模式截图并调用 analyzeScreenshotFile");
await evalJs(`(async () => {
  const buf = Uint8Array.from(atob(window.__shotB64), c => c.charCodeAt(0));
  const file = new File([buf], "digit.png", { type: "image/png" });
  await window.__analyzeScreenshotFile(file);
})()`);
await sleep(1500); // 等自动求解动画

const v = await evalJs(`({
  rowsCols: __cstate.rows + "x" + __cstate.cols,
  supply: Object.entries(__cstate.supply).map(([id, s]) => id + ":" + (s.g + (s.b || 0))).sort().join(","),
  pieces: __cstate.placed.reduce((acc, p) => acc + p.cells.length, 0),
  counter: document.getElementById("c-placed").textContent + "/" + document.getElementById("c-total").textContent,
  status: document.getElementById("c-status").textContent,
  overlayShown: !document.getElementById("c-overlay").hidden,
  rowT: __cstate.rowT.join(","), colT: __cstate.colT.join(","),
})`);
console.log("  结果:", JSON.stringify({ ...v, status: v.status.split("\n")[0] }));

expect(v.rowsCols === "5x5", "棋盘 5×5", v.rowsCols);
expect(v.rowT === "3,5,5,5,3" && v.colT === "3,5,5,5,3", "行列目标 [3,5,5,5,3]（数字 OCR）", v.rowT + " / " + v.colT);
expect(v.supply === "33cross:2,33wshape:2", "托盘识别 33cross×2 + 33wshape×2", v.supply);
expect(v.status.includes("找到可行解"), "自动求解成功", v.status.split("\n")[0]);
expect(v.counter === "20/20" && v.pieces === 20, "铺满 20 格（21 目标含 1 常亮，常亮不计数）", v.counter + " pieces=" + v.pieces);
expect(v.overlayShown, "识别标注画布就绪");

console.log(`\n数字模式端到端通过 ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
