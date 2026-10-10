// 调试：对比浏览器与 Node 对同一图像的识别差异
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
  if (r.exceptionDetails) throw new Error("页面异常: " + (r.exceptionDetails.exception?.description || ""));
  return r.result.value;
};

const b64 = fs.readFileSync(new URL("../e2e/shot-balloon.b64", import.meta.url), "utf8").trim();
await send("Page.enable");
await send("Network.enable");
await send("Network.setCacheDisabled", { cacheDisabled: true });
await send("Page.navigate", { url: "http://127.0.0.1:8123/?t=debug-vn" });
await new Promise(r => setTimeout(r, 1500));
const out = await evalJs(`(async () => {
  const buf = Uint8Array.from(atob(window.__shotB64 || "${b64}"), c => c.charCodeAt(0));
  const blob = new Blob([buf], { type: "image/png" });
  // 路径 A：createImageBitmap
  const bmp = await createImageBitmap(blob);
  const cvA = document.createElement("canvas");
  cvA.width = bmp.width; cvA.height = bmp.height;
  const ctxA = cvA.getContext("2d", { willReadFrequently: true });
  ctxA.drawImage(bmp, 0, 0);
  const imgA = ctxA.getImageData(0, 0, cvA.width, cvA.height);
  // 路径 B：Image 元素（analyzeScreenshotFile 实际使用的路径）
  const url = URL.createObjectURL(blob);
  const im = new Image();
  await new Promise((res, rej) => { im.onload = res; im.onerror = rej; im.src = url; });
  const cvB = document.createElement("canvas");
  cvB.width = im.naturalWidth; cvB.height = im.naturalHeight;
  const ctxB = cvB.getContext("2d", { willReadFrequently: true });
  ctxB.drawImage(im, 0, 0);
  URL.revokeObjectURL(url);
  const imgB = ctxB.getImageData(0, 0, cvB.width, cvB.height);
  const analyzeScreenshot = window.__analyzeScreenshot;
  const resA = analyzeScreenshot(imgA, {});
  const resB = analyzeScreenshot(imgB, {});
  const sum = (img) => { let s = 0; for (let i = 0; i < img.data.length; i += 4) s += img.data[i] + img.data[i+1] + img.data[i+2]; return s; };
  return {
    sizeA: [imgA.width, imgA.height], sizeB: [imgB.width, imgB.height],
    sumA: sum(imgA), sumB: sum(imgB),
    balloonsA: resA.board ? resA.board.cells.filter(c => c.state === "balloon").length : "n/a",
    balloonsB: resB.board ? resB.board.cells.filter(c => c.state === "balloon").length : "n/a",
    fillableA: resA.board ? resA.board.cells.filter(c => c.state === "fillable").length : "n/a",
    fillableB: resB.board ? resB.board.cells.filter(c => c.state === "fillable").length : "n/a",
  };
})()`);
console.log("浏览器:", JSON.stringify(out, null, 1));
process.exit(0);

// Node 对照
const { PNG } = await import("pngjs");
const png = PNG.sync.read(fs.readFileSync(new URL("../vision-dev/balloon-original.png", import.meta.url)));
const px = (x, y) => { const i = (y * png.width + x) * 4; return [png.data[i], png.data[i+1], png.data[i+2]]; };
console.log("Node 同位置像素:", JSON.stringify(px(out.probe.cx, out.probe.cy)));
console.log("Node 尺寸:", png.width, png.height);
process.exit(0);
