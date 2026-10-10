# 终末地解密工具（浮空气球 & 源石电路）

《明日方舟：终末地》解密辅助工具合集，浏览器打开即用。**全部计算在浏览器本地完成，不会上传任何数据。**

> 非官方玩家工具，与《明日方舟：终末地》的开发商、发行商及运营方无隶属或授权关系。游戏名称及相关内容的权利归其权利人所有。

## 模式一：浮空气球解密

**上传游戏截图即可自动读取棋盘与气球库存，无需手动输入**，一键求出保持平衡的摆放方案。

- **截图自动识别**：上传 / Ctrl+V 粘贴 / 拖入 / 读剪贴板，自动完成
  - 棋盘定位（格子方块检测，支持 5×5 / 6×6 等任意规模；底座亮点投票兜底）
  - 每格分类：可放置（空）/ 禁用 / 已放气球（按色相家族判断升力值）
  - 右侧库存：各级气球圆盘识别 + 数量徽章数字 OCR（低置信度会标红提醒手动核对）
  - "识别标注"浮层：在截图上画出识别结果，方便人工核对
- **自动求解**：总向量 (Σ升力·x, Σ升力·y) 归零的 DFS 搜索，带双轴区间剪枝与记忆化，Web Worker 后台运行；支持判断解的唯一性
- **游戏风格棋盘**：拖拽放置 / 移动气球、点击收回、右键切换格子启用/禁用，升力进度条与实时总向量
- 中途截图也能用：已放的气球作为固定项，库存读取剩余数量，求解器接着算

### 谜题规则

5×5 棋盘（坐标 x, y ∈ [-2, 2]），在格 (x, y) 放置升力为 v 的气球产生分量 (v·x, v·y)。所有气球放置完毕后，总向量必须为 (0, 0)（保持平衡）。

## 模式二：设备修复 · 源石电路

"设备修复"玩法（Δ-V4xxxx、WL 系列）求解器，覆盖社区解密计算器整理的 **26 种可旋转元件**与 **109 道官方关卡**，本地一键求解。

- **截图导入自动解密**：上传 / Ctrl+V 粘贴 / 拖入游戏截图（默认"图形"显示模式），自动识别棋盘格状态与行列计数段，匹配官方关卡后一键求解；"识别标注"浮层可核对识别结果；未匹配到预设时载入棋盘与目标，手动补元件即可
- **官方关卡预设**：V4 系列（维序者区）、WL 系列（武陵区）、主线/据点/活动关卡，搜索关卡号或地点直达；支持 `#V40020` 这样的深链接
- **一键求解**：毫秒级出解并动画摆上棋盘；备用元件（可弃置）的题自动尝试弃置组合
- **蓝色组件（双目标）**：自动识别并渲染绿/蓝双排行列目标与蓝/绿元件
- **手动编辑**：右键循环切换格子状态（空 → 禁用 ⊘ → 绿/蓝常亮锁定），行列目标直接输入；点选元件后点击棋盘放置，R 旋转，点击已放元件收回
- **中途求解**：手动摆上的元件作为固定项，求解器接着算剩余部分
- 目标面积 / 元件面积实时校验提示，行列合计不一致会标警

### 谜题规则

n×m 棋盘，每行/列的绿色（蓝色）被照亮格数需等于对应目标数字。元件可旋转、不可重叠、不能压到禁用格与常亮锁定格（锁定格计入目标）；部分关卡提供备用元件，允许少放。

## 部署（Cloudflare Workers / Pages）

纯静态站点，无需构建：

```bash
npm install

# 本地开发（http://localhost:8787）
npx wrangler dev

# 部署到 Cloudflare Workers
npx wrangler deploy

# 或者部署到 Cloudflare Pages
npx wrangler pages deploy public
```

也可以在 Cloudflare Dashboard 里用 "Workers & Pages → Upload assets" 直接上传 `public/` 目录。

## 本地开发与测试

```bash
npm run test:vision      # 气球截图识别回归测试（test/sample*.png 样例）
npm run test:vision3     # 气球截图识别：WL-A1006 原图（裁剪/缩放兼容回归）
npm run test:solver      # 气球求解器单元测试
npm run test:circuit     # 电路求解器回归：109 道官方预设全部求解并校验
npm run test:circuit-pre # 电路预放置（中途求解）逻辑测试
npm run test:circuit-vision # 电路截图识别回归（游戏实拍样例，"图形"计数条模式）
npm run test:circuit-digits # 电路截图识别回归（"数字"显示模式，数字 OCR）
npm run test:circuit-type2  # 电路截图识别回归（双色模式：计数条双色 + 数字双色）
```

浏览器端到端交互测试（需本地服务 + 带 CDP 端口的 headless Chrome）：

```bash
python -m http.server -d public 8123
chrome --headless=new --remote-debugging-port=9222 --user-data-dir=<tmp> about:blank
node tools/e2e/cdp-circuit-test.mjs        # 电路页面交互（22 例）
node tools/e2e/cdp-screenshot-import.mjs   # 截图导入 → 预设匹配 → 自动求解
node tools/e2e/cdp-tray-import.mjs         # 无预设题：托盘元件识别（不依赖题库）→ 自动求解
node tools/e2e/cdp-digit-import.mjs        # 数字显示模式：数字 OCR → 托盘识别 → 自动求解
node tools/e2e/cdp-type2-import.mjs        # 双色数字模式：绿蓝配对 OCR → 托盘识别 → 自动求解
node tools/e2e/cdp-balloon-import.mjs      # 气球截图导入
```

任意静态服务器也可预览（无需 wrangler）：`python -m http.server -d public 8080`

## 项目结构

```
public/
  index.html            页面结构（气球 / 电路 双模式）
  style.css             终末地风格深色 UI
  js/vision.js          气球截图识别（纯函数，可在 Node 中回归测试）
  js/solver.js          气球求解器（纯函数）
  js/worker.js          气球求解 Web Worker
  js/app.js             气球 UI 交互、截图识别编排、徽章数字 OCR
  js/circuit-solver.js  电路求解器（纯函数：行列目标 + 元件铺砖 + 弃置/预放置）
  js/circuit-vision.js  电路截图识别（棋盘格状态 + 计数段/数字 OCR 目标 + 托盘元件识别 + 预设匹配；支持游戏"图形"与"数字"两种显示模式）
  js/circuit-app.js     电路模式 UI（截图导入、棋盘编辑、元件库、预设、求解渲染）
  data/circuit-config.json   26 种元件目录（名称/形状/颜色）
  data/circuit-presets.json  109 道官方关卡数据
wrangler.toml           Cloudflare Workers 静态资源配置
tools/                  Node 测试脚本；e2e/ 为 CDP 浏览器交互测试
test/                   识别回归测试样例截图
```
