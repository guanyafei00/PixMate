import { useCallback, useEffect, useRef, useState } from "react";
import { ImageItem } from "../lib/api";
import { SelectionRect } from "../lib/imageEdit";
import { EditAction } from "../lib/editActions";
import SelectionToolbar from "./SelectionToolbar";
import EditResultBar, { EditPhase } from "./EditResultBar";

/**
 * 主图区 —— 看图器的本命。
 *
 * 职责：几何（缩放 / 平移 / 框选）+ 两个浮层（AI 编辑动作条、编辑结果条）。
 *
 * 设计要点：
 * - 缩放以**光标为锚点**（不是以中心），这是顺不顺手的分水岭；
 * - 拖动平移带边界约束，不会把图拖飞；
 * - **切换图片自动重置缩放**（直接来自调研里用户提的 issue）；
 * - 框选后，选区以「**原图像素坐标**」保存为唯一真源，显示时再换算回屏幕坐标 ——
 *   这样用户在选区之后继续缩放/平移，选框会跟着图走，不会错位。
 */

const MIN_SCALE = 0.02;
const MAX_SCALE = 32;
const ZOOM_STEP = 1.25;
const PAD = 20; // 与 .image-view 的 padding 保持一致
/** 小于这个尺寸的拖拽视为误触，不算框选 */
const MIN_SEL_SCREEN_PX = 8;

