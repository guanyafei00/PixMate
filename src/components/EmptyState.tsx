/**
 * 首启空状态引导（UI 方案 v0.3 / M4）：三步上手 + 「跳过」逃生门。
 * 仅在「从未打开过图片 且 未完成引导」时渲染；顶栏「?」可随时重看。
 *
 * B1 扩展：首启就能看到本地 AI 引擎四态（未安装/安装中/已就绪/异常）——
 * 让「去水印引擎要装、装好离线可用」这件事在第一屏就讲清楚，
 * 而不是等用户点到去水印页签才发现还要装。
 */
import EngineStatusBadge, { type EngineState } from "./EngineStatusBadge";

export default function EmptyState({
  onOpenImage,
  onOpenFolder,
  onDismiss,
  engineState,
  onEngine,
}: {
  onOpenImage: () => void;
  onOpenFolder: () => void;
  onDismiss: () => void;
  /** 桌面版传入（浏览器预览无本地引擎概念，不传即不渲染） */
  engineState?: EngineState;
  /** 点击徽标：关掉引导并打开去水印页签的装机流程 */
  onEngine?: () => void;
}) {
  return (
    <div className="empty-overlay">
      <div className="empty">
        <div className="empty-logo">Pix<span>Mate</span></div>
        <div className="empty-tagline">本地看图 · AI 去水印 · 图片不出本机</div>
        <div className="empty-title">把图片拖进来，或</div>
        <div className="empty-btns">
          <button className="btn primary" onClick={onOpenFolder}>
            📂 打开文件夹
          </button>
          <button className="btn" onClick={onOpenImage}>
            打开图片
          </button>
        </div>
        <div className="empty-steps">
          <div className="estep">
            <div className="en">1</div>
            <div className="et">打开图片</div>
            <div className="ed">拖入或选择文件夹</div>
          </div>
          <div className="estep">
            <div className="en">2</div>
            <div className="et">框选 + AI</div>
            <div className="ed">去水印 · 识别 · 改图</div>
          </div>
          <div className="estep">
            <div className="en">3</div>
            <div className="et">另存为</div>
            <div className="ed">原图永远不会被覆盖</div>
          </div>
        </div>
        {engineState && onEngine && (
          <div className="empty-engine">
            <EngineStatusBadge state={engineState} onOpen={onEngine} />
            <span className="empty-engine-hint">
              引擎装好后完全离线可用，去水印图片不出本机
            </span>
          </div>
        )}
        <div className="empty-foot">
          <button className="empty-skip" onClick={onDismiss}>
            跳过，直接看图
          </button>
          <span className="empty-kbd">
            小技巧：Ctrl+K 可搜索所有功能
          </span>
        </div>
      </div>
    </div>
  );
}
