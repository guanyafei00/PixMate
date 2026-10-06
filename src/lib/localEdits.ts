/**
 * 本地图像处理：加水印 / 改尺寸 / 导出文本。
 *
 * 【为什么这些不该丢给 AI】
 * 加水印、改尺寸是**确定性操作** —— 本地 canvas 几毫秒就做完，结果还能预览。
 * 走云端 AI 要 0.14 元/张、等好几秒，而且结果不可控（AI 可能把水印画歪、
 * 把字写错）。更要紧的是：这类操作如果也走云端，就等于**把没必要的图传了出去** ——
 * 而"图片不出本机"是这个软件对用户的承诺之一。
 *
 * 所以这里的原则很清楚：
 *   · 确定性的（水印、尺寸、格式转换）→ 本地做，零成本、零等待、零上传
 *   · 需要理解内容的（去水印、换文字、换背景）→ 才走 AI
 *
 * 全部在渲染层用 canvas 完成，输出 data URL ——
 * 于是能直接进入现有的「非破坏性 + 另存为」流程，不需要新开一条链路。
 */

/**
 * 把屏幕上正在显示的图片地址取成 data URL。
 *
 * 【为什么要这一步】屏幕上显示的可能是 `aiiv://`（自定义文件流协议）或 blob，
 * 而 canvas 处理需要同源且可导出的像素。主进程那边已给这些响应加了
 * `Access-Control-Allow-Origin: *`，所以配合 `crossOrigin="anonymous"`
 * 就能安全读像素、`toDataURL()` 不会因"污染画布"而抛错。
 * （若没这道 CORS，浏览器会拦下 `toDataURL` —— 这是最容易踩的坑。）
 */
export async function urlToDataUrl(url: string): Promise<string> {
  if (!url) throw new Error("没有可处理的图片");
  if (url.startsWith("data:")) return url;
  const img = await loadImage(url);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建画布上下文");
  ctx.drawImage(img, 0, 0);
  try {
    return canvas.toDataURL("image/png");
  } catch {
    throw new Error("读取图片像素被浏览器拦截（画布被污染），无法本地处理");
  }
}

/** 把 data URL 读成 Image（附带超时，避免坏图把界面卡住） */
export function loadImage(dataUrl: string, timeoutMs = 15000): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // 自定义协议/blobs 要带这个才能让 canvas 读像素（配合主进程的 CORS 头）
    img.crossOrigin = "anonymous";
    const timer = window.setTimeout(() => reject(new Error("图片解码超时")), timeoutMs);
    img.onload = () => {
      window.clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error("图片解码失败，可能格式不受支持"));
    };
    img.src = dataUrl;
  });
}

/* ------------------------------------------------------------------ */
/* 加水印                                                             */
/* ------------------------------------------------------------------ */

export type WatermarkPosition = "br" | "bl" | "tr" | "tl" | "center" | "tile";

export interface WatermarkOptions {
  text: string;
  position: WatermarkPosition;
  /** 0–100 */
  opacity: number;
  /** 字号相对图片短边的百分比（1–12），这样大图小图观感一致 */
  sizePct: number;
  color: string;
}

/**
 * 常用水印颜色。
 *
 * 为什么给快捷色块而不是只放一个取色器：
 * 取色器要精确拖动、在深色界面上还难看清取到什么色；而实际用到的颜色就那几个
 * （白/黑是绝对主力，红黄蓝绿各有场景）。所以色块点一下就行，取色器留给特殊需求。
 */
export const WATERMARK_COLORS: { label: string; value: string }[] = [
  { label: "白", value: "#ffffff" },
  { label: "黑", value: "#111111" },
  { label: "灰", value: "#9aa0a6" },
  { label: "红", value: "#ff4d4f" },
  { label: "黄", value: "#ffd43b" },
  { label: "蓝", value: "#4dabf7" },
  { label: "绿", value: "#51cf66" },
];

export const WATERMARK_DEFAULTS: WatermarkOptions = {
  text: "@你的账号",
  position: "br",
  opacity: 55,
  sizePct: 3.2,
  color: "#ffffff",
};

/** #rgb / #rrggbb → [r,g,b]；认不出来就当白（宁可阴影选择保守，也不要抛错） */
export function hexToRgb(hex: string): [number, number, number] {
  const s = String(hex || "").trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(s)) {
    return [
      parseInt(s[0] + s[0], 16),
      parseInt(s[1] + s[1], 16),
      parseInt(s[2] + s[2], 16),
    ];
  }
  if (/^[0-9a-f]{6}$/i.test(s)) {
    return [
      parseInt(s.slice(0, 2), 16),
      parseInt(s.slice(2, 4), 16),
      parseInt(s.slice(4, 6), 16),
    ];
  }
  return [255, 255, 255];
}

