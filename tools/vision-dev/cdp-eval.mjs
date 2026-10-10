// CDP 图像分析工具：加载图片，返回像素分析结果
// 用法: node cdp-eval.mjs <图片路径> <JS表达式文件>
import fs from "node:fs";

const [imgPath, exprFile] = process.argv.slice(2);
const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = list.find(t => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pend = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

const b64 = fs.readFileSync(imgPath).toString("base64");
const ext = imgPath.endsWith(".png") ? "image/png" : "image/jpeg";
const expr = fs.readFileSync(exprFile, "utf8");
const out = await evalJs(`(async () => {
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:${ext};base64,${b64}"; });
  const cv = document.createElement("canvas");
  cv.width = img.naturalWidth; cv.height = img.naturalHeight;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, cv.width, cv.height);
  const W = cv.width, H = cv.height, D = data.data;
  const px = (x, y) => { const i = (y * W + x) * 4; return [D[i], D[i + 1], D[i + 2]]; };
  ${expr}
})()`);
console.log(JSON.stringify(out, null, 1));
ws.close();
process.exit(0);
