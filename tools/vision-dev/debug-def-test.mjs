// 决定性测试：页面内 fetch vision.js 源码 → data-URI module import → 对比 Node 结果
import fs from "node:fs";

const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = list.find(t => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pend = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error("页面异常: " + (r.exceptionDetails.exception?.description || "")); return r.result.value; };
await send("Network.enable");
await send("Network.setCacheDisabled", { cacheDisabled: true });
await send("Page.navigate", { url: "http://127.0.0.1:8123/?t=def-test" });
await new Promise(r => setTimeout(r, 1800));

const presetsJSON = fs.readFileSync(new URL("../../public/data/circuit-presets.json", import.meta.url), "utf8");
const catalogJSON = fs.readFileSync(new URL("../../public/data/circuit-config.json", import.meta.url), "utf8");
const b64 = fs.readFileSync(new URL("../vision-dev/tray-sample.png", import.meta.url)).toString("base64");
const v = await evalJs(`(async () => {
  const r = await fetch('/js/circuit-vision.js');
  const text = (await r.text()).replace('"./circuit-solver.js"', '"http://127.0.0.1:8123/js/circuit-solver.js"');
  const mod = await import('data:text/javascript;base64,' + btoa(unescape(encodeURIComponent(text))));
  const buf = Uint8Array.from(atob('${b64}'), c => c.charCodeAt(0));
  const bmp = await createImageBitmap(new Blob([buf], { type: 'image/png' }));
  const cv = document.createElement('canvas');
  cv.width = bmp.width; cv.height = bmp.height;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, cv.width, cv.height);
  const presets = ${presetsJSON};
  const catalog = ${catalogJSON};
  const res = mod.analyzeCircuitScreenshot(img, presets, { catalog, debug: true });
  return { rows: res.rows, cols: res.cols, rowT: res.rowT, colT: res.colT, components: res.components, match: res.match, colGroups: res.debug.colGroups, rowGroups: res.debug.rowGroups };
})()`);
console.log("页面内 data-URI 模块识别:", JSON.stringify(v, null, 1));
process.exit(0);