/**
 * 在图上叠加文字水印。
 *
 * 字号按**图片短边的百分比**算，而不是固定像素 —— 否则 4000px 的相机原图
 * 上会小到看不见，800px 的截图又会占满半个画面。
 */
export async function addTextWatermark(
  dataUrl: string,
  opts: WatermarkOptions
): Promise<string> {
  const text = opts.text.trim();
  if (!text) throw new Error("水印文字不能为空");

  const img = await loadImage(dataUrl);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建画布上下文");

  ctx.drawImage(img, 0, 0);
  const size = Math.max(10, Math.round((Math.min(w, h) * opts.sizePct) / 100));
  ctx.font = `600 ${size}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
  ctx.fillStyle = opts.color;
  ctx.globalAlpha = Math.max(0, Math.min(100, opts.opacity)) / 100;

  /**
   * 阴影颜色要跟着文字颜色走：
   * 浅色字配**深**阴影（浅色背景上也读得出来），深色字配**浅**阴影。
   * 原来一律用深阴影 —— 那样一选黑字，在深色照片上就糊成一团。
   */
  const [cr, cg, cb] = hexToRgb(opts.color);
  const light = 0.299 * cr + 0.587 * cg + 0.114 * cb > 150;
  ctx.shadowColor = light ? "rgba(0,0,0,0.45)" : "rgba(255,255,255,0.55)";
  ctx.shadowBlur = Math.max(2, size * 0.18);

  const pad = Math.round(size * 0.9);
  const metrics = ctx.measureText(text);

  const drawAt = (x: number, y: number) => ctx.fillText(text, x, y);

  if (opts.position === "tile") {
    ctx.shadowBlur = 0;
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(-Math.PI / 8); // 轻微倾斜，比水平排更难被图案工具抹掉
    ctx.translate(-w / 2, -h / 2);
    const stepX = metrics.width + size * 3;
    const stepY = size * 6;
    for (let y = -h; y < h * 2; y += stepY) {
      for (let x = -w; x < w * 2; x += stepX) drawAt(x, y);
    }
    ctx.restore();
  } else {
    const tw = metrics.width;
    let x = pad;
    let y = h - pad;
    if (opts.position === "br") {
      x = w - tw - pad;
      y = h - pad;
    } else if (opts.position === "tr") {
      x = w - tw - pad;
      y = size + pad;
    } else if (opts.position === "tl") {
      x = pad;
      y = size + pad;
    } else if (opts.position === "center") {
      x = (w - tw) / 2;
      y = h / 2 + size / 3;
    }
    drawAt(x, y);
  }
  ctx.globalAlpha = 1;
  return canvas.toDataURL("image/png");
}

/* ------------------------------------------------------------------ */
/* 改尺寸                                                             */
/* ------------------------------------------------------------------ */

export interface ResizeOptions {
  width: number;
  height?: number;
  /**
   * fit     = 等比缩放，输出就是缩放后的实际尺寸（不补白不裁切 —— 「把图改小/改大」的本义）
   * contain = 等比缩放 + 补白到目标尺寸（不裁掉内容；平台固定尺寸场景用）
   * cover   = 等比缩放 + 居中裁切（填满目标尺寸）
   * stretch = 直接拉伸（会变形，一般不推荐，但有些平台要求严格比例）
   */
  mode: "fit" | "contain" | "cover" | "stretch";
  background: string;
}

/** 常见平台的尺寸预设 —— 用户记不住"小红书 3:4 是 1242×1656" */
export const SIZE_PRESETS: { label: string; width: number; height: number; scene: string }[] = [
  { label: "小红书 竖版 3:4", width: 1242, height: 1656, scene: "creator" },
  { label: "公众号 封面 2.35:1", width: 900, height: 383, scene: "creator" },
  { label: "视频号/抖音 竖屏 9:16", width: 1080, height: 1920, scene: "creator" },
  { label: "朋友圈/微博 方图 1:1", width: 1080, height: 1080, scene: "creator" },
  { label: "淘宝/京东 主图 1:1", width: 800, height: 800, scene: "ecommerce" },
  { label: "详情页 宽图 3:2", width: 1200, height: 800, scene: "ecommerce" },
  { label: "A4 300dpi（打印/扫描件）", width: 2480, height: 3508, scene: "education" },
  { label: "A4 150dpi（快速分享）", width: 1240, height: 1754, scene: "education" },
  { label: "票据 A4 竖版（清晰）", width: 2480, height: 3508, scene: "finance" },
  { label: "小票/榜单 长图", width: 800, height: 2000, scene: "finance" },
];

export async function resizeImage(dataUrl: string, opts: ResizeOptions): Promise<string> {
  const img = await loadImage(dataUrl);
  const tw = Math.max(1, Math.round(opts.width));
  const th = Math.max(1, Math.round(opts.height ?? (img.naturalHeight * tw) / img.naturalWidth));

  // fit：等比缩放，输出 = 缩放后的实际尺寸（用户反馈：改尺寸不该加白边）
  if (opts.mode === "fit") {
    const scale = Math.min(tw / img.naturalWidth, th / img.naturalHeight);
    const dw = Math.max(1, Math.round(img.naturalWidth * scale));
    const dh = Math.max(1, Math.round(img.naturalHeight * scale));
    const c2 = document.createElement("canvas");
    c2.width = dw;
    c2.height = dh;
    const cx = c2.getContext("2d");
    if (!cx) throw new Error("无法创建画布上下文");
    cx.imageSmoothingQuality = "high";
    cx.drawImage(img, 0, 0, dw, dh);
    return c2.toDataURL("image/png");
  }

  const canvas = document.createElement("canvas");
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建画布上下文");

  // 补白底色必须显式画上：否则 PNG 补白处是透明，JPEG 会变成黑块
  ctx.fillStyle = opts.background || "#ffffff";
  ctx.fillRect(0, 0, tw, th);

  if (opts.mode === "stretch") {
    ctx.drawImage(img, 0, 0, tw, th);
  } else {
    const scale =
      opts.mode === "cover"
        ? Math.max(tw / img.naturalWidth, th / img.naturalHeight)
        : Math.min(tw / img.naturalWidth, th / img.naturalHeight);
    const dw = img.naturalWidth * scale;
    const dh = img.naturalHeight * scale;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, (tw - dw) / 2, (th - dh) / 2, dw, dh);
  }
  return canvas.toDataURL("image/png");
}

/* ------------------------------------------------------------------ */
/* 导出文本                                                           */
/* ------------------------------------------------------------------ */

export type TextFormat = "md" | "txt" | "csv";

/**
 * 把识别结果转成可下载的文本。
 *
 * 为什么要有它：教师/办公场景的真需求不是"看一眼文字"，而是**把文字拿去用**。
 * 只能复制的话，几十行的表格要一段段粘贴 —— 导出成文件才是这一步的终点。
 */
export function buildTextExport(
  text: string,
  format: TextFormat,
  baseName: string
): { blobUrl: string; filename: string; mime: string } {
  const name = (baseName || "导出").replace(/\.[^.]*$/, "");
  const stamp = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const suffix = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(
    stamp.getHours()
  )}${pad(stamp.getMinutes())}`;

  let content = text;
  if (format === "md") {
    // Markdown 里给个标题，方便直接当笔记用
    content = `# ${name}\n\n> 由 AI 看图软件导出 · ${stamp.toLocaleString("zh-CN")}\n\n${text}\n`;
  } else if (format === "csv") {
    // 模型给的多半是 Markdown 表格，转成 CSV 才能被 Excel 正确分列
    content = markdownTableToCsv(text);
  }
  const mime = format === "csv" ? "text/csv" : format === "md" ? "text/markdown" : "text/plain";
  const blob = new Blob(["\ufeff" + content], { type: `${mime};charset=utf-8` }); // BOM：Excel 打开中文不乱码
  return { blobUrl: URL.createObjectURL(blob), filename: `${name}-${suffix}.${format}`, mime };
}

/**
 * Markdown 表格 → CSV。
 * 模型输出的表格几乎都是 Markdown 语法，直接存成 .csv 的话 Excel 会把
 * `| a | b |` 整行塞进一个单元格 —— 那就不叫"能用"了。
 */
export function markdownTableToCsv(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  const esc = (c: string) => {
    const t = c.trim();
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith("|")) {
      out.push(esc(t));
      continue;
    }
    // 分隔行 |---|---| 丢掉
    if (/^\|[\s:|-]+\|$/.test(t)) continue;
    const cells = t.replace(/^\||\|$/g, "").split("|");
    out.push(cells.map(esc).join(","));
  }
  return out.join("\n");
}
