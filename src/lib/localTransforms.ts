/**
 * 本地图像变换：裁剪 / 旋转 / 翻转 / 拉直 / 亮度对比度 / **本地去水印**。
 *
 * 【为什么这些不该走 AI】
 * 它们是**确定性运算**：同样的输入永远得到同样的输出，几毫秒到几十毫秒完成，
 * 不上传、不花钱。而 AI 不仅更慢更贵，还有一类特有的风险 ——
 * 它会"顺手"改掉别处（重画光影、把数字看成 8）。对"我只想修这一块"的需求，
 * 确定性的本地运算才是对的工具。
 *
 * 【本地去水印的诚实边界】（这条决定了界面上该怎么写）
 * 这里用的是经典的**扩散填洞**（harmonic / Jacobi 迭代平均）：
 * 未知像素反复用已知邻居的平均值更新，直到收敛。
 *   ✅ 平坦/渐变背景（天空、纯色墙、渐变底）效果很好
 *   ❌ 复杂纹理（草地、毛发、木纹）会"糊"——这是算法本身的限制，不是 bug
 *      （文献里 Telea/NS 这两种经典算法的边界也是这样：
 *         "Works poorly on watermarks over faces or high-detail textures"）
 * 所以界面必须明说，并在效果不够时引导用户改用 AI 那条路。
 */

import {
  loadImage,
  urlToDataUrl,
  addTextWatermark,
  resizeImage,
  WatermarkOptions,
  ResizeOptions,
} from "./localEdits";
import { pathToDisplayUrl, writeProcessed } from "./api";

/** 批量支持的操作：两个都是「确定性、纯本地」的 —— AI 操作不做批量（按张计费，误点会烧钱） */
export type BatchOp = "watermark" | "resize";

export interface BatchHooks {
  /** 每完成一张回调一次（进度显示用） */
  onProgress?: (done: number, total: number, current: string) => void;
}

export interface BatchResult {
  total: number;
  ok: number;
  skipped: number;
  failed: number;
  errors: { name: string; message: string }[];
  outDir: string;
}

/**
 * 对一个文件夹里的全部图片执行同一个本地操作，产物写进 **aiiv-processed/** 子目录。
 *
 * 三条设计决定：
 * 1. **绝不写原图**：产物全部进子目录、保持原文件名 —— 比对与回滚都容易；
 * 2. **顺序处理**：canvas 操作很快（几十毫秒/张），串行足够，还避免并发内存峰值；
 * 3. **AI 操作不做批量**：按张计费，误点一次就是一整个文件夹的钱 ——
 *    「本地 vs AI」的分界在产品上就体现为：批量只开放确定性的两项（水印/尺寸）。
 *
 * 失败策略：单张失败不中断整批（一张坏图不该毁掉整次批量），错误最后汇总。
 */
