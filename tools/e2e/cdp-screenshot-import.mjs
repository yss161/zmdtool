// 端到端：电路模式截图导入 → 识别 → 匹配预设 → 自动求解（真实浏览器流程）
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

// 打开首页并切到电路模式
await send("Network.enable");
  await send("Network.setCacheDisabled", { cacheDisabled: true });
  await send("Page.navigate", { url: "http://127.0.0.1:8123/?t=e2e-shot" });
await sleep(1200);
await evalJs(`document.querySelector('.mode-tab[data-mode="circuit"]').click()`);

// 注入游戏截图（base64）并走 analyzeScreenshotFile 全流程
const b64 = fs.readFileSync(new URL("./shot-sample.b64", import.meta.url), "utf8").trim();
await evalJs(`window.__shotB64 = "${b64}";`);
console.log("→ 注入截图并调用 analyzeScreenshotFile");
await evalJs(`(async () => {
  const buf = Uint8Array.from(atob(window.__shotB64), c => c.charCodeAt(0));
  const file = new File([buf], "game.jpg", { type: "image/jpeg" });
  await window.__analyzeScreenshotFile(file);
})()`);
await sleep(1200); // 等自动求解动画

const v = await evalJs(`({
  status: document.getElementById("c-status").textContent,
  preset: document.getElementById("c-preset").value,
  pieces: __cstate.placed.reduce((acc, p) => acc + p.cells.length, 0),
  rowsCols: __cstate.rows + "x" + __cstate.cols,
  supplyKeys: Object.entries(__cstate.supply).map(([id, s]) => id + ":" + s.g).join(","),
  counter: document.getElementById("c-placed").textContent + "/" + document.getElementById("c-total").textContent,
  overlayShown: !document.getElementById("c-overlay").hidden,
  overlayCanvas: document.getElementById("c-overlay-canvas").width,
})`);
console.log("  结果:", JSON.stringify({ ...v, status: v.status.split("\n")[0] }));
expect(v.status.includes("找到可行解"), "自动求解完成（状态被求解结果覆盖，匹配由预设项证明）");
expect(v.preset === "V4_BOT_0020", "识别并匹配 V40020（预设选择器已载入）");
expect(v.counter === "18/18", "自动求解完成 18/18");
expect(v.pieces === 18, "答案铺满 18 格（SVG 整体渲染）");
expect(v.overlayShown && v.overlayCanvas > 0, "识别标注按钮/画布就绪");

console.log(`\n截图导入端到端通过 ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
