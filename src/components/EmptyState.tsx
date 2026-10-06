/**
 * 首启空状态引导（UI 方案 v0.3 / M4）：三步上手 + 「跳过」逃生门。
 * 仅在「从未打开过图片 且 未完成引导」时渲染；顶栏「?」可随时重看。
 */

export default function EmptyState({
  onOpenImage,
  onOpenFolder,
  onDismiss,
}: {
  onOpenImage: () => void;
  onOpenFolder: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="empty-overlay">
      <div className="empty">
        <div className="empty-emoji">🖼️</div>
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
