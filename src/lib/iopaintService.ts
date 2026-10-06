/**
 * 本地 AI 去水印（IOPaint / LaMa）—— 渲染层的接入点。
 *
 * 【为什么它是「本地 vs 云端」之外的第三条路】
 * - 内置扩散填洞（localTransforms）：毫秒级、纯本地，但复杂纹理（草地/毛发/木纹）会糊；
 * - 云端 AI 编辑（editImage）：效果最好，但图片要上传、按张计费；
 * - IOPaint：**在本机跑 LaMa 模型** —— 复杂纹理能重建出真实纹理，
 *   图片不出本机、不花钱、不需要 Key。代价：CPU 推理要几秒，且首次使用要先启动本地服务。
 *
 * 职责边界：
 * - 这里只负责「把选区变成遮罩」与「调用壳层通道」；
 * - multipart 上传、服务探活、自动拉起进程都在壳层完成 ——
 *   本地服务通常不带 CORS 头，渲染层直连会被浏览器拦截（与识别走主进程同一理由）。
 * - 遮罩判据与内置引擎**同一套**（"亮且接近无彩色"的像素才算水印）：
 *   引擎换了，"选区里哪些像素该被填"的语义不能变 —— 不然同一次框选换引擎会填出不同内容。
 */

import { loadImage, urlToDataUrl } from "./localEdits";
import { Rect, dilateMaskRect } from "./localTransforms";
import { iopaintEnsureServer, iopaintInpaint, loadSettings, writeDebugPng } from "./api";

export interface IopaintMaskOptions {
  /** 只把选区内"像水印"的像素标为重建区（与内置引擎的 autoMask 同语义） */
  autoMask: boolean;
  /** 自动掩膜的亮度阈值（0-255） */
  lumaThreshold: number;
  /** 掩膜向外扩几像素（吃掉水印边缘的抗锯齿，避免留灰边） */
  dilate: number;
}

/**
 * 构建整幅遮罩：黑 = 保留，白 = 重建（LaMa 的约定：白色区域会被重画）。
 * 与内置引擎一致：选区之外的像素**永远**是黑的 —— LaMa 只重画选区里的目标像素。
 */
export async function buildInpaintMask(
  src: string,
  rect: Rect,
  opts: IopaintMaskOptions
): Promise<string> {
  const dataUrl = await urlToDataUrl(src);
  const img = await loadImage(dataUrl);
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const x0 = Math.max(0, Math.min(W - 1, Math.floor(rect.x)));
  const y0 = Math.max(0, Math.min(H - 1, Math.floor(rect.y)));
  const w = Math.max(1, Math.min(W - x0, Math.floor(rect.w)));
  const h = Math.max(1, Math.min(H - y0, Math.floor(rect.h)));
  if (w < 2 || h < 2) throw new Error("先框选要去掉的区域（至少 2×2 像素）");

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建画布上下文");
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, W, H);
  const im = ctx.getImageData(0, 0, W, H);
  const d = im.data;

  const mask = new Uint8Array(W * H);
  if (opts.autoMask) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y + y0) * W + (x + x0);
        const o = i * 4;
        const R = d[o], G = d[o + 1], B = d[o + 2];
        const luma = 0.299 * R + 0.587 * G + 0.114 * B;
        const chroma = Math.max(R, G, B) - Math.min(R, G, B);
        if (luma >= opts.lumaThreshold && chroma < 60) mask[i] = 1;
      }
    }
    if (opts.dilate > 0) dilateMaskRect(mask, W, y0, x0, h, w, opts.dilate);
  } else {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) mask[(y + y0) * W + (x + x0)] = 1;
    }
  }

  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) {
      const o = i * 4;
      d[o] = 255;
      d[o + 1] = 255;
      d[o + 2] = 255;
      d[o + 3] = 255;
    }
  }
  ctx.putImageData(im, 0, 0);
  return canvas.toDataURL("image/png");
}

/**
 * 用本地 IOPaint（LaMa）抹除选区。
 *
 * 服务不在运行时会先用设置里的启动命令自动拉起（壳层完成，最多等 120s ——
 * 首次启动要下载约 200MB 的模型，之后 10~30 秒就能就绪）。
 */
export async function iopaintErase(
  src: string,
  rect: Rect,
  opts: IopaintMaskOptions
): Promise<string> {
  const settings = await loadSettings();
  const baseUrl = (settings.iopaint_url || "").trim() || "http://127.0.0.1:8080";
  const ensured = await iopaintEnsureServer({
    baseUrl,
    cmd: (settings.iopaint_cmd || "").trim(),
  });
  if (!ensured.ok) {
    throw new Error(
      (ensured.message || "本地 IOPaint 服务未就绪") +
        "\n→ 也可以手动双击项目里的「启动IOPaint.cmd」把服务跑起来再试。"
    );
  }
  const maskDataUrl = await buildInpaintMask(src, rect, opts);

  /**
   * 【EXIF 归一化 —— 2026-10-04 用户实测破案的最后一环】
   * 手机竖拍的照片带 EXIF orientation（多为 6/8，旋转 90°）：
   * - 浏览器 <img> 显示时自动转正 → 用户看到正的图，框选坐标也是转正后的；
   * - buildInpaintMask 用 canvas 画的 mask 同样是转正后坐标系；
   * - 但 src（asset:// 或文件 data URL）是**原始文件字节，没有转正**！
   * 把「未转正的原图 + 转正坐标的 mask」发给 LaMa → 遮罩与水印错位 90°，
   * LaMa 重画了错误区域，水印原地不动。
   * 修：发送前用 canvas 把图重绘一遍（drawImage 遵循 EXIF），image 与
   * mask 从此同一坐标系。无 EXIF 的图 round-trip 无损（仅重编码）。
   */
  const imgEl = await loadImage(await urlToDataUrl(src));
  const c = document.createElement("canvas");
  c.width = imgEl.naturalWidth;
  c.height = imgEl.naturalHeight;
  const cx = c.getContext("2d");
  if (!cx) throw new Error("无法创建画布上下文");
  cx.imageSmoothingQuality = "high";
  cx.drawImage(imgEl, 0, 0);
  const imageDataUrl = c.toDataURL("image/jpeg", 0.92);

    // 【诊断】mask / image / 坐标系数值落盘（writeDebugPng 静态通道）
  try {
    const rectJson = JSON.stringify({
      sel: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) },
      dbg: (window as any).__aiivDebug ?? null,
    });
    await writeDebugPng("mask", rectJson, maskDataUrl);
    await writeDebugPng("img", rectJson, imageDataUrl);
    await writeDebugPng("meta", rectJson, "not-a-data-url");
  } catch {
    /* 诊断失败不影响主流程 */
  }

const r = await iopaintInpaint({ baseUrl, imageDataUrl, maskDataUrl });
  if (!r.ok || !r.dataUrl) throw new Error(r.message || "IOPaint 没有返回结果");
  return r.dataUrl;
}
