// 从 efsim 源码提取气球挂载点图标定义
import fs from "node:fs";
const src = fs.readFileSync("C:/Users/LDX/AppData/Local/Temp/efsim-app.js", "utf8");
// 找所有 svg path 的 d 属性（与挂载点/插座相关的图标）
const idx = src.indexOf("挂载点");
console.log("挂载点 出现次数:", (src.match(/挂载点/g) || []).length);
for (let i = 0; (i = src.indexOf("挂载点", i)) !== -1; i += 10) {
  console.log("---", JSON.stringify(src.slice(Math.max(0, i - 150), i + 150)));
}
// 找圆环/圆圈类的 path（挂载点中心是圆环）
const donut = [...src.matchAll(/"d":"(M[^"]*[Aa][^"]*)"/g)].slice(0, 8);
for (const m of donut) console.log("ARC-PATH:", m[1].slice(0, 120));
