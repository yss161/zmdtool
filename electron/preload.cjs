// Electron 预加载脚本：通过 contextBridge 向渲染层暴露受限的桌面能力。
// 页面在 contextIsolation 下运行，无法直接 require electron，只能经此桥接。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  isDesktop: true,
  // 窗口置顶（悬浮窗）
  setAlwaysOnTop: (flag) => ipcRenderer.invoke("win:setAlwaysOnTop", !!flag),
  isAlwaysOnTop: () => ipcRenderer.invoke("win:isAlwaysOnTop"),
  // 截屏：先取屏幕列表（含缩略图供选择），再按源 id 截取整屏
  captureSources: () => ipcRenderer.invoke("desktop:captureSources"),
  captureSource: (sourceId) => ipcRenderer.invoke("desktop:captureSource", sourceId),
  // 用系统浏览器打开外链
  openExternal: (url) => ipcRenderer.invoke("app:openExternal", url),
});