export async function runBatch(
  items: { name: string; path: string }[],
  outDir: string,
  op: BatchOp,
  options: { watermark?: WatermarkOptions; resize?: ResizeOptions },
  hooks: BatchHooks = {}
): Promise<BatchResult> {
  const res: BatchResult = {
    total: items.length,
    ok: 0,
    skipped: 0,
    failed: 0,
    errors: [],
    outDir,
  };
  const sep = outDir.includes("\\") ? "\\" : "/";
  let done = 0;
  for (const it of items) {
    hooks.onProgress?.(done, items.length, it.name);
    try {
      const dataUrl = await urlToDataUrl(pathToDisplayUrl(it.path));
      const out =
        op === "watermark"
          ? await addTextWatermark(dataUrl, options.watermark!)
          : await resizeImage(dataUrl, options.resize!);
      // 保持原文件名（产物在独立子目录，不会与原图混淆）
      const target = outDir + sep + it.name;
      const w = await writeProcessed(target, out);
      if (w.saved) res.ok++;
      else {
        res.skipped++;
        res.errors.push({ name: it.name, message: w.message || "跳过" });
      }
    } catch (e) {
      res.failed++;
      res.errors.push({
        name: it.name,
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      done++;
      hooks.onProgress?.(done, items.length, it.name);
    }
  }
  return res;
}

/** 选区（图像像素坐标，与 prepareEditImages 的口径一致） */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Ctx = CanvasRenderingContext2D;

async function toCanvas(src: string): Promise<{ canvas: HTMLCanvasElement; ctx: Ctx; img: HTMLImageElement }> {
  const dataUrl = await urlToDataUrl(src);
  const img = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建画布上下文");
  ctx.drawImage(img, 0, 0);
  return { canvas, ctx, img };
}

/* ------------------------------------------------------------------ */
/* 裁剪 / 旋转 / 翻转 / 拉直                                            */
/* ------------------------------------------------------------------ */

/** 按选区裁剪（选区是图像像素坐标；越界会被夹到图内） */
export async function cropToRect(src: string, rect: Rect): Promise<string> {
  const { img } = await toCanvas(src);
  const x = Math.max(0, Math.floor(rect.x));
  const y = Math.max(0, Math.floor(rect.y));
  const w = Math.min(img.naturalWidth - x, Math.floor(rect.w));
  const h = Math.min(img.naturalHeight - y, Math.floor(rect.h));
  if (w < 1 || h < 1) throw new Error("选区太小，无法裁剪");

  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("无法创建画布上下文");
  ctx.drawImage(img, x, y, w, h, 0, 0, w, h);
  return out.toDataURL("image/png");
}

/** 正交旋转（90/180/270）—— 无重采样，画质零损失 */
export async function rotateOrtho(src: string, deg: 90 | 180 | 270): Promise<string> {
  const { img } = await toCanvas(src);
  const swap = deg === 90 || deg === 270;
  const out = document.createElement("canvas");
  out.width = swap ? img.naturalHeight : img.naturalWidth;
  out.height = swap ? img.naturalWidth : img.naturalHeight;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("无法创建画布上下文");
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
  return out.toDataURL("image/png");
}

export async function flipImage(src: string, axis: "h" | "v"): Promise<string> {
  const { img } = await toCanvas(src);
  const out = document.createElement("canvas");
  out.width = img.naturalWidth;
  out.height = img.naturalHeight;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("无法创建画布上下文");
  ctx.translate(axis === "h" ? out.width : 0, axis === "v" ? out.height : 0);
  ctx.scale(axis === "h" ? -1 : 1, axis === "v" ? -1 : 1);
  ctx.drawImage(img, 0, 0);
  return out.toDataURL("image/png");
}

/**
 * 旋转任意角度后，裁掉四角露出的空白（= 拉直）。
 *
 * 关键是最内接矩形怎么算 —— 不能用「按角度余弦估算」，那样要么裁掉内容、
 * 要么留下黑角。这里用的是标准的最大内接矩形解（分长短边讨论），
 * 保证结果里**一点空白都没有**。
 */
export async function straighten(src: string, angleDeg: number): Promise<string> {
  const { img } = await toCanvas(src);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const a = (angleDeg * Math.PI) / 180;
  const { width: cw, height: ch } = maxInscribedRect(w, h, a);
  if (cw < 1 || ch < 1) throw new Error("这个角度下没有可裁出的有效区域");

  const out = document.createElement("canvas");
  out.width = Math.floor(cw);
  out.height = Math.floor(ch);
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("无法创建画布上下文");
  ctx.imageSmoothingQuality = "high";
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate(a);
  ctx.drawImage(img, -w / 2, -h / 2);
  return out.toDataURL("image/png");
}

/** 旋转 angle 后，原图内能放下的最大轴对齐矩形（标准解） */
export function maxInscribedRect(
  w: number,
  h: number,
  angle: number
): { width: number; height: number } {
  const sinA = Math.abs(Math.sin(angle));
  const cosA = Math.abs(Math.cos(angle));
  const longer = Math.max(w, h);
  const shorter = Math.min(w, h);
  const wIsLonger = w >= h;

  // 窄长边 + 明显倾角：退化为"贴着短边的正方形"
  if (shorter <= 2 * sinA * cosA * longer || Math.abs(sinA - cosA) < 1e-10) {
    const x = 0.5 * shorter;
    return wIsLonger
      ? { width: x / sinA, height: x / cosA }
      : { width: x / cosA, height: x / sinA };
  }
  const cos2A = cosA * cosA - sinA * sinA;
  return {
    width: (w * cosA - h * sinA) / cos2A,
    height: (h * cosA - w * sinA) / cos2A,
  };
}

/* ------------------------------------------------------------------ */
/* 亮度 / 对比度 / 饱和度                                              */
/* ------------------------------------------------------------------ */

export interface AdjustOptions {
  /** -100 ~ 100 */
  brightness: number;
  /** -100 ~ 100 */
  contrast: number;
  /** -100 ~ 100，-100 = 灰度 */
  saturation: number;
}

/**
 * 三档调整。
 *
 * 亮度与对比度合成一张 **LUT**（256 项查表）—— 逐像素查表比拼数学快得多，
 * 这是传统图像软件的标准做法。
 * 饱和度没法做成单通道 LUT（它要跟亮度做混合），所以单独一趟数学。
 */
export async function adjustImage(src: string, opts: AdjustOptions): Promise<string> {
  const { canvas, ctx } = await toCanvas(src);
  const im = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = im.data;

  // 亮度 + 对比度 → LUT
  const lut = new Uint8ClampedArray(256);
  const b = (opts.brightness / 100) * 255;
  const c = opts.contrast;
  const cf = (259 * (c + 255)) / (255 * (259 - c));
  for (let i = 0; i < 256; i++) {
    lut[i] = cf * (i + b - 128) + 128;
  }

  const sat = 1 + opts.saturation / 100;
  for (let i = 0; i < d.length; i += 4) {
    const r = lut[d[i]];
    const g = lut[d[i + 1]];
    const bl = lut[d[i + 2]];
    if (sat !== 1) {
      // Rec.601 亮度权重：跟人眼感知一致，也是各家软件的老口径
      const lum = 0.299 * r + 0.587 * g + 0.114 * bl;
      d[i] = lum + (r - lum) * sat;
      d[i + 1] = lum + (g - lum) * sat;
      d[i + 2] = lum + (bl - lum) * sat;
    } else {
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = bl;
    }
  }
  ctx.putImageData(im, 0, 0);
  return canvas.toDataURL("image/png");
}

/* ------------------------------------------------------------------ */
/* 本地去水印（扩散填洞）                                               */
/* ------------------------------------------------------------------ */

export interface InpaintOptions {
  /** 要处理的区域（图像像素坐标）—— 由框选给出 */
  rect: Rect;
  /**
   * 自动只在选区内挑出"像水印的像素"来填（默认开）。
   * 关掉就是整块填掉 —— 那会连选区里的真实内容一起糊掉，只在万不得已时用。
   */
  autoMask: boolean;
  /** 自动掩膜的亮度阈值（0-255）：比它亮且几乎无彩色的像素视为水印 */
  lumaThreshold: number;
  /** 向外扩几像素（把水印边缘的抗锯齿也吃掉，避免留一圈灰边） */
  dilate: number;
}

export const INPAINT_DEFAULTS: InpaintOptions = {
  rect: { x: 0, y: 0, w: 0, h: 0 },
  // 默认整块重建（2026-10-04）：半透明水印横跨深浅背景时，「亮且无彩色」
  // 判据在浅色区选不中水印像素，只剩零星点被重画，观感等于没效果；
  // 整块交给 LaMa 用周围纹理填充，对半透明水印可靠得多。
  autoMask: false,
  lumaThreshold: 200,
  dilate: 2,
};

/**
 * 扩散填洞（harmonic inpainting）。
 *
 * 做法：把待填像素标为未知，然后反复用"已知邻居的平均值"更新它们，
 * 迭代到基本不再变化。这就是经典的 PDE 插值法，效果与 Navier-Stokes 同族，
 * 只是实现更简单（不需要解方程，纯迭代）。
 *
 * 迭代次数按区域大小自适应 —— 太少了填不满（中间还是灰的），太多了浪费时间。
 */
export async function inpaintRegion(src: string, opts: InpaintOptions): Promise<string> {
  const { canvas, ctx } = await toCanvas(src);
  const W = canvas.width;
  const H = canvas.height;
  const r = clampRect(opts.rect, W, H);
  if (r.w < 2 || r.h < 2) throw new Error("先框选要去掉的区域（至少 2×2 像素）");

  /**
   * 处理窗口向外扩一圈（PAD 像素），把**周围真实像素**拉进来当参照。
   *
   * 【这是必需的，不是优化】原实现只取选区的像素做扩散 ——
   * 于是"整块填"时区域里全是被填像素、**没有任何已知像素**，算法无从下手（实测直接抛错）。
   * 扩一圈之后：整块填也有真实邻居可用；自动识别水印那条路径的上下文也更多、过渡更自然。
   * 写回时只写回选区内的像素，扩出来的那一圈不会被改动。
   */
  const PAD = 12;
  const win = clampRect(
    { x: r.x - PAD, y: r.y - PAD, w: r.w + PAD * 2, h: r.h + PAD * 2 },
    W,
    H
  );
  const im = ctx.getImageData(win.x, win.y, win.w, win.h);
  const d = im.data;
  const n = win.w * win.h;
  // 选区在窗口内的相对位置（只有这部分允许被改写）
  const rx = r.x - win.x;
  const ry = r.y - win.y;

  // 1) 建掩膜：true = 待填。窗口内的"选区之外"一律视为已知，用来提供上下文
  const unknown = new Uint8Array(n);
  if (opts.autoMask) {
    for (let y = 0; y < r.h; y++) {
      for (let x = 0; x < r.w; x++) {
        const i = (y + ry) * win.w + (x + rx);
        const o = i * 4;
        const R = d[o], G = d[o + 1], B = d[o + 2];
        const luma = 0.299 * R + 0.587 * G + 0.114 * B;
        const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
        const chroma = mx - mn; // 近似饱和度：水印多为无彩色
        if (luma >= opts.lumaThreshold && chroma < 60) unknown[i] = 1;
      }
    }
    if (opts.dilate > 0) dilateMaskRect(unknown, win.w, ry, rx, r.h, r.w, opts.dilate);
  } else {
    // 整块填：**只填选区**，窗口里扩出来的那一圈保持已知
    for (let y = 0; y < r.h; y++) {
      for (let x = 0; x < r.w; x++) unknown[(y + ry) * win.w + (x + rx)] = 1;
    }
  }

  const known = unknown.reduce((acc, u) => acc + (u ? 0 : 1), 0);
  if (known === 0) {
    // 整块都被判成水印 → 没有可参考的邻居，只能退化成"整块填"并提示
    throw new Error(
      "选区里所有像素都被判成了水印，附近没有可参考的内容。请把选区框大一点（包含水印周围的背景）"
    );
  }

  /**
   * 3) 迭代填洞。
   * 交替使用两种更新方式（红黑/棋盘式两趟），这样同一趟内互不依赖，收敛更快、
   * 也不会出现"从一角斜着扩散"的条纹。
   */
  const iters = Math.max(60, Math.min(400, Math.round(Math.max(r.w, r.h) * 1.2)));
  const buf = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    buf[i * 3] = d[i * 4];
    buf[i * 3 + 1] = d[i * 4 + 1];
    buf[i * 3 + 2] = d[i * 4 + 2];
  }
  for (let it = 0; it < iters; it++) {
    const parity = it & 1;
    for (let y = 0; y < win.h; y++) {
      for (let x = 0; x < win.w; x++) {
        const idx = y * win.w + x;
        if (!unknown[idx]) continue;
        if (((x + y) & 1) !== parity) continue;
        let sr = 0, sg = 0, sb = 0, cnt = 0;
        // 4 邻域：迭代平均最稳，8 邻域容易在斜边产生锯齿
        if (x > 0) { const k = (idx - 1) * 3; sr += buf[k]; sg += buf[k + 1]; sb += buf[k + 2]; cnt++; }
        if (x < win.w - 1) { const k = (idx + 1) * 3; sr += buf[k]; sg += buf[k + 1]; sb += buf[k + 2]; cnt++; }
        if (y > 0) { const k = (idx - win.w) * 3; sr += buf[k]; sg += buf[k + 1]; sb += buf[k + 2]; cnt++; }
        if (y < win.h - 1) { const k = (idx + win.w) * 3; sr += buf[k]; sg += buf[k + 1]; sb += buf[k + 2]; cnt++; }
        if (cnt) {
          const o = idx * 3;
          buf[o] = sr / cnt;
          buf[o + 1] = sg / cnt;
          buf[o + 2] = sb / cnt;
        }
      }
    }
  }

  // 4) 写回（只改被判为待填的像素，保住选区里的真实内容）
  for (let i = 0; i < n; i++) {
    if (!unknown[i]) continue;
    const o = i * 4;
    d[o] = buf[i * 3];
    d[o + 1] = buf[i * 3 + 1];
    d[o + 2] = buf[i * 3 + 2];
    d[o + 3] = 255;
  }
  ctx.putImageData(im, win.x, win.y);
  return canvas.toDataURL("image/png");
}

function clampRect(rect: Rect, W: number, H: number): Rect {
  const x = Math.max(0, Math.min(W - 1, Math.floor(rect.x)));
  const y = Math.max(0, Math.min(H - 1, Math.floor(rect.y)));
  const w = Math.max(1, Math.min(W - x, Math.floor(rect.w)));
  const h = Math.max(1, Math.min(H - y, Math.floor(rect.h)));
  return { x, y, w, h };
}

/**
 * 方形结构元素的膨胀，**只在给定矩形内生效**（矩形外的像素是上下文，不能被吃掉）。
 * 迭代式实现：半径很小（≤5），够用且好懂。
 * 导出供 iopaintService 复用 —— 两套引擎的"哪些像素算水印"判据必须一致。
 */
export function dilateMaskRect(
  mask: Uint8Array,
  stride: number,
  oy: number,
  ox: number,
  h: number,
  w: number,
  radius: number
): void {
  for (let i = 0; i < radius; i++) {
    const copy = mask.slice();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y + oy) * stride + (x + ox);
        if (copy[idx]) continue;
        if (
          (x > 0 && copy[idx - 1]) ||
          (x < w - 1 && copy[idx + 1]) ||
          (y > 0 && copy[idx - stride]) ||
          (y < h - 1 && copy[idx + stride])
        ) {
          mask[idx] = 1;
        }
      }
    }
  }
}
