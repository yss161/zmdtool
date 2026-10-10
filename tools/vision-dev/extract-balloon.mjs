// 从 efsim 源码提取气球圆盘（回收气球）图标定义
import fs from "node:fs";
const src = fs.readFileSync("C:/Users/LDX/AppData/Local/Temp/efsim-app.js", "utf8");
for (const kw of ["balloon-disc", "recov-disc", "disc__", "balloon-glyph", "level-disc", "recovery-balloon"]) {
  let i = src.indexOf(kw);
  if (i >= 0) {
    console.log("=== 关键词:", kw, "at", i);
    console.log(JSON.stringify(src.slice(Math.max(0, i - 120), i + 400)));
  }
}
// 也搜箭头图形（圆盘上的升力箭头）
const arrow = src.indexOf("12 8L");
if (arrow >= 0) console.log("=== ARROW:", JSON.stringify(src.slice(arrow - 200, arrow + 200)));