interface Size {
  w: number;
  h: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export interface ImageViewEditProps {
  phase: EditPhase;
  actions: EditAction[];
  providerName: string;
  supportsSelection: boolean;
  selection: SelectionRect | null;
  onSelectionChange: (s: SelectionRect | null) => void;
  onRunAction: (a: EditAction, prompt: string) => void;
  onSave: () => void;
  onDiscard: () => void;
  onRetry: () => void;
  /**
   * 版本栈（原图 + 各次改图结果），用于 A/B 对比。
   * 只传"有几版 / 现在看第几版 / 切到第几版"—— 具体内容由上层管理，
   * ImageView 不持有版本数据（保持它只管显示的职责）。
   */
  versionCount: number;
  versionCursor: number;
  onSelectVersion: (i: number) => void;
}

export default function ImageView({
  image,
  displayUrl,
  onOpen,
  onDropFile,
  edit,
  overlay,
  onNaturalSize,
}: {
  image: ImageItem | null;
  /** 实际显示的地址：有编辑结果时是结果的 data URL；对比模式下是原图 */
  displayUrl: string;
  onOpen: () => void;
  onDropFile?: (file: File) => void;
  edit: ImageViewEditProps;
  /**
   * 额外浮层（左上角）。由上层构造，ImageView 只负责摆放 ——
   * 这样再加新浮层不用继续往这里堆 props。
   */
  overlay?: React.ReactNode;
  /** 把当前图片的真实像素尺寸报给上层（信息面板要用，比 EXIF 里的更可靠） */
  onNaturalSize?: (size: { w: number; h: number } | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  /**
   * 已测量过的图片尺寸，按 URL 缓存。
   * 为什么用 Map 而不是一个 state：编辑结果与原图可以来回切换对比，
   * 如果只存「当前这张」的尺寸，每次切换都要重量一次、判空一次，画面会跳。
   */
  const sizes = useRef<Map<string, Size>>(new Map());
  const [, bumpMeasure] = useState(0);

  const [loadError, setLoadError] = useState(false);
  const [viewport, setViewport] = useState<Size>({ w: 0, h: 0 });
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const [fitLocked, setFitLocked] = useState(true);
  const [fileDragging, setFileDragging] = useState(false);
  const [panning, setPanning] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  /** 拖拽中的临时选框（容器坐标）；拖完就换算成图像坐标交给上层 */
  const [drag, setDrag] = useState<{
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  } | null>(null);
  const [comparing, setComparing] = useState(false);

  /** 实际显示哪张图：对比模式下看原图，否则看编辑结果（没有结果就是原图） */
  const hasResult = edit.phase.kind === "done";
  const shownUrl = comparing && hasResult && image ? image.url : displayUrl;

  const nat = sizes.current.get(shownUrl) ?? null;
  const shownUrlRef = useRef(shownUrl);
  shownUrlRef.current = shownUrl;

  /** 在 fit 模式下，图片不放大超过原始尺寸（小图按 100% 显示） */
  const fitScale =
    nat && viewport.w > PAD * 2 && viewport.h > PAD * 2
      ? Math.min((viewport.w - PAD * 2) / nat.w, (viewport.h - PAD * 2) / nat.h, 1)
      : 1;

  // 原生事件监听器里要读到最新值，用 ref 镜像，避免闭包过期（本项目被 stale closure 咬过一次）
  const live = useRef({ natural: nat, viewport, fitLocked, view, selectMode });
  live.current = { natural: nat, viewport, fitLocked, view, selectMode };

  /* ---------- 坐标系换算（容器 ↔ 原图像素） ---------- */

  /** 图片左上角在容器里的位置 */
  const imageOrigin = useCallback(() => {
    const { natural: n, viewport: vp, view: v } = live.current;
    if (!n) return null;
    return {
      left: vp.w / 2 + v.x - (n.w * v.scale) / 2,
      top: vp.h / 2 + v.y - (n.h * v.scale) / 2,
      scale: v.scale,
    };
  }, []);

  /** 图像像素 → 容器坐标（当前 scale / offset 下） */
  const toContainer = useCallback(
    (r: SelectionRect) => {
      const o = imageOrigin();
      if (!o) return null;
      return {
        left: o.left + r.x * o.scale,
        top: o.top + r.y * o.scale,
        width: r.w * o.scale,
        height: r.h * o.scale,
      };
    },
    [imageOrigin]
  );

  /** 容器坐标 → 图像像素（并夹到图片范围内，避免选到图外） */
  const toImage = useCallback(
    (cx: number, cy: number) => {
      const o = imageOrigin();
      const n = live.current.natural;
      if (!o || !n) return null;
      return {
        x: clamp((cx - o.left) / o.scale, 0, n.w),
        y: clamp((cy - o.top) / o.scale, 0, n.h),
      };
    },
    [imageOrigin]
  );

  /* ---------- 平移边界与缩放 ---------- */

  const clampOffset = useCallback((x: number, y: number, s: number) => {
    const { natural: n, viewport: vp } = live.current;
    if (!n) return { x: 0, y: 0 };
    const maxX = Math.max(0, (n.w * s - (vp.w - PAD * 2)) / 2);
    const maxY = Math.max(0, (n.h * s - (vp.h - PAD * 2)) / 2);
    return { x: clamp(x, -maxX, maxX), y: clamp(y, -maxY, maxY) };
  }, []);

  /**
   * 适应窗口。
   *
   * 【为什么现量而不是读 state】
   * 原实现读 `live.current.viewport` —— 那是**上一次渲染**写进去的值，
   * 布局刚变（缩略图栏挂载、面板开合、窗口调整）时它可能是旧的。
   * 直接从 DOM 量 clientWidth/clientHeight，拿到的至少是"这一刻的真实尺寸"。
   *
   * 【但这**不**能消除"点得太早"的问题】—— 别误以为它能。
   * 实测：点「适应」那一刻如果容器自己还在收缩，当场量到的本来就是偏的
   * （量到 774，稳定后是 745）。那属于**调用时机**问题，不是取值来源问题；
   * 应用会随布局稳定自动重算（第二次点击或 ResizeObserver 触发后就精确了）。
   * 所以：能保证"取值是当前真实尺寸"，保证不了"布局已经稳定"。
   *
   * 注意不要在这里 setViewport：那会让 viewport 每次都是新对象，
   * 触发「fitScale 变化 → 再调 applyFit」的循环。
   */
  const applyFit = useCallback(() => {
    const n = live.current.natural;
    const el = containerRef.current;
    if (!n || !el) return;
    const vw = el.clientWidth;
    const vh = el.clientHeight;
    if (!vw || !vh) return;
    const s = Math.min((vw - PAD * 2) / n.w, (vh - PAD * 2) / n.h, 1);
    setView({ scale: s, x: 0, y: 0 });
    setFitLocked(true);
  }, []);

  const zoomBy = useCallback(
    (factor: number) => {
      const v = live.current.view;
      const s2 = clamp(v.scale * factor, MIN_SCALE, MAX_SCALE);
      if (s2 === v.scale) return;
      const nx = -(v.x / v.scale) * s2;
      const ny = -(v.y / v.scale) * s2;
      setFitLocked(false);
      setView({ scale: s2, ...clampOffset(nx, ny, s2) });
    },
    [clampOffset]
  );

  /** 以指定屏幕坐标为锚点缩放 —— 光标下的那一点保持不动 */
  const zoomAt = useCallback(
    (clientX: number, clientY: number, factor: number) => {
      const el = containerRef.current;
      if (!el) return;
      const v = live.current.view;
      const s2 = clamp(v.scale * factor, MIN_SCALE, MAX_SCALE);
      if (s2 === v.scale) return;
      const rect = el.getBoundingClientRect();
      const mx = clientX - rect.left - rect.width / 2;
      const my = clientY - rect.top - rect.height / 2;
      const ix = (mx - v.x) / v.scale;
      const iy = (my - v.y) / v.scale;
      setFitLocked(false);
      setView({ scale: s2, ...clampOffset(mx - ix * s2, my - iy * s2, s2) });
    },
    [clampOffset]
  );

  const zoomToOriginal = useCallback(() => {
    setFitLocked(false);
    setView((v) => ({ scale: 1, ...clampOffset(v.x, v.y, 1) }));
  }, [clampOffset]);

  const toggleFitOriginal = useCallback(() => {
    if (live.current.fitLocked) zoomToOriginal();
    else applyFit();
  }, [applyFit, zoomToOriginal]);

  /* ---------- 尺寸测量 ---------- */

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      // 【2026-10-06 选区错位根因】docked 时容器有 padding-bottom:148
      // （给底部工具条让位），但 clientHeight **含 padding** —— 视口比
      // 图片实际可居中的区域高 148，图片渲染中心与换算基准差 74px，
      // 框选坐标整体错位（用户实测：修复痕迹出现在水印上方）。
      // 这里把 padding 扣掉，视口 = 图片真正可用的区域。
      const pb = parseFloat(getComputedStyle(el).paddingBottom) || 0;
      setViewport({ w: el.clientWidth, h: el.clientHeight - pb });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 显示的图换了（包括编辑结果出现）→ 清掉尺寸缓存与偏移，重新适应。
  // 注意依赖是 displayUrl 而不是 shownUrl：切换「看原图/看结果」不应该重置缩放。
  useEffect(() => {
    sizes.current.clear();
    setLoadError(false);
    setComparing(false);
    setView({ scale: 1, x: 0, y: 0 });
    setFitLocked(true);
  }, [displayUrl]);

  useEffect(() => {
    if (fitLocked) applyFit();
  }, [fitLocked, fitScale, applyFit]);

  const handleImgLoad = useCallback(() => {
    const img = imgRef.current;
    if (!img || !img.naturalWidth || !img.naturalHeight) {
      setLoadError(true);
      onNaturalSize?.(null);
      return;
    }
    setLoadError(false);
    const size = { w: img.naturalWidth, h: img.naturalHeight };
    sizes.current.set(shownUrlRef.current, size);
    onNaturalSize?.(size);
    bumpMeasure((n) => n + 1);
    setFitLocked(true);
  }, [onNaturalSize]);

  /* ---------- 滚轮缩放（必须非 passive，否则 preventDefault 无效） ---------- */

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!live.current.natural) return;
      // 浮层内部滚动时不该缩放图片（信息面板的 EXIF 列表常常要滚）
      const t = e.target as HTMLElement | null;
      if (t && t.closest && t.closest(".info-panel")) return;
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0015);
      zoomAt(e.clientX, e.clientY, clamp(factor, 0.5, 2));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  /* ---------- 鼠标：框选 或 平移 ---------- */

  const canPan = Boolean(
    nat &&
      (nat.w * view.scale > viewport.w - PAD * 2 ||
        nat.h * view.scale > viewport.h - PAD * 2)
  );

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      // 浮层内部的按下（选中文字、拖滚动条）不该被当成平移/框选
      if (
        target.closest(".sel-toolbar") ||
        target.closest(".edit-bar") ||
        target.closest(".info-panel")
      ) {
        return;
      }
      const el = containerRef.current;
      if (!el || !nat) return;

      const rect = el.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      // 框选模式：左键拖 = 画选区（不再平移，避免两个手势打架）
      if (selectMode) {
        e.preventDefault();
        setDrag({ x0: sx, y0: sy, x1: sx, y1: sy });
        const onMove = (ev: MouseEvent) => {
          const nx = clamp(ev.clientX - rect.left, 0, rect.width);
          const ny = clamp(ev.clientY - rect.top, 0, rect.height);
          setDrag({ x0: sx, y0: sy, x1: nx, y1: ny });
        };
        const onUp = (ev: MouseEvent) => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
          setDrag(null);
          const ex = clamp(ev.clientX - rect.left, 0, rect.width);
          const ey = clamp(ev.clientY - rect.top, 0, rect.height);
          if (Math.abs(ex - sx) < MIN_SEL_SCREEN_PX || Math.abs(ey - sy) < MIN_SEL_SCREEN_PX) {
            return; // 误触，忽略
          }
          const a = toImage(Math.min(sx, ex), Math.min(sy, ey));
          const b = toImage(Math.max(sx, ex), Math.max(sy, ey));
          if (!a || !b) return;
          // 【诊断】捕获换算前后的全部坐标系数值（iopaintService 落盘用）
          try {
            const oDbg = imageOrigin();
            (window as any).__aiivDebug = {
              screenSel: { sx, sy, ex, ey },
              rect: { left: rect.left, top: rect.top, w: rect.width, h: rect.height },
              origin: oDbg,
              view: live.current.view,
              natural: live.current.natural,
              viewport: live.current.viewport,
              imageSel: { a, b },
            };
          } catch {
            /* 诊断失败不影响选区 */
          }
          edit.onSelectionChange({
            x: Math.round(a.x),
            y: Math.round(a.y),
            w: Math.max(1, Math.round(b.x - a.x)),
            h: Math.max(1, Math.round(b.y - a.y)),
          });
          setSelectMode(false); // 选完自动退出框选模式，回到浏览手感
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        return;
      }

      if (!canPan) return;
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const v0 = live.current.view;
      setPanning(true);
      const onMove = (ev: MouseEvent) => {
        setView({
          scale: v0.scale,
          ...clampOffset(v0.x + (ev.clientX - startX), v0.y + (ev.clientY - startY), v0.scale),
        });
      };
      const onUp = () => {
        setPanning(false);
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [canPan, clampOffset, edit, nat, selectMode, toImage]
  );

  /* ---------- 全屏 ---------- */

  const toggleFullscreen = useCallback(() => {
    try {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.documentElement.requestFullscreen();
    } catch {
      /* 某些受限环境不允许全屏，忽略即可 */
    }
  }, []);

  /* ---------- 键盘：浏览键独立于 AI，绝不被 AI 功能占用 ---------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      // Esc 优先用于「取消选区」，其次才是「退出框选」
      if (e.key === "Escape") {
        if (edit.selection) {
          edit.onSelectionChange(null);
          return;
        }
        if (selectMode) {
          setSelectMode(false);
          return;
        }
      }
      if (!live.current.natural) return;

      switch (e.key) {
        case "+":
        case "=":
          e.preventDefault();
          zoomBy(ZOOM_STEP);
          break;
        case "-":
        case "_":
          e.preventDefault();
          zoomBy(1 / ZOOM_STEP);
          break;
        case "0":
          e.preventDefault();
          applyFit();
          break;
        case "1":
          e.preventDefault();
          zoomToOriginal();
          break;
        case "f":
        case "F":
          e.preventDefault();
          toggleFullscreen();
          break;
        case "s":
        case "S":
          e.preventDefault();
          setSelectMode((m) => !m);
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [applyFit, edit, selectMode, zoomBy, zoomToOriginal, toggleFullscreen]);

  /* ---------- 拖拽文件 ---------- */

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setFileDragging(true);
  };
  const handleDragLeave = () => setFileDragging(false);
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setFileDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith("image/") && onDropFile) onDropFile(file);
  };

  /* ---------- 渲染 ---------- */

  const percent = Math.round(view.scale * 100);
  const transform = nat
    ? `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})`
    : undefined;

  // 拖拽中的临时框（容器坐标）
  const liveRect = drag
    ? {
        left: Math.min(drag.x0, drag.x1),
        top: Math.min(drag.y0, drag.y1),
        width: Math.abs(drag.x1 - drag.x0),
        height: Math.abs(drag.y1 - drag.y0),
      }
    : null;

  // 已确认的选区（换算回容器坐标 —— 用户缩放/平移时它会跟着图走）
  const selRect = edit.selection ? toContainer(edit.selection) : null;
  const busy = edit.phase.kind === "working";

  /**
   * 动作卡片的落点。
   *
   * 这个计算不是装饰 —— 画布是 overflow:hidden，卡片放不下就会被裁掉（第一版就踩了）；
   * 右下角的缩放 HUD 也会被压住。规则：
   *   优先贴在选区下方；下方放不下就翻到上方；上下都放不下就贴着底边向上展开。
   *   水平方向夹在画布内；未框选时卡片收窄并居中，避开右下角的 HUD。
   */
  const TB_W_SEL = 380;
  const TB_W_BARE = 320;
  const TB_H = 116; // 估算值，只用于判断放不放得下
  const TB_GAP = 10;
  const TB_EDGE = 10;
  const toolbarAnchor = (() => {
    const vp = viewport;
    const w = selRect ? TB_W_SEL : TB_W_BARE;
    const cx = selRect
      ? clamp(
          selRect.left + selRect.width / 2,
          w / 2 + TB_EDGE,
          Math.max(w / 2 + TB_EDGE, vp.w - w / 2 - TB_EDGE)
        )
      : vp.w / 2 - 60; // 略偏左，给右下角的缩放 HUD 让位

    if (!selRect) {
      // 没框选：贴底边向上展开，正好落在缩放 HUD 上方，不打架
      return { x: cx, y: vp.h - 60, placeAbove: true, width: w };
    }
    const belowY = selRect.top + selRect.height + TB_GAP;
    if (belowY + TB_H + TB_EDGE <= vp.h) {
      return { x: cx, y: belowY, placeAbove: false, width: w };
    }
    const aboveY = selRect.top - TB_GAP;
    if (aboveY - TB_H - TB_EDGE >= 0) {
      return { x: cx, y: aboveY, placeAbove: true, width: w };
    }
    return { x: cx, y: vp.h - TB_EDGE, placeAbove: true, width: w };
  })();

  // 底部停靠是否生效：框选工具条或编辑结果条在场时，画布让出底部空间，
  // 图片在这条带之上居中 —— 编辑功能区从此不压住图片
  const toolbarVisible = Boolean(
    image && nat && !busy && !comparing && (selectMode || edit.selection)
  );
  const docked = toolbarVisible || edit.phase.kind !== "idle";
  // docked 切换会改 padding-bottom，但 clientHeight 含 padding 不变，
  // ResizeObserver 不触发 —— 主动重测，让 fit 重新落在可见区域里
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const pb = parseFloat(getComputedStyle(el).paddingBottom) || 0;
    setViewport({ w: el.clientWidth, h: el.clientHeight - pb });
  }, [docked]);

  return (
    <div
      ref={containerRef}
      className={
        "image-view" +
        (fileDragging ? " dragging" : "") +
        (panning ? " panning" : "") +
        (selectMode ? " selecting" : canPan ? " pannable" : "") +
        (docked ? " docked" : "") +
        // 编辑结果条在场时给缩放 HUD 一个让位信号（CSS 里 top:64px 避开结果条）
        (edit.phase.kind !== "idle" ? " edit-bar-visible" : "")
      }
      onClick={!image ? onOpen : undefined}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onMouseDown={onMouseDown}
      onDoubleClick={
        image && !selectMode
          ? (e) => {
              // 双击浮层内部（信息面板里选词）不该切换缩放
              const t = e.target as HTMLElement;
              if (t.closest(".info-panel") || t.closest(".sel-toolbar") || t.closest(".edit-bar")) {
                return;
              }
              toggleFitOriginal();
            }
          : undefined
      }
      title={image ? image.name : "点击或拖拽图片到此处"}
    >
      {image && loadError && (
        <div className="image-error">⚠️ 无法显示这张图片（文件可能已损坏或格式不支持）</div>
      )}

      {image ? (
        <img
          ref={imgRef}
          className={"image-canvas" + (nat ? " sized" : "") + (busy ? " busy" : "")}
          src={shownUrl}
          alt={image.name}
          draggable={false}
          decoding="async"
          onLoad={handleImgLoad}
          onError={handleImgLoad}
          style={nat ? { width: nat.w, height: nat.h, transform } : undefined}
        />
      ) : (
        <div className="drop-hint">
          <div className="drop-icon">🖼️</div>
          <p>点击此处，或把图片拖进来</p>
          <span>打开后 AI 会自动识别图片内容</span>
        </div>
      )}

      {/* 已确认的选区 */}
      {selRect && (
        <div
          className="sel-box"
          style={{
            left: selRect.left,
            top: selRect.top,
            width: selRect.width,
            height: selRect.height,
          }}
        />
      )}
      {/* 拖拽中的选框 */}
      {liveRect && (
        <div
          className="sel-box live"
          style={{
            left: liveRect.left,
            top: liveRect.top,
            width: liveRect.width,
            height: liveRect.height,
          }}
        />
      )}

      {/* 框选模式提示 */}
      {selectMode && !liveRect && (
        <div className="select-hint">按住左键拖动，框选要修改的范围（Esc 退出）</div>
      )}

      {/* 上层塞进来的浮层（图片信息等）。放在框选提示之后、编辑条之前，
          保证层级不压住编辑结果条。 */}
      {overlay}

      {/* AI 编辑动作条：框选模式中、或已有选区时出现，停靠画布底部（不再压住图片）。
          【可见条件必须是「框选中 或 有选区」】—— 选完会自动退出框选模式（回到浏览手感），
          若只看 selectMode，选区一画完工具条就消失，编辑流程直接断掉（自检逮过这个回归）。
          对比原图时隐藏，避免「看着原图却改了结果图」的误解。 */}
      {toolbarVisible && (
        <SelectionToolbar
          anchor={toolbarAnchor}
          selectionPx={edit.selection ? { w: edit.selection.w, h: edit.selection.h } : null}
          actions={edit.actions}
          busy={busy}
          providerName={edit.providerName}
          supportsSelection={edit.supportsSelection}
          onRun={edit.onRunAction}
          onClear={() => edit.onSelectionChange(null)}
        />
      )}

      <EditResultBar
        phase={edit.phase}
        comparing={comparing}
        canCompare={Boolean(image)}
        versions={edit.versionCount}
        versionCursor={edit.versionCursor}
        onSelectVersion={edit.onSelectVersion}
        onToggleCompare={() => setComparing((c) => !c)}
        onSave={edit.onSave}
        onDiscard={() => {
          setComparing(false);
          edit.onDiscard();
        }}
        onRetry={edit.onRetry}
      />

      {/* 缩放 / 框选 HUD */}
      {image && nat && (
        <div className="zoom-hud" onMouseDown={(e) => e.stopPropagation()}>
          <button
            className="hud-btn"
            onClick={() => zoomBy(1 / ZOOM_STEP)}
            title="缩小 (-)"
          >
            −
          </button>
          <span className="hud-percent" title={`原始尺寸 ${nat.w} × ${nat.h}`}>
            {percent}%
          </span>
          <button className="hud-btn" onClick={() => zoomBy(ZOOM_STEP)} title="放大 (+)">
            +
          </button>
          <span className="hud-sep" />
          <button
            className={"hud-btn wide" + (selectMode ? " active" : "")}
            onClick={() => setSelectMode((m) => !m)}
            title="框选一块区域让 AI 修改 (S)"
          >
            框选
          </button>
          <button className="hud-btn wide" onClick={applyFit} title="适应窗口 (0)">
            适应
          </button>
          <button className="hud-btn wide" onClick={zoomToOriginal} title="原始尺寸 (1)">
            1:1
          </button>
        </div>
      )}
    </div>
  );
}
