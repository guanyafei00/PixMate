/**
 * 生成测试相册到 test-album/，用于验证文件夹翻页浏览与信息面板。
 *
 * 含两类图：
 *   1) photo_1..3.png —— 不同主色调 + 编号色块，肉眼可区分，用于翻页测试
 *   2) photo_9_exif.png —— **带 EXIF 的图**，用于验证 EXIF 解析器
 *
 * 为什么自己造 EXIF：自检要断言「EXIF 真的被解析出来了」，
 * 而解析器是新写的代码 —— 没有真实样本就没法验。
 * 这里手写一个最小但合法的 TIFF/EXIF 块塞进 PNG 的 eXIf 段，
 * 好处是**不需要任何第三方依赖**（不用找样图、不用引 JPEG 编码器）。
 *
 * 排序说明：命名用 photo_1/2/3 与 photo_9_exif，自然排序下 EXIF 图排在最后，
 * 便于自检先做完翻页/编辑流程、最后翻到它验 EXIF。
 */
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ---------------- PNG 编码 ---------------- */

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

/** 把 RGB 像素编码成 PNG；extraChunks 可插入 eXIf 之类的块 */
function encodePNG(width, height, rgb, extraChunks = []) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    rgb.copy(raw, y * stride + 1, y * width * 3, (y + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    ...extraChunks,
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---------------- 手写 EXIF（TIFF 块） ---------------- */

const TYPE_SIZE = { 2: 1, 3: 2, 4: 4, 5: 8 };
const ascii = (s) => Buffer.from(s + "\0", "latin1");
const short = (v) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v, 0);
  return b;
};
const rational = (n, d) => {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(n, 0);
  b.writeUInt32LE(d, 4);
  return b;
};

/**
 * 组装一个最小但合法的 TIFF/EXIF 块（小端）。
 * 布局：TIFF头(8) → IFD0 → IFD0数据区 → ExifIFD → ExifIFD数据区
 * 所有大值（>4 字节）放到数据区，条目里存偏移。
 */
function buildExifTiff() {
  const ifd0 = [
    { tag: 0x010f, type: 2, data: ascii("PixCam") },
    { tag: 0x0110, type: 2, data: ascii("TestModel X1") },
    { tag: 0x0132, type: 2, data: ascii("2026:09:18 22:30:00") },
    { tag: 0x0131, type: 2, data: ascii("AI Image Viewer") },
  ];
  const exifIfd = [
    { tag: 0x829a, type: 5, data: rational(1, 250) }, // 快门 1/250
    { tag: 0x829d, type: 5, data: rational(28, 10) }, // 光圈 f/2.8
    { tag: 0x8827, type: 3, data: short(400) }, // ISO 400
    { tag: 0x920a, type: 5, data: rational(500, 10) }, // 焦距 50mm
    { tag: 0x9003, type: 2, data: ascii("2026:09:18 22:30:00") }, // 拍摄时间
  ];

  const align4 = (n) => (n + 3) & ~3;
  const ifdSize = (n) => 2 + n * 12 + 4;

  const ifd0Start = 8;
  const ifd0Size = ifdSize(ifd0.length + 1); // +1 = ExifIFDPointer
  let cursor = ifd0Start + ifd0Size;

  // IFD0 的大值放数据区
  for (const e of ifd0) {
    if (e.data.length > 4) {
      cursor = align4(cursor);
      e.offset = cursor;
      cursor += e.data.length;
    }
  }

  cursor = align4(cursor);
  const exifIfdStart = cursor;
  const exifIfdSize = ifdSize(exifIfd.length);
  cursor += exifIfdSize;

  for (const e of exifIfd) {
    if (e.data.length > 4) {
      cursor = align4(cursor);
      e.offset = cursor;
      cursor += e.data.length;
    }
  }

  const buf = Buffer.alloc(align4(cursor));
  buf.write("II", 0, "latin1");
  buf.writeUInt16LE(42, 2);
  buf.writeUInt32LE(ifd0Start, 4);

  const writeEntry = (e, p) => {
    buf.writeUInt16LE(e.tag, p);
    buf.writeUInt16LE(e.type, p + 2);
    buf.writeUInt32LE(e.data.length / TYPE_SIZE[e.type], p + 4);
    if (e.data.length > 4) buf.writeUInt32LE(e.offset, p + 8);
    else e.data.copy(buf, p + 8);
  };

  // IFD0
  let p = ifd0Start;
  buf.writeUInt16LE(ifd0.length + 1, p);
  p += 2;
  for (const e of ifd0) {
    writeEntry(e, p);
    p += 12;
  }
  // ExifIFDPointer
  buf.writeUInt16LE(0x8769, p);
  buf.writeUInt16LE(4, p + 2);
  buf.writeUInt32LE(1, p + 4);
  buf.writeUInt32LE(exifIfdStart, p + 8);
  p += 12;
  buf.writeUInt32LE(0, p); // 无下一个 IFD

  // IFD0 数据区
  for (const e of ifd0) if (e.data.length > 4) e.data.copy(buf, e.offset);

  // ExifIFD
  p = exifIfdStart;
  buf.writeUInt16LE(exifIfd.length, p);
  p += 2;
  for (const e of exifIfd) {
    writeEntry(e, p);
    p += 12;
  }
  buf.writeUInt32LE(0, p);

  // ExifIFD 数据区
  for (const e of exifIfd) if (e.data.length > 4) e.data.copy(buf, e.offset);

  return buf;
}

/* ---------------- 生成 ---------------- */

const W = 960;
const H = 600;
const hues = [
  { r: 40, g: 120, b: 220 }, // 蓝
  { r: 230, g: 90, b: 90 }, // 红
  { r: 90, g: 200, b: 120 }, // 绿
];

const dir = path.join(__dirname, "..", "test-album");
fs.mkdirSync(dir, { recursive: true });

function paint(idx, hue) {
  const px = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      let r = Math.round(hue.r * (0.25 + (x / W) * 0.6));
      let g = Math.round(hue.g * (0.25 + (y / H) * 0.6));
      let b = Math.round(hue.b * (0.25 + ((x + y) / (W + H)) * 0.6));
      // 中央编号色块（大小随 idx 变，便于区分）
      if (x > 330 && x < 630 && y > 200 && y < 400) {
        r = 245;
        g = 245;
        b = 245;
        if (y % 28 < 10) {
          r = 20;
          g = 24;
          b = 30;
        } // 模拟文字行
      }
      // 底部 accent 条
      if (y > 520) {
        r = 87;
        g = 193;
        b = 255;
      }
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
    }
  }
  return px;
}

for (let idx = 0; idx < 3; idx++) {
  const out = path.join(dir, `photo_${idx + 1}.png`);
  fs.writeFileSync(out, encodePNG(W, H, paint(idx, hues[idx])));
  console.log("generated:", out);
}

// 带 EXIF 的那张（PNG 的 eXIf 段里放裸 TIFF 块）
{
  const out = path.join(dir, "photo_9_exif.png");
  const exif = buildExifTiff();
  fs.writeFileSync(out, encodePNG(W, H, paint(9, { r: 200, g: 160, b: 60 }), [chunk("eXIf", exif)]));
  console.log("generated:", out, `(含 EXIF ${exif.length} 字节)`);
}

