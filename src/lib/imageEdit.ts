/**
 * 编辑前的图像预处理（浏览器/渲染进程侧，用 canvas）。
 *
 * 【为什么必须做】
 * 万相通用图像编辑对输入有硬性限制（摘自阿里云百炼 API 参考）：
 *   - 分辨率宽高都必须落在 [512, 4096] 像素
 *   - 单张不超过 10MB
 *   - **mask 图必须与 base 图分辨率完全一致**
 * 用户随手一张手机照片是 4032×3024（可用），但 8000×6000 的全画幅就会超限，
 * 一张 300×200 的小图又会低于下限。所以送出去之前必须统一归一化。
 *
 * 【为什么在渲染进程做】
 * 主进程没有 canvas。虽然理论上可以用纯 JS 写 PNG 编码器 + 解码器，
 * 但那等于自己实现一遍图像库。渲染进程有现成的 canvas，几行就够。
 *
 * 【关于「透明底会变黑」】
 * canvas 里画带透明通道的 PNG，透明区域默认为全透明；导出 JPEG 时透明会变成黑色。
 * 所以这里先铺一层白底再画图 —— 对图像编辑来说白底比黑底合理得多。
 */
import { MaskMode } from "./editProviders";

/** API 要求的分辨率上下限 */
const MIN_DIM = 512;
const MAX_DIM = 4096;

/** 选区（以**原图像素**为单位） */
export interface SelectionRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface EditPrep {
  /** 归一化后的原图（JPEG data URL） */
  baseDataUrl: string;
  /** 与 base 同分辨率的遮罩；null 表示整图编辑（不带 mask） */
  maskDataUrl: string | null;
  width: number;
  height: number;
}

export class EditPrepError extends Error {}

/** 从 data URL 得到一个已加载完成的 Image（自定义协议下需 crossOrigin 才不会污染画布） */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // 关键：不声明 crossOrigin，getImageData/toDataURL 可能因画布被污染而抛 SecurityError。
    // 主进程的 aiiv:// 协议已声明 corsEnabled 并回 Access-Control-Allow-Origin，故可匿名取用。
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () =>
      reject(new EditPrepError("读取图片失败（文件可能已损坏或格式不支持）"));
    img.src = url;
  });
}

/** 计算归一化后的目标尺寸，保证两边都落进 [512, 4096] */
function targetSize(w: number, h: number): { w: number; h: number } {
  if (!w || !h) throw new EditPrepError("图片尺寸异常，无法处理");

  const longSide = Math.max(w, h);
  const shortSide = Math.min(w, h);

  // 先把超限的长边压到 4096；再保证短边不低于 512（极端长条图会冲突）
  let scale = Math.min(1, MAX_DIM / longSide);
  if (shortSide * scale < MIN_DIM) scale = MIN_DIM / shortSide;

  const tw = Math.round(w * scale);
  const th = Math.round(h * scale);

  if (Math.max(tw, th) > MAX_DIM) {
    // 长宽比超过 8:1 的极端情况，无法同时满足上下限 —— 明确报错，不要偷偷降级
    throw new EditPrepError(
      `这张图的长宽比过于极端（${w}×${h}），无法同时满足服务商要求的 ` +
        `${MIN_DIM}–${MAX_DIM} 像素范围。建议先裁剪后再编辑。`
    );
  }
  return { w: tw, h: th };
}

/**
 * 生成 base 图与遮罩。
 * @param imageUrl  显示用的图片地址（Electron 下是 aiiv:// 协议）
 * @param sel       选区（原图像素坐标）；null 表示不带遮罩
 * @param maskMode  遮罩语义；null 表示该 provider 不接受遮罩
 */
export async function prepareEditImages(
  imageUrl: string,
  sel: SelectionRect | null,
  maskMode: MaskMode | null
): Promise<EditPrep> {
  const img = await loadImage(imageUrl);
  const sw = img.naturalWidth;
  const sh = img.naturalHeight;
  const { w: tw, h: th } = targetSize(sw, sh);

  // ---- base ----
  const baseCanvas = document.createElement("canvas");
  baseCanvas.width = tw;
  baseCanvas.height = th;
  const bctx = baseCanvas.getContext("2d");
  if (!bctx) throw new EditPrepError("当前环境不支持 canvas，无法处理图片");
  bctx.fillStyle = "#ffffff"; // 透明底铺白，避免导出 JPEG 后变黑
  bctx.fillRect(0, 0, tw, th);
  bctx.drawImage(img, 0, 0, tw, th);

  // 画布可能因跨源被污染（toDataURL 会抛 SecurityError）—— 明确告知而不是静默失败
  let baseDataUrl: string;
  try {
    baseDataUrl = baseCanvas.toDataURL("image/jpeg", 0.92);
  } catch (e) {
    throw new EditPrepError(
      "无法导出图片数据（画布被跨源限制）：" + ((e as Error)?.message ?? e)
    );
  }

  // ---- mask ----
  let maskDataUrl: string | null = null;
  if (sel && maskMode) {
    // 选区从「原图坐标」换算到「归一化后的坐标」
    const kx = tw / sw;
    const ky = th / sh;
    const x = Math.max(0, Math.min(tw - 1, Math.round(sel.x * kx)));
    const y = Math.max(0, Math.min(th - 1, Math.round(sel.y * ky)));
    const w = Math.max(1, Math.min(tw - x, Math.round(sel.w * kx)));
    const h = Math.max(1, Math.min(th - y, Math.round(sel.h * ky)));

    const mCanvas = document.createElement("canvas");
    mCanvas.width = tw;
    mCanvas.height = th;
    const mctx = mCanvas.getContext("2d");
    if (!mctx) throw new EditPrepError("当前环境不支持 canvas，无法生成遮罩");

    if (maskMode === "ds-white") {
      // 万相：纯黑底 = 保留，纯白块 = 待编辑（必须是纯黑/纯白，否则识别不到）
      mctx.fillStyle = "#000000";
      mctx.fillRect(0, 0, tw, th);
      mctx.fillStyle = "#ffffff";
      mctx.fillRect(x, y, w, h);
    } else {
      // OpenAI：不透明 = 保留，**透明块 = 待编辑**（语义正好相反）
      mctx.fillStyle = "#000000";
      mctx.fillRect(0, 0, tw, th);
      mctx.clearRect(x, y, w, h);
    }

    try {
      maskDataUrl = mCanvas.toDataURL("image/png");
    } catch (e) {
      throw new EditPrepError(
        "无法生成遮罩数据：" + ((e as Error)?.message ?? e)
      );
    }
  }

  return { baseDataUrl, maskDataUrl, width: tw, height: th };
}
