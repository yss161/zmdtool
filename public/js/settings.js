// 桌面版能力 + 通用设置：默认解密类型 / 窗口置顶（悬浮窗）/ 直接截屏识图 / 更新检查。
// 依赖 Electron preload 注入的 window.desktop；网页版（无该对象）自动隐藏桌面专属入口。
// 设置均用 localStorage 持久化——桌面版主进程固定端口，origin 稳定，跨重启保留。

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const DESKTOP = window.desktop || null;

// 当前版本号（发布新版本时与 package.json 同步更新）
const APP_VERSION = "1.1.0";

const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

if (DESKTOP) document.body.classList.add("desktop");

// ---------- 默认解密类型 ----------
const modeSel = $("#set-mode");
if (modeSel) {
  modeSel.value = LS.get("zmd-mode", "balloon");
  modeSel.addEventListener("change", () => {
    const m = modeSel.value;
    LS.set("zmd-mode", m);
    if (window.setMode) window.setMode(m);
  });
}

// ---------- 窗口置顶（悬浮窗） ----------
const ontopBox = $("#set-ontop");
if (ontopBox && DESKTOP) {
  DESKTOP.isAlwaysOnTop().then((v) => { ontopBox.checked = !!v; });
  ontopBox.addEventListener("change", () => DESKTOP.setAlwaysOnTop(ontopBox.checked));
}

// ---------- 直接截屏识图 ----------
const captureModal = $("#capture-modal");
const captureList = $("#capture-list");

function dataURLToFile(dataUrl, name) {
  const [meta, b64] = dataUrl.split(",");
  const mime = (meta.match(/data:([^;]+)/) || [])[1] || "image/png";
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new File([buf], name, { type: mime });
}

async function runCapture() {
  if (!DESKTOP) return;
  const sources = await DESKTOP.captureSources();
  if (!sources || !sources.length) {
    alert("未检测到可用屏幕。");
    return;
  }
  captureList.innerHTML = "";
  for (const s of sources) {
    const item = document.createElement("div");
    item.className = "capture-item";
    const img = document.createElement("img");
    img.src = s.thumb;
    img.alt = s.name;
    const name = document.createElement("div");
    name.className = "cap-name";
    name.textContent = s.name || `屏幕 ${s.display_id || ""}`;
    item.append(img, name);
    item.addEventListener("click", async () => {
      captureModal.hidden = true;
      const dataUrl = await DESKTOP.captureSource(s.id);
      if (!dataUrl) { alert("截屏失败，请重试。"); return; }
      const file = dataURLToFile(dataUrl, "screenshot.png");
      if (document.body.dataset.mode === "circuit") {
        window.__analyzeScreenshotFile && window.__analyzeScreenshotFile(file);
      } else {
        window.__analyzeFile && window.__analyzeFile(file);
      }
    });
    captureList.appendChild(item);
  }
  captureModal.hidden = false;
}

const shotButtons = ["#btn-screenshot", "#c-screenshot"];
if (DESKTOP) {
  shotButtons.forEach((sel) => { const b = $(sel); if (b) b.hidden = false; });
  shotButtons.forEach((sel) => { const b = $(sel); if (b) b.addEventListener("click", runCapture); });
}
if (captureModal) {
  $("#capture-close").addEventListener("click", () => { captureModal.hidden = true; });
  captureModal.addEventListener("click", (e) => { if (e.target.id === "capture-modal") captureModal.hidden = true; });
}

// ---------- 更新检查 ----------
function compareVersion(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

async function checkUpdate() {
  try {
    const res = await fetch("https://api.github.com/repos/yss161/zmdtool/releases/latest", { cache: "no-cache" });
    if (!res.ok) return;
    const data = await res.json();
    const latest = String(data.tag_name || "").replace(/^v/, "");
    if (!latest || compareVersion(latest, APP_VERSION) <= 0) return;
    const banner = $("#update-banner");
    if (!banner) return;
    const text = $("#update-text");
    if (text) text.textContent = `发现新版本 v${latest}`;
    const link = $("#update-link");
    if (link && data.html_url) link.href = data.html_url;
    banner.hidden = false;
    const dismiss = $("#update-dismiss");
    if (dismiss) dismiss.addEventListener("click", () => { banner.hidden = true; });
  } catch { /* 网络失败静默，不打扰 */ }
}

// 页面加载完成后延迟检查更新，不阻塞启动
setTimeout(checkUpdate, 2500);
