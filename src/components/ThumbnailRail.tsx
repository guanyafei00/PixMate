import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ImageItem, thumbnailData } from "../lib/api";

/**
 * 左侧缩略图栏（大文件夹导航）。
 *
 * 【为什么必须有】
 * Kimi 报告引的 ImageGlass #1738 是这个问题最硬的证据：在几千张图的文件夹里
 * 切换图片「unacceptably slow，几乎不可用」；ChatGPT 的痛点表也把
 * 「连续浏览与文件夹逻辑」列为高频；豆包①/② 都给了三栏式（左缩略图 / 中主图 / 右 AI）方案。
 *
 * 【为什么是虚拟滚动，而不是简单铺开】
 * 2000 张图直接渲染 2000 个 <img>，就是 ImageGlass #2160 那个
 * 「10MB 图吃掉 6.4GB 内存」的复现路径 —— 解码后的位图全留在内存里。
 * 这里只渲染**视口内 + 少量预取**的节点（通常 15–25 个），
 * 容器高度用占位撑开，滚动位置靠 transform 计算。
 *
 * 【与红线的冲突如何避免】
 * 缩略图**绝不能拖慢主图**：因此
 *   ① 只渲染视口内的项；
 *   ② 每个 img 带 loading="lazy" + decoding="async" + 明确的宽高，
 *      让 Chromium 按显示尺寸解码（JPEG 支持 1/2、1/4、1/8 缩放解码）；
 *   ③ 栏子本身仍是纯渲染；2026-10-04 起唯一例外是可见项会发一次
 *      轻量 IPC 拿持久缩略图（命中磁盘缓存毫秒级，且进程内去重），
 *      换来「第二次打开同一文件夹秒加载」—— 这是和 Windows Photos
 *      拉开差距的核心体验，值得破例。
 */

/**
 * 持久缩略图：优先走壳层缓存（毫秒级命中），失败回退原图。
 *
 * 【分层缓存】进程内 Map（本次会话去重）+ 磁盘缓存（跨会话）。
 * RAW/HEIC 等壳层暂不能解码的，回退到 it.url 的原图 <img>，
 * 行为与改造前完全一致 —— 缩略图缓存是纯增量优化，不改任何既有路径。
 */
const memCache = new Map<string, string | null>();
function useThumbUrl(path: string | undefined, enabled: boolean, fallback: string): string {
  const [url, setUrl] = useState<string>(() => (path ? memCache.get(path) ?? fallback : fallback));
  useEffect(() => {
    let live = true;
    if (!path || !enabled) {
      setUrl(fallback);
      return;
    }
    const memo = memCache.get(path);
    if (memo !== undefined) {
      // null 表示「壳层不支持解码」——直接回退原图，不重复请求
      setUrl(memo ?? fallback);
      return;
    }
    setUrl(fallback);
    thumbnailData(path, 320)
      .then((r) => {
        const u = r.ok && r.dataUrl ? r.dataUrl : null;
        memCache.set(path, u);
        if (live && u) setUrl(u);
      })
      .catch(() => {
        memCache.set(path, null);
        if (live) setUrl(fallback);
      });
    return () => {
      live = false;
    };
    // fallback 变化不重发请求：磁盘缓存键只跟文件有关
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, enabled]);
  return url;
}

/** 单项高度：缩略图 56 + 上下留白 8×2 + 间距 4 */
const ITEM_H = 76;
/** 视口外多渲染几项，滚动时不至于露出空白 */
const OVERSCAN = 6;

export default function ThumbnailRail({
  items,
  index,
  onSelect,
  onClose,
  thumbsReady = true,
}: {
  items: ImageItem[];
  index: number;
  onSelect: (i: number) => void;
  onClose: () => void;
  /**
   * 缩略图是否可以开始加载。
   *
   * 【为什么拆成两级】真实瓶颈是**缩略图的解码**，不是这几个盒子：
   *   · 如果整条栏延后挂载 → 画布宽度会在栏出现时变化 → 图片要重新适应，
   *     用户看到"图打开后自己缩了一下"（实测 90% → 78%）
   *   · 现在改成：**栏子立刻挂上**（占位尺寸一致，布局从第一帧起就稳定），
   *     只把 <img> 的加载推迟到主图解码之后（thumbsReady=false 时渲染同尺寸占位）
   * 这样既没有解码抢占（首帧红线），也没有布局跳变。
   */
  thumbsReady?: boolean;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);

  // 视口高度（窗口尺寸变化要跟着变，否则虚拟窗口算错、底部会露白）
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const sync = () => setViewH(el.clientHeight || 600);
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /**
   * 当前项变化 → 只把它滚进可视范围。
   * 刻意做成「不超出就不动」：否则用户手动滚动时会一直被拽回去。
   */
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const top = index * ITEM_H;
    const bottom = top + ITEM_H;
    if (top < el.scrollTop) {
      el.scrollTop = top;
    } else if (bottom > el.scrollTop + el.clientHeight) {
      el.scrollTop = bottom - el.clientHeight;
    }
  }, [index]);

  const total = items.length;
  const start = Math.max(0, Math.floor(scrollTop / ITEM_H) - OVERSCAN);
  const end = Math.min(total, Math.ceil((scrollTop + viewH) / ITEM_H) + OVERSCAN);
  // 注意别把这个变量叫 window —— 会遮蔽全局 window 对象
  const visible = items.slice(start, end);

  return (
    <aside className="thumb-rail" aria-label="缩略图导航">
      <div className="rail-head">
        <span className="rail-title">缩略图</span>
        <span className="rail-count">
          {index + 1} / {total}
        </span>
        <button className="rail-close" onClick={onClose} title="收起缩略图栏 (T)">
          ✕
        </button>
      </div>

      <div
        className="rail-list"
        ref={listRef}
        onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
      >
        {/* 占位：把滚动条撑到真实总高度，但不渲染真实节点 */}
        <div className="rail-spacer" style={{ height: total * ITEM_H }}>
          {visible.map((it, k) => {
            const i = start + k;
            return (
              <ThumbItem
                key={it.path + "@" + i}
                item={it}
                pos={i * ITEM_H}
                active={i === index}
                thumbsReady={thumbsReady}
                onSelect={() => onSelect(i)}
                no={i + 1}
              />
            );
          })}
        </div>
      </div>
    </aside>
  );
}

/**
 * 单个缩略图项（从 map 回调抽成子组件：hook 只能在组件里调用）。
 */
function ThumbItem({
  item,
  pos,
  active,
  thumbsReady,
  onSelect,
  no,
}: {
  item: ImageItem;
  pos: number;
  active: boolean;
  thumbsReady: boolean;
  onSelect: () => void;
  no: number;
}) {
  const thumbUrl = useThumbUrl(item.path, thumbsReady, item.url);
  return (
    <button
      className={"thumb-item" + (active ? " active" : "")}
      style={{ top: pos }}
      onClick={onSelect}
      title={item.name}
    >
      {thumbsReady ? (
        <img
          className="thumb-img"
          src={thumbUrl}
          alt=""
          /* 显式的宽高属性不是装饰：Chromium 靠它知道「目标显示尺寸」，
             从而对 JPEG 走 1/2、1/4、1/8 的**缩放解码** ——
             这是 20MB 大图做缩略图时不把内存吃爆的关键 */
          width={56}
          height={56}
          loading="lazy"
          decoding="async"
          draggable={false}
        />
      ) : (
        // 同尺寸占位：布局与有图时完全一致，稍后换成真图不会引起重排
        <div className="thumb-img thumb-ph" aria-hidden="true" />
      )}
      <span className="thumb-no">{no}</span>
    </button>
  );
}
