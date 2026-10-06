/**
 * 生成一张测试用 PNG（自包含 PNG 编码，无需第三方依赖）。
 * 用途：自检模式下验证「打开图片 → 未配模型的纯看图引导」流程。
 */
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ---- CRC32 ---- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgb) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    rgb.copy(raw, y * stride + 1, y * width * 3, (y + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---- 画一张有内容的图：渐变背景 + 色块 + 条纹 ---- */
const W = 960;
const H = 600;
const px = Buffer.alloc(W * H * 3);

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    // 对角渐变
    let r = Math.round(30 + (x / W) * 60);
    let g = Math.round(60 + (y / H) * 90);
    let b = Math.round(120 + ((x + y) / (W + H)) * 110);

    // 中央色块
    if (x > 260 && x < 700 && y > 150 && y < 430) {
      r = 240;
      g = 196;
      b = 84;
      // 块内条纹，模拟文字行
      if (y % 40 < 12 && x > 300 && x < 660) {
        r = 40;
        g = 46;
        b = 56;
      }
    }
    // 底部条
    if (y > 500 && y < 540) {
      r = 87;
      g = 193;
      b = 255;
    }
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
  }
}

const out = path.join(__dirname, "..", "test-sample.png");
fs.writeFileSync(out, encodePNG(W, H, px));
console.log("generated:", out);
