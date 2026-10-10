// 端到端：双色数字模式截图 → 绿蓝数字 OCR + 蓝绿配对网格 → 托盘识别 → 自动求解
// 样例：tools/vision-dev/type2-digit-sample.png（7×5 type2，绿 [2,1,4,1,2]/[0,0,0,1,1,3,5]、蓝 [3,3,3,3,3]/[3,5,5,2,0,0,0]）
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

await send("Network.enable");
await send("Network.setCacheDisabled", { cacheDisabled: true });
await send("Page.navigate", { url: "http://127.0.0.1:8123/?t=e2e-type2" });
await sleep(1200);
await evalJs(`document.querySelector('.mode-tab[data-mode="circuit"]').click()`);

const b64 = fs.readFileSync(new URL("./type2-digit-sample.b64", import.meta.url), "utf8").trim();
await evalJs(`window.__shotB64 = "${b64}";`);
console.log("→ 注入双色数字截图并调用 analyzeScreenshotFile");
await evalJs(`(async () => {
  const buf = Uint8Array.from(atob(window.__shotB64), c => c.charCodeAt(0));
  const file = new File([buf], "type2.png", { type: "image/png" });
  await window.__analyzeScreenshotFile(file);
})()`);
await sleep(1500);

const v = await evalJs(`({
  rowsCols: __cstate.rows + "x" + __cstate.cols,
  type2: !!__cstate.type2,
  rowT: __cstate.rowT.join(","), colT: __cstate.colT.join(","),
  row2T: __cstate.row2T.join(","), col2T: __cstate.col2T.join(","),
  pieces: __cstate.placed.reduce((acc, p) => acc + p.cells.length, 0),
  counter: document.getElementById("c-placed").textContent + "/" + document.getElementById("c-total").textContent,
  status: document.getElementById("c-status").textContent,
})`);
console.log("  结果:", JSON.stringify({ ...v, status: v.status.split("\n")[0] }));

expect(v.rowsCols === "7x5", "棋盘 7×5", v.rowsCols);
expect(v.type2 === true, "双色模式", v.type2);
expect(v.colT === "2,1,4,1,2" && v.rowT === "0,0,0,1,1,3,5", "绿目标（数字 OCR）", v.colT + " / " + v.rowT);
expect(v.col2T === "3,3,3,3,3" && v.row2T === "3,5,5,2,0,0,0", "蓝目标（数字 OCR）", v.col2T + " / " + v.row2T);
expect(v.status.includes("找到可行解"), "自动求解成功", v.status.split("\n")[0]);
expect(v.counter.endsWith("/25"), "计数器 25 格（绿 10 + 蓝 15）", v.counter);

console.log(`\n双色数字端到端通过 ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
