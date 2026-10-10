// 浏览器端徽章数字 OCR：用常见无衬线字体渲染 0-9 模板，
// 与 vision.js 提取的数字掩膜（同样归一化到 20x28）做 IoU 匹配。
import { padNormalize } from "./vision.js";

export function createCanvasDigitOcr() {
  const cnv = document.createElement("canvas");
  cnv.width = 44; cnv.height = 60;
  const ctx = cnv.getContext("2d", { willReadFrequently: true });
  const fonts = [
    '700 48px Arial', '700 48px "Segoe UI"', '700 48px Tahoma',
    '700 48px "Noto Sans"', '700 48px "Microsoft YaHei"', '700 48px sans-serif',
  ];
  const templates = {};
  for (let d = 0; d <= 9; d++) {
    templates[d] = [];
    for (const f of fonts) {
      ctx.clearRect(0, 0, 44, 60);
      ctx.fillStyle = "#fff";
      ctx.font = f; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(String(d), 22, 32);
      const id = ctx.getImageData(0, 0, 44, 60);
      let x0 = 44, y0 = 60, x1 = 0, y1 = 0, any = false;
      for (let p = 0; p < 44 * 60; p++) if (id.data[p * 4 + 3] > 100) {
        any = true;
        const x = p % 44, y = (p / 44) | 0;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      if (!any) continue;
      const w = x1 - x0 + 1, h = y1 - y0 + 1;
      const tight = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        tight[y * w + x] = id.data[(((y + y0) * 44) + (x + x0)) * 4 + 3] > 100 ? 1 : 0;
      }
      templates[d].push(padNormalize({ mask: tight, w, h }));
    }
  }
  return { templates: (d) => templates[d] || [] };
}
