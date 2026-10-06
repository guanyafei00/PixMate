import { useEffect, useMemo, useState } from "react";
import { Scene, LocalToolId } from "../lib/workflows";
import {
  addTextWatermark,
  resizeImage,
  urlToDataUrl,
  buildTextExport,
  WATERMARK_DEFAULTS,
  WATERMARK_COLORS,
  SIZE_PRESETS,
  WatermarkOptions,
  WatermarkPosition,
  TextFormat,
} from "../lib/localEdits";
import {
  cropToRect,
  rotateOrtho,
  flipImage,
  straighten,
  adjustImage,
  inpaintRegion,
  INPAINT_DEFAULTS,
  AdjustOptions,
  InpaintOptions,
  Rect,
  runBatch,
  BatchOp,
  BatchResult,
} from "../lib/localTransforms";
import { iopaintErase } from "../lib/iopaintService";
import { writeProcessed, loadSettings, iopaintProbe, iopaintEnsureServer } from "../lib/api";

/** 多平台出图预设（P04 自媒体物料视角）：id 对应输出文件名后缀 */
const PLATFORM_PRESETS = [
  { id: "xhs", name: "小红书", w: 1242, h: 1656 },
  { id: "gzh", name: "公众号首图", w: 900, h: 383 },
  { id: "douyin", name: "抖音封面", w: 720, h: 1280 },
  { id: "x", name: "X / Twitter", w: 1600, h: 900 },
  { id: "wx16", name: "通用横图 16:9", w: 1280, h: 720 },
];

/**
 * 本地工具面板（水印 / 尺寸 / 导出文字）。
 *
 * 【为什么收在一个入口后面】
 * 六份调研反复警告"功能堆叠会让界面变脏"，而这个软件的主张是"干净、秒开"。
 * 所以本地工具只占**一个**入口（缩放条上的「工具」），面板内部再分页；
 * 并且**按当前场景排序** —— 电商卖家第一眼看到"加水印"，教师第一眼看到"导出文字"。
 *
 * 【为什么这些不走 AI】
 * 全是确定性操作，本地 canvas 几毫秒完成。走云端要钱、要等、还得把图传出去 ——
 * 而"图片不出本机"是这个软件对用户的承诺之一。面板底部明说了这一点。
 */
