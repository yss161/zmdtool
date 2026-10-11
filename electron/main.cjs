// Electron 主进程：内置本地 HTTP 服务托管 public/，窗口载入应用页面。
// 页面使用 ES 模块 / module Worker / fetch 本地 JSON——file:// 协议会被浏览器安全
// 策略拦截，因此必须通过内置 HTTP 服务（仅监听 127.0.0.1）加载。
//
// 端口固定为 8123（被占用时回退随机）：localStorage 的持久化依赖稳定 origin，
// 固定端口才能让「主题 / 默认模式 / 署名 / 项目地址」等设置跨重启保留。
const { app, BrowserWindow, shell, dialog, ipcMain, desktopCapturer, screen } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");

const PUB = path.join(__dirname, "..", "public");
const PREFERRED_PORT = 8123;
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

function createHandler() {
  return (req, res) => {
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
  };
}

function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer(createHandler());
    const fallback = () => {
      srv.removeListener("error", fallback);
      srv.listen(0, "127.0.0.1", () => resolve(srv.address().port));
    };
    srv.once("error", fallback);
    srv.listen(PREFERRED_PORT, "127.0.0.1", () => {
      srv.removeListener("error", fallback);
      resolve(srv.address().port);
    });
  });
}

function registerIpc() {
  // 窗口置顶（悬浮窗）
  ipcMain.handle("win:setAlwaysOnTop", (e, flag) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return false;
    win.setAlwaysOnTop(!!flag, "floating");
    return win.isAlwaysOnTop();
  });
  ipcMain.handle("win:isAlwaysOnTop", (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return win ? win.isAlwaysOnTop() : false;
  });

  // 截屏：返回屏幕源列表（含缩略图供选择）
  ipcMain.handle("desktop:captureSources", async () => {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 320, height: 180 },
    });
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      thumb: s.thumbnail.toDataURL(),
      display_id: s.display_id,
    }));
  });

  // 截取指定屏幕（用该屏幕自身分辨率）
  ipcMain.handle("desktop:captureSource", async (e, sourceId) => {
    const displays = screen.getAllDisplays();
    const dims = (() => {
      const src = displays.find((d) => String(d.id) === String(sourceId));
      const d = src || screen.getPrimaryDisplay();
      const s = d.size;
      return { width: s.width, height: s.height };
    })();
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: dims,
    });
    const src = sources.find((s) => s.id === sourceId) || sources[0];
    return src ? src.thumbnail.toDataURL() : null;
  });

  // 用系统浏览器打开外链
  ipcMain.handle("app:openExternal", (e, url) => {
    if (/^https?:/i.test(String(url || ""))) shell.openExternal(url);
    return true;
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
      preload: path.join(__dirname, "preload.cjs"),
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

app.whenReady().then(() => {
  registerIpc();
  createWindow();
});
app.on("window-all-closed", () => app.quit());
