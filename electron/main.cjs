// Electron 主进程：内置本地 HTTP 服务托管 public/，窗口载入应用页面。
// 页面使用 ES 模块 / module Worker / fetch 本地 JSON——file:// 协议会被浏览器安全
// 策略拦截，因此必须通过内置 HTTP 服务（仅监听 127.0.0.1 随机端口）加载。
const { app, BrowserWindow, shell, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");

const PUB = path.join(__dirname, "..", "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function startServer() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      let urlPath;
      try { urlPath = decodeURIComponent((req.url || "/").split("?")[0]); }
      catch { res.writeHead(400); return res.end(); }
      const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
      const fp = path.normalize(path.join(PUB, rel));
      if (!fp.startsWith(PUB)) { res.writeHead(403); return res.end("forbidden"); }
      fs.readFile(fp, (err, data) => {
        if (err) { res.writeHead(404); return res.end("not found"); }
        res.writeHead(200, { "Content-Type": MIME[path.extname(fp).toLowerCase()] || "application/octet-stream" });
        res.end(data);
      });
    });
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => resolve(srv.address().port));
  });
}

async function createWindow() {
  let port;
  try {
    port = await startServer();
  } catch (e) {
    dialog.showErrorBox("启动失败", "内置服务无法启动：" + e.message);
    app.quit();
    return;
  }
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 700,
    autoHideMenuBar: true,
    backgroundColor: "#14171c",
    title: "终末地解密工具",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // 关闭拼写检查下划线等，保持界面干净
      spellcheck: false,
    },
  });
  win.loadURL(`http://127.0.0.1:${port}/index.html`);
  // 外部链接（如 GitHub）交给系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
