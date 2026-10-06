// 生成应用图标占位（无需任何第三方依赖）
// 用法：node scripts/gen-icons.mjs
//
// 注意：**必须同时产出 .ico**。Windows 上 tauri-build 会生成一个 Windows
// Resource 文件，它要求 `src-tauri/icons/icon.ico` 存在；只给 icon.png 会直接
// 构建失败（报 `icons/icon.ico not found`）。原脚本只生成了 png，
// 所以 Tauri 端从来没真正构建过 —— 已补上。
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";

function crc32(buf) {
  if (!crc32.table) {
    const t = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    crc32.table = t;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++)
    crc = crc32.table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function makePng(size, [r, g, b, a]) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const off = y * (size * 4 + 1);
    raw[off] = 0;
    for (let x = 0; x < size; x++) {
      const p = off + 1 + x * 4;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
      raw[p + 3] = a;
    }
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * 把一个 PNG 包成单条目的 ICO。
 * ICO 允许直接内嵌 PNG（Vista 起支持），256×256 是最省事又够用的尺寸：
 * ICONDIR(6) + ICONDIRENTRY(16) + PNG。
 */
function makeIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(1, 4); // count

  const entry = Buffer.alloc(16);
  entry[0] = 0; // width  0 表示 256
  entry[1] = 0; // height 0 表示 256
  entry[2] = 0; // 调色板数
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(png.length, 8); // 数据长度
  entry.writeUInt32LE(6 + 16, 12); // 数据偏移

  return Buffer.concat([header, entry, png]);
}

const dir = path.resolve("src-tauri/icons");
fs.mkdirSync(dir, { recursive: true });

const COLOR = [56, 103, 214, 255];
const png512 = makePng(512, COLOR);
const png256 = makePng(256, COLOR);

fs.writeFileSync(path.join(dir, "icon.png"), png512);
console.log("✓ src-tauri/icons/icon.png 生成完成");
fs.writeFileSync(path.join(dir, "icon.ico"), makeIco(png256));
console.log("✓ src-tauri/icons/icon.ico 生成完成");

