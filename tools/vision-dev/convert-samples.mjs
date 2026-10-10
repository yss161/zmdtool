// 把剪贴板 JPG 样例经 headless Chrome canvas 转成 PNG（pngjs 只认 PNG）
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

const jobs = [
  ["C:/Users/LDX/.workbuddy/clipboard-images/clipboard-2026-10-08T11-15-11-613Z-b7b96b93.jpg", "type2-bar-sample.png"],
  ["C:/Users/LDX/.workbuddy/clipboard-images/clipboard-2026-10-08T11-15-11-616Z-6e3da2d3.jpg", "type2-digit-sample.png"],
];
for (const [src, name] of jobs) {
  const b64 = fs.readFileSync(src).toString("base64");
  const dataUrl = await evalJs(`(async () => {
    const img = new Image();
    img.src = "data:image/jpeg;base64,${b64}";
    await img.decode();
    const cv = document.createElement("canvas");
    cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    cv.getContext("2d").drawImage(img, 0, 0);
    return cv.toDataURL("image/png");
  })()`);
  fs.writeFileSync(new URL("./" + name, import.meta.url), Buffer.from(dataUrl.split(",")[1], "base64"));
  console.log(name, "written");
}
process.exit(0);
