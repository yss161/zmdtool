// 构建 Windows 桌面版（Electron 绿色目录 + 7z 自解压单文件 exe）
//
// 用法：npm run build:exe
// 前置：npm install（需要 node_modules/electron/dist 运行时与 7-Zip 安装）
//
// 产物：
//   dist/zmdtool/            绿色目录版（双击 zmdtool.exe 运行）
//   dist/pack/zmdtool-portable.exe   单文件版（双击 → 解压到当前目录 zmdtool/ 并启动）
//
// 说明：之所以手工组装而不使用 electron-builder —— 后者需联网下载额外组件，
// 在受限网络下反复超时；本脚本只用本地已有的 Electron 运行时与 7-Zip，完全离线。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, "dist");
const appDir = path.join(dist, "zmdtool");
const packDir = path.join(dist, "pack");
const SEVEN_Z = "C:/Program Files/7-Zip/7z.exe";
const SEVEN_Z_SFX = "C:/Program Files/7-Zip/7z.sfx";

const log = (m) => console.log("[build-exe] " + m);

// 1. 检查前置
const electronDist = path.join(root, "node_modules", "electron", "dist");
if (!fs.existsSync(path.join(electronDist, "electron.exe"))) {
  console.error("缺少 Electron 运行时：请先 npm install（如二进制未下载，运行 node node_modules/electron/install.js）");
  process.exit(1);
}
if (!fs.existsSync(SEVEN_Z)) {
  console.error("缺少 7-Zip（未找到 " + SEVEN_Z + "）");
  process.exit(1);
}

// 2. 组装 dist/zmdtool（Electron 运行时 + resources/app）
// 采用覆盖式同步而非整目录删除重建：批量删除可能被环境安全策略拦截，
// 且构建产物目录用覆盖同样可靠（源固定，无陈旧文件风险）。
log("复制 Electron 运行时…");
fs.mkdirSync(appDir, { recursive: true });
fs.cpSync(electronDist, appDir, { recursive: true, force: true });

log("组装应用文件…");
const appRoot = path.join(appDir, "resources", "app");
// 应用子目录文件量小，逐个清理后复制（保证无陈旧文件）
for (const sub of ["electron", "public"]) {
  const target = path.join(appRoot, sub);
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(path.join(root, sub), target, { recursive: true });
}
fs.writeFileSync(
  path.join(appRoot, "package.json"),
  JSON.stringify({ name: "zmdtool", version: "1.0.0", main: "electron/main.cjs" }, null, 2)
);
// exe 用英文名（SFX 自解压的 RunProgram 对中文路径编码兼容性差）
const exeSrc = path.join(appDir, "electron.exe");
const exeDst = path.join(appDir, "zmdtool.exe");
if (fs.existsSync(exeDst)) fs.rmSync(exeDst, { force: true });
fs.renameSync(exeSrc, exeDst);

// 3. 压缩为 app.7z
log("压缩应用（约 2 分钟）…");
fs.mkdirSync(packDir, { recursive: true });
const app7z = path.join(packDir, "app.7z");
fs.rmSync(app7z, { force: true });
execFileSync(SEVEN_Z, ["a", "-mx=9", "-mmt=on", app7z, "zmdtool/"], { cwd: dist, stdio: "inherit" });

// 4. 拼接自解压单文件 exe（7z.sfx + config.txt + app.7z）
log("拼接自解压单文件…");
const config = [
  ";!@Install@!UTF-8!",
  'Title="终末地解密工具"',
  'BeginPrompt="解压并运行【终末地解密工具】？\\n（将在当前目录创建 zmdtool 文件夹）"',
  'RunProgram="zmdtool\\\\zmdtool.exe"',
  ";!@InstallEnd@!",
  "",
].join("\n");
const configPath = path.join(packDir, "config.txt");
fs.writeFileSync(configPath, config, "utf8");

const outExe = path.join(packDir, "zmdtool-portable.exe");
fs.rmSync(outExe, { force: true });
const chunks = [
  fs.readFileSync(SEVEN_Z_SFX),
  fs.readFileSync(configPath),
  fs.readFileSync(app7z),
];
fs.writeFileSync(outExe, Buffer.concat(chunks));
fs.rmSync(app7z, { force: true });
fs.rmSync(configPath, { force: true });

const sizeMB = (fs.statSync(outExe).size / 1024 / 1024).toFixed(1);
log(`完成：dist/zmdtool/（绿色目录）与 dist/pack/zmdtool-portable.exe（${sizeMB} MB）`);