export default function LocalToolsPanel({
  scene,
  /** 外部指定的初始页签（快捷坞点进来时用），变化时跟随切换 */
  initialTab,
  /** 当前**屏幕上正在显示**的那张图（可能是原图，也可能是 AI 改过的结果） */
  sourceUrl,
  /** 当前选区（图像像素坐标）—— 本地去水印与「裁剪到选区」都靠它 */
  selection,
  /** 当前文件夹的源目录（批量产物输出到它旁边的 aiiv-processed） */
  sourceDir,
  /** 当前文件夹的全部图片（批量对象） */
  folderItems,
  /** 当前图上可用于导出的文字（识别/OCR 结果） */
  exportText,
  imageName,
  busy,
  onProduce,
  onExport,
  onClose,
}: {
  scene: Scene;
  initialTab?: LocalToolId;
  sourceUrl: string;
  selection: Rect | null;
  sourceDir: string | null;
  folderItems: { name: string; path: string }[];
  exportText: string;
  imageName?: string;
  busy: boolean;
  /** 生成一张本地处理后的图，走现有的「非破坏性 + 另存为」流程 */
  onProduce: (dataUrl: string, label: string) => void;
  /** 导出文本（Electron 走保存对话框，浏览器走下载） */
  onExport: (content: string, filename: string) => void;
  onClose: () => void;
}) {
  const ALL_TOOLS: LocalToolId[] = [
    "batch",
    "geometry",
    "inpaint",
    "watermark",
    "resize",
    "adjust",
    "exportText",
    "platform",
  ];
  // 按场景排序：场景最刚需的排前面（面板小，第一眼很重要）。
  // 未列入场景清单的（如 platform 物料页签）统一排最后。
  const tools = useMemo(() => {
    const order = scene.localTools;
    const rank = (t: LocalToolId) => {
      const i = order.indexOf(t);
      return i < 0 ? 999 : i;
    };
    return [...ALL_TOOLS].sort((a, b) => rank(a) - rank(b));
  }, [scene]);

  const [tab, setTab] = useState<LocalToolId>(initialTab ?? tools[0]);
  // 快捷坞/外部入口指定页签：initialTab 变化时跟随（含从 undefined → 具体页签）
  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);
  const [err, setErr] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [wm, setWm] = useState<WatermarkOptions>(WATERMARK_DEFAULTS);
  const [size, setSize] = useState<{ w: number; h: number; mode: "fit" | "contain" | "cover" | "stretch" }>(
    { w: 1242, h: 1656, mode: "fit" }
  );
  const [fmt, setFmt] = useState<TextFormat>("md");
  const [ip, setIp] = useState<Omit<InpaintOptions, "rect">>({
    autoMask: INPAINT_DEFAULTS.autoMask,
    lumaThreshold: INPAINT_DEFAULTS.lumaThreshold,
    dilate: INPAINT_DEFAULTS.dilate,
  });
  /**
   * 去水印的填充引擎。
   *
   * 【为什么默认改成 IOPaint】实测（2026-10-03）软件内这条链路完全通：
   * 自动拉起 12 秒 → 探活返回 model='lama' → 去水印 0.9 秒返回 PNG，
   * 复杂纹理能重建出真实细节（不只是糊）。
   * 内置扩散填洞虽然毫秒级，但**只适合平坦背景**，草地/毛发/木纹会糊。
   * 用户去水印多半处理的是带纹理的图，默认给弱引擎等于让人先去踩坑再回来换。
   *
   * 【仍然保留内置引擎】平坦背景（天空、纯色墙、渐变底）用内置的更快，
   * 不想等模型启动时也能选它 —— 所以下拉保留，只是默认换。
   */
  const [engine, setEngine] = useState<"builtin" | "iopaint">("iopaint");
  /** IOPaint 服务状态：null=没查过，true=在跑，false=没在跑 */
  const [ipAlive, setIpAlive] = useState<boolean | null>(null);
  const [angle, setAngle] = useState(2);
  const [adj, setAdj] = useState<AdjustOptions>({ brightness: 0, contrast: 0, saturation: 0 });
  /** 批量：用哪个操作 + 进度/结果 */
  const [batchOp, setBatchOp] = useState<BatchOp>("watermark");
  const [batchProg, setBatchProg] = useState<{ done: number; total: number; current: string } | null>(null);
  const [batchResult, setBatchResult] = useState<BatchResult | null>(null);

  /**
   * 进「去水印」页签时**只探活**（秒级），不做任何拉起。
   *
   * 【⚠️ 这里踩过一个大坑，别改回去】
   * 第一版是「选 IOPaint 引擎就自动预热」——
   * `iopaintEnsureServer` 最长要等 120 秒（60 次 × 2 秒轮询）。
   * 用户只要在页签之间来回切，就会**叠加多个 120 秒的等待**。
   * 而这些等待都卡在壳层的 `IOPAINT_CHILD` 互斥锁上 ——
   * **整个 IPC 队列被堵死**，表现就是：界面卡死、所有工具点了没反应、
   * 「另存为」也没反应（用户实测报的就是这个）。
   *
   * 所以现在**只探活**（`iopaintProbe` 是秒级的 HTTP 查询，不占锁），
   * 拉起交给用户点「AI 去掉」时再做 —— 那时用户本来就愿意等。
   * 状态指示仍然保留，让用户知道点下去会发生什么。
   */
  useEffect(() => {
    if (tab !== "inpaint") return;
    if (engine !== "iopaint") {
      setIpAlive(null);
      return;
    }
    let live = true;
    (async () => {
      try {
        const settings = await loadSettings();
        const baseUrl =
          (settings.iopaint_url || "").trim() || "http://127.0.0.1:8080";
        // 只探活：秒级返回，不占壳层的进程锁，不会有卡死风险
        const p = await iopaintProbe(baseUrl, settings.iopaint_cmd || "");
        if (live) setIpAlive(Boolean(p.ok));
      } catch {
        if (live) setIpAlive(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [tab, engine]);
  /** 多平台出图（P04 自媒体物料）：勾选平台 → 一键产出全套尺寸套件 */
  const [pfSel, setPfSel] = useState<Record<string, boolean>>({});
  const [pfWm, setPfWm] = useState(true);
  const [pfBusy, setPfBusy] = useState(false);
  const [pfLog, setPfLog] = useState<string[]>([]);

  const presets = useMemo(
    () => SIZE_PRESETS.filter((p) => p.scene === scene.id || scene.id === "general"),
    [scene.id]
  );
  const hasText = Boolean(exportText && exportText.trim());

  /** 本地处理要读屏幕上那张图的像素；先转 data URL（显示用的是 aiiv:// 协议地址） */
  const runLocal = async (fn: (dataUrl: string) => Promise<string>, label: string) => {
    setErr(null);
    setWorking(true);
    try {
      const dataUrl = await urlToDataUrl(sourceUrl);
      onProduce(await fn(dataUrl), label);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  };

  /**
   * 跑批量。失败策略：单张失败不中断，错误最后汇总 —— 一张坏图不该毁掉整批。
   * 进度直接显示在按钮上，用户能看到它在动。
   */
  const runBatchNow = async (op: BatchOp) => {
    if (!sourceDir || !folderItems.length) return;
    setErr(null);
    setBatchResult(null);
    setWorking(true);
    try {
      const outDir = sourceDir + (sourceDir.includes("\\") ? "\\aiiv-processed" : "/aiiv-processed");
      const r = await runBatch(
        folderItems,
        outDir,
        op,
        {
          watermark: wm,
          resize: { width: size.w, height: size.h, mode: size.mode, background: "#ffffff" },
        },
        { onProgress: (done, total, current) => setBatchProg({ done, total, current }) }
      );
      setBatchResult(r);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
      setBatchProg(null);
    }
  };

  const tabLabel: Record<LocalToolId, string> = {
    batch: "批量",
    geometry: "裁剪旋转",
    inpaint: "去水印",
    watermark: "加水印",
    resize: "改尺寸",
    adjust: "亮度对比",
    exportText: "导出文字",
    platform: "多平台出图",
  };

  /** 多平台出图导出逻辑：勾选的平台逐个 resize（+可选水印）→ aiiv-processed 落盘 */
  const runPlatformExport = async () => {
    if (!sourceDir) {
      setErr("需要先从磁盘打开文件夹（浏览器预览不支持落盘）");
      return;
    }
    const picked = PLATFORM_PRESETS.filter((p) => pfSel[p.id]);
    if (!picked.length) {
      setErr("先勾选至少一个平台");
      return;
    }
    setErr(null);
    setPfBusy(true);
    setPfLog([]);
    try {
      const dataUrl = await urlToDataUrl(sourceUrl);
      const base = (imageName || "image").replace(/\.[^.]+$/, "");
      const outDir =
        sourceDir + (sourceDir.includes("\\") ? "\\aiiv-processed" : "/aiiv-processed");
      for (const p of picked) {
        try {
          let out = await resizeImage(dataUrl, { width: p.w, height: p.h, mode: "cover", background: "#ffffff" });
          if (pfWm) out = await addTextWatermark(out, wm);
          const fname = `${base}_${p.id}_${p.w}x${p.h}.png`;
          const r = await writeProcessed(
            outDir + (outDir.includes("\\") ? "\\" : "/") + fname,
            out
          );
          setPfLog((l) => [
            ...l,
            `${p.name}: ${r.saved ? "✅ 已保存" : "⚠️ " + (r.message || "未保存")}`,
          ]);
        } catch (e) {
          setPfLog((l) => [...l, `${p.name}: ❌ ${String(e).slice(0, 60)}`]);
        }
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPfBusy(false);
    }
  };

  return (
    <div className="local-tools">
      <div className="lt-head">
        <span className="lt-tabs">
          {tools.map((t) => (
            <button
              key={t}
              className={"lt-tab" + (t === tab ? " active" : "")}
              onClick={() => {
                setTab(t);
                setErr(null);
              }}
            >
              {tabLabel[t]}
            </button>
          ))}
        </span>
        <span className="lt-scene-tag">{scene.name}</span>
        <button className="lt-close" onClick={onClose} title="收起">
          ✕
        </button>
      </div>

      <div className="lt-body">
        {/* ---------------- 多平台出图（自媒体物料） ---------------- */}
        {tab === "platform" && (
          <>
            <p className="lt-note">
              一张原图 → 勾选的平台尺寸全套产出（cover 裁切铺满，不变形）。
              输出到原图旁的 <strong>aiiv-processed</strong> 目录，文件名自动带平台与尺寸。
            </p>
            {PLATFORM_PRESETS.map((p) => (
              <label
                key={p.id}
                style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}
              >
                <input
                  type="checkbox"
                  checked={pfSel[p.id] !== false}
                  onChange={(e) => setPfSel((s) => ({ ...s, [p.id]: e.target.checked }))}
                />
                <span>
                  {p.name} <span className="muted">{p.w}×{p.h}</span>
                </span>
              </label>
            ))}
            <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <input
                type="checkbox"
                checked={pfWm}
                onChange={(e) => setPfWm(e.target.checked)}
              />
              <span>套用上方水印设置（品牌曝光）</span>
            </label>
            <button
              className="btn primary"
              disabled={pfBusy}
              onClick={() => void runPlatformExport()}
            >
              {pfBusy ? "导出中…" : "导出勾选的平台套件"}
            </button>
            {pfLog.length > 0 && (
              <div className="lt-note">
                {pfLog.map((l, i) => (
                  <div key={i}>{l}</div>
                ))}
              </div>
            )}
          </>
        )}

        {tab === "batch" && (
          <>
            <p className="lt-note">
              对当前文件夹里的**全部 {folderItems.length} 张图**执行同一个本地操作。
              产物写进源目录旁的 **aiiv-processed/** 子文件夹，**原图一张都不会动**。
            </p>
            <label className="lt-row">
              <span>执行的操作</span>
              <select value={batchOp} onChange={(e) => setBatchOp(e.target.value as BatchOp)}>
                <option value="watermark">加水印（用「加水印」页签里的设置）</option>
                <option value="resize">改尺寸（用「改尺寸」页签里的设置）</option>
              </select>
            </label>
            <p className="lt-note">
              批量只开放**确定性的本地操作**（水印/尺寸）。AI 改图按张计费，
              误点一次就是一整个文件夹的钱 —— 所以 AI 不做批量。
            </p>
            <button
              className="btn primary"
              disabled={working || !sourceDir || !folderItems.length}
              onClick={() => runBatchNow(batchOp)}
              title={
                !sourceDir
                  ? "当前图片没有来源文件夹（如刚拖入的单张图）。请用「打开文件夹」选择目录后再批量处理"
                  : folderItems.length === 0
                    ? "当前文件夹里没有可处理的图片"
                    : `对当前目录的 ${folderItems.length} 张图依次执行所选操作`
              }
            >
              {batchProg
                ? `处理中 ${batchProg.done}/${batchProg.total}（${batchProg.current}）`
                : `开始批量处理 ${folderItems.length} 张`}
            </button>
            {batchResult && (
              <p className="lt-note">
                完成：成功 {batchResult.ok} · 跳过 {batchResult.skipped} · 失败{" "}
                {batchResult.failed}
                {batchResult.errors.length > 0 && (
                  <>
                    <br />
                    {batchResult.errors.slice(0, 3).map((e) => (
                      <span key={e.name}>
                        {e.name}：{e.message}
                        <br />
                      </span>
                    ))}
                  </>
                )}
                <br />
                产物目录：{batchResult.outDir}
              </p>
            )}
          </>
        )}

        {tab === "geometry" && (
          <>
            <button
              className="btn"
              disabled={!selection || working}
              onClick={() => selection && runLocal((d) => cropToRect(d, selection), "裁剪到选区")}
              title={selection ? "把选区外的部分裁掉" : "先在图上框选要保留的区域"}
            >
              {selection ? "裁剪到选区" : "裁剪（先在图上框选）"}
            </button>
            <div className="lt-btns">
              <button className="btn" disabled={working} onClick={() => runLocal((d) => rotateOrtho(d, 270), "左转 90°")}>左转 90°</button>
              <button className="btn" disabled={working} onClick={() => runLocal((d) => rotateOrtho(d, 90), "右转 90°")}>右转 90°</button>
              <button className="btn" disabled={working} onClick={() => runLocal((d) => rotateOrtho(d, 180), "旋转 180°")}>180°</button>
            </div>
            <div className="lt-btns">
              <button className="btn" disabled={working} onClick={() => runLocal((d) => flipImage(d, "h"), "水平翻转")}>水平翻转</button>
              <button className="btn" disabled={working} onClick={() => runLocal((d) => flipImage(d, "v"), "垂直翻转")}>垂直翻转</button>
            </div>
            <label className="lt-row">
              <span>拉直 {angle}°</span>
              <input type="range" min={-15} max={15} step={0.5} value={angle}
                onChange={(e) => setAngle(Number(e.target.value))} />
            </label>
            <button className="btn primary" disabled={working || !angle}
              onClick={() => runLocal((d) => straighten(d, -angle), `拉直 ${angle}°`)}>
              拉直
            </button>
            <p className="lt-note">
              旋转 90/180° 是无损的（不重采样）；拉直会按角度算出能放下的最大矩形并裁掉四角，
              所以不会留黑边，代价是四周各裁掉一点。
            </p>
          </>
        )}

        {tab === "inpaint" && (
          <>
            {!selection && (
              <p className="lt-note">
                先在图上框选要去掉的区域（水印、日期戳、杂物），再回到这里点生成。
              </p>
            )}
            <div className="lt-field">
          <span className="lt-label">填充引擎</span>
          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <button
              type="button"
              className={"btn " + (engine === "iopaint" ? "primary" : "")}
              style={{ flex: 1, fontSize: 12, padding: "6px 8px" }}
              onClick={() => setEngine("iopaint")}
            >
              IOPaint · 本地 AI
            </button>
            <button
              type="button"
              className={"btn " + (engine === "builtin" ? "primary" : "")}
              style={{ flex: 1, fontSize: 12, padding: "6px 8px" }}
              onClick={() => setEngine("builtin")}
            >
              内置 · 扩散填洞
            </button>
          </div>
        </div>
            {/* 状态指示：让人知道点下去会发生什么，而不是干等十几秒 */}
            {engine === "iopaint" && (
              <p className="lt-note" style={{ marginTop: -4 }}>
                {ipAlive === true && "✅ 本地 AI 服务在跑，框选后点按钮即可（约 1~10 秒）"}
                {ipAlive === false &&
                  "⏳ 本地 AI 服务正在启动（首次要下载约 200MB 模型，只此一次）…可以先框选"}
                {ipAlive === null && "正在检查本地 AI 服务…"}
              </p>
            )}
            <label className="field-check lt-check">
              <input type="checkbox" checked={ip.autoMask}
                onChange={(e) => setIp({ ...ip, autoMask: e.target.checked })} />
              <span>
                只填「像水印的像素」
                <em className="field-note">
                  打开时只在选区内挑**亮且接近无彩色**的像素来填（白字水印就是这样），
                  选区里的真实内容会被保住；关掉则是整块填掉，只适合整块都是水印的情况。
                </em>
              </span>
            </label>
            {ip.autoMask && (
              <>
                <label className="lt-row">
                  <span>判为水印的亮度 ≥{ip.lumaThreshold}</span>
                  <input type="range" min={150} max={245} value={ip.lumaThreshold}
                    onChange={(e) => setIp({ ...ip, lumaThreshold: Number(e.target.value) })} />
                </label>
                <label className="lt-row">
                  <span>边缘外扩 {ip.dilate} 像素</span>
                  <input type="range" min={0} max={5} value={ip.dilate}
                    onChange={(e) => setIp({ ...ip, dilate: Number(e.target.value) })} />
                </label>
              </>
            )}
            <button className="btn primary" disabled={!selection || working}
              onClick={() => selection && (engine === "iopaint"
                ? runLocal((d) => iopaintErase(d, selection, ip), "AI 去水印（IOPaint·本地）")
                : runLocal(
                    (d) => inpaintRegion(d, { ...ip, rect: selection }),
                    ip.autoMask ? "本地去水印（自动识别）" : "本地去水印（整块）"
                  ))}>
              {working
                ? engine === "iopaint" ? "AI 处理中（本地模型）…" : "处理中…"
                : engine === "iopaint" ? "AI 去掉（本地免费）" : "本地去掉"}
            </button>
            {engine === "builtin" ? (
              <p className="lt-note">
                算法是**扩散填洞**：待填像素反复用周围像素的平均值更新 ——
                与经典的 Telea / Navier-Stokes 同族，只是实现更简单。
                <br />
                **适合平坦与渐变背景**（天空、纯色墙、渐变底）：这类水印本地几十毫秒就能干净去掉，
                不花钱、不上传。**复杂纹理（草地、毛发、木纹）会糊** —— 那是算法本身的边界，
                切换到上面的 **IOPaint 引擎**即可：它在本地跑 LaMa 模型，
                能重建出真实纹理，同样免费、同样不上传，只是要等几秒。
              </p>
            ) : (
              <p className="lt-note">
                在**本机**跑 LaMa 模型（IOPaint）：复杂纹理能重建出真实细节，
                图片不出本机、不花钱、不用 Key。CPU 推理约几秒到十几秒；
                服务没启动时应用会自动拉起（**首次要下载约 200MB 模型**，只此一次）。
              </p>
            )}
          </>
        )}

        {tab === "adjust" && (
          <>
            <label className="lt-row">
              <span>亮度 {adj.brightness > 0 ? "+" : ""}{adj.brightness}</span>
              <input type="range" min={-100} max={100} value={adj.brightness}
                onChange={(e) => setAdj({ ...adj, brightness: Number(e.target.value) })} />
            </label>
            <label className="lt-row">
              <span>对比度 {adj.contrast > 0 ? "+" : ""}{adj.contrast}</span>
              <input type="range" min={-100} max={100} value={adj.contrast}
                onChange={(e) => setAdj({ ...adj, contrast: Number(e.target.value) })} />
            </label>
            <label className="lt-row">
              <span>饱和度 {adj.saturation > 0 ? "+" : ""}{adj.saturation}</span>
              <input type="range" min={-100} max={100} value={adj.saturation}
                onChange={(e) => setAdj({ ...adj, saturation: Number(e.target.value) })} />
            </label>
            <div className="lt-btns">
              <button className="btn" disabled={working}
                onClick={() => setAdj({ brightness: 0, contrast: 0, saturation: 0 })}>复位</button>
              <button className="btn" disabled={working}
                onClick={() => setAdj({ brightness: 6, contrast: 12, saturation: 8 })}>一键增强</button>
            </div>
            <button className="btn primary" disabled={working}
              onClick={() => runLocal((d) => adjustImage(d, adj), "亮度对比度")}>
              {working ? "处理中…" : "生成"}
            </button>
            <p className="lt-note">
              亮度与对比度合成一张 256 项查表（LUT）—— 这是各家图像软件的标准做法。点「生成」才应用。
            </p>
          </>
        )}

        {tab === "watermark" && (
          <>
            <label className="lt-row">
              <span>文字</span>
              <input
                value={wm.text}
                onChange={(e) => setWm({ ...wm, text: e.target.value })}
                placeholder="@你的账号"
              />
            </label>
            <label className="lt-row">
              <span>位置</span>
              <select
                value={wm.position}
                onChange={(e) => setWm({ ...wm, position: e.target.value as WatermarkPosition })}
              >
                <option value="br">右下角</option>
                <option value="bl">左下角</option>
                <option value="tr">右上角</option>
                <option value="tl">左上角</option>
                <option value="center">居中</option>
                <option value="tile">平铺（更难被抹掉）</option>
              </select>
            </label>
            <label className="lt-row">
              <span>颜色</span>
              <span className="lt-colors">
                {WATERMARK_COLORS.map((c) => (
                  <button
                    key={c.value}
                    className={
                      "lt-color" +
                      (wm.color.toLowerCase() === c.value.toLowerCase() ? " active" : "")
                    }
                    style={{ background: c.value }}
                    onClick={() => setWm({ ...wm, color: c.value })}
                    title={c.label}
                    aria-label={c.label}
                  />
                ))}
                {/* 取色器兜底：常用色块之外的特殊需求 */}
                <input
                  type="color"
                  className="lt-color-pick"
                  value={wm.color}
                  onChange={(e) => setWm({ ...wm, color: e.target.value })}
                  title="自定义颜色"
                />
              </span>
            </label>
            <label className="lt-row">
              <span>不透明度 {wm.opacity}%</span>
              <input
                type="range"
                min={10}
                max={100}
                value={wm.opacity}
                onChange={(e) => setWm({ ...wm, opacity: Number(e.target.value) })}
              />
            </label>
            <label className="lt-row">
              <span>字号 {wm.sizePct}%</span>
              <input
                type="range"
                min={1}
                max={12}
                step={0.2}
                value={wm.sizePct}
                onChange={(e) => setWm({ ...wm, sizePct: Number(e.target.value) })}
              />
            </label>
            <p className="lt-note">
              字号按图片短边的百分比算 —— 4000px 的原图和 800px 的截图观感一致，不用手调。
            </p>
            <button
              className="btn primary"
              disabled={busy || working || !sourceUrl}
              onClick={() => runLocal((d) => addTextWatermark(d, wm), "加水印")}
            >
              {working ? "处理中…" : "生成"}
            </button>
          </>
        )}

        {tab === "resize" && (
          <>
            <div className="lt-chips">
              {presets.map((p) => (
                <button
                  key={p.label}
                  className={"lt-chip" + (size.w === p.width && size.h === p.height ? " active" : "")}
                  onClick={() => setSize({ ...size, w: p.width, h: p.height })}
                >
                  {p.label}
                  <em>
                    {p.width}×{p.height}
                  </em>
                </button>
              ))}
            </div>
            <label className="lt-row">
              <span>宽 × 高</span>
              <span className="lt-inline">
                <input
                  type="number"
                  value={size.w}
                  onChange={(e) => setSize({ ...size, w: Number(e.target.value) })}
                />
                ×
                <input
                  type="number"
                  value={size.h}
                  onChange={(e) => setSize({ ...size, h: Number(e.target.value) })}
                />
              </span>
            </label>
            <label className="lt-row">
              <span>方式</span>
              <select
                value={size.mode}
                onChange={(e) =>
                  setSize({ ...size, mode: e.target.value as "contain" | "cover" | "stretch" })
                }
              >
                <option value="fit">等比缩放（输出实际尺寸，推荐）</option>
                <option value="contain">等比缩放 + 补白到目标尺寸</option>
                <option value="cover">等比缩放 + 居中裁切（填满尺寸）</option>
                <option value="stretch">拉伸（会变形）</option>
              </select>
            </label>
            <button
              className="btn primary"
              disabled={busy || working || !sourceUrl}
              onClick={() =>
                runLocal(
                  (d) =>
                    resizeImage(d, {
                      width: size.w,
                      height: size.h,
                      mode: size.mode,
                      background: "#ffffff",
                    }),
                  `改尺寸 ${size.w}×${size.h}`
                )
              }
            >
              {working ? "处理中…" : "生成"}
            </button>
          </>
        )}

        {tab === "exportText" && (
          <>
            {!hasText && (
              <p className="lt-note">
                这张图还没有识别结果。先在上面的「识别」或「提取文字」跑一次，再回来导出。
              </p>
            )}
            <label className="lt-row">
              <span>格式</span>
              <select value={fmt} onChange={(e) => setFmt(e.target.value as TextFormat)}>
                <option value="md">Markdown（笔记/公众号直接可用）</option>
                <option value="txt">纯文本</option>
                <option value="csv">CSV（表格能被 Excel 正确分列）</option>
              </select>
            </label>
            {fmt === "csv" && (
              <p className="lt-note">
                会自动把模型给的 Markdown 表格转成 CSV —— 直接存 .csv 的话 Excel 会把整行塞进一格。
              </p>
            )}
            <button
              className="btn primary"
              disabled={!hasText}
              onClick={() => {
                const built = buildTextExport(exportText, fmt, imageName || "识别结果");
                onExport(exportText, built.filename);
              }}
            >
              导出 {fmt.toUpperCase()}
            </button>
          </>
        )}

        {err && <div className="lt-err">⚠️ {err}</div>}
      </div>

      <div className="lt-foot">
        这几项是**本地**处理的：不上传、不花钱、几毫秒完成 —— 所以没走 AI。
      </div>
    </div>
  );
}
