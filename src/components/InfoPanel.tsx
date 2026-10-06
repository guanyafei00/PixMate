import { FileInfo } from "../lib/api";

/**
 * 图片信息浮层（本地能力，不联网、不需要 API Key）。
 *
 * 借鉴调研里提到的 Tiefsee「信息浮层」：看图的很多时候就是要知道
 * 「这图多大、什么时候拍的、什么机器拍的」—— 这跟 AI 无关，但对看图器是真需求。
 *
 * 放在主图区左上角：顶部中间留给了编辑结果条，右下角留给了缩放 HUD。
 */
export default function InfoPanel({
  info,
  loading,
  pixelSize,
  onClose,
}: {
  info: FileInfo | null;
  loading: boolean;
  /** 从渲染层拿到的真实像素尺寸（比 EXIF 里的更可信，作为交叉校验/兜底） */
  pixelSize: { w: number; h: number } | null;
  onClose: () => void;
}) {
  const w = pixelSize?.w || info?.width || 0;
  const h = pixelSize?.h || info?.height || 0;
  const mp = w && h ? (w * h) / 1e6 : 0;

  const exifRows = info?.exif
    ? Object.entries(info.exif).filter(([, v]) => v && String(v).trim())
    : [];

  const copyAll = async () => {
    const lines: string[] = [];
    lines.push(`文件：${info?.name ?? "—"}`);
    if (w && h) lines.push(`尺寸：${w} × ${h}${mp ? `（${mp.toFixed(1)} MP）` : ""}`);
    if (info?.sizeText) lines.push(`大小：${info.sizeText}`);
    if (info?.mtimeText) lines.push(`修改时间：${info.mtimeText}`);
    if (info?.ext) lines.push(`格式：${info.ext.toUpperCase()}`);
    if (info?.path) lines.push(`路径：${info.path}`);
    for (const [k, v] of exifRows) lines.push(`${k}：${v}`);
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
    } catch {
      /* 剪贴板不可用时静默失败，不打扰看图 */
    }
  };

  return (
    <div className="info-panel">
      <div className="info-head">
        <span className="info-title">图片信息</span>
        <div className="info-head-actions">
          <button className="info-copy" onClick={copyAll} title="复制全部信息">
            复制
          </button>
          <button className="info-close" onClick={onClose} title="关闭 (I)">
            ✕
          </button>
        </div>
      </div>

      <div className="info-body">
        {loading && <div className="info-loading">正在读取…</div>}

        {!loading && !info && (
          <div className="info-empty">
            当前环境拿不到文件信息（浏览器预览无文件系统权限）。
          </div>
        )}

        {!loading && info && (
          <>
            <div className="info-row">
              <span className="info-k">文件</span>
              <span className="info-v" title={info.path}>
                {info.name}
              </span>
            </div>
            <div className="info-row">
              <span className="info-k">尺寸</span>
              <span className="info-v">
                {w && h ? `${w} × ${h}` : "—"}
                {mp > 0 && <span className="info-dim"> · {mp.toFixed(1)} MP</span>}
              </span>
            </div>
            <div className="info-row">
              <span className="info-k">大小</span>
              <span className="info-v">{info.sizeText ?? "—"}</span>
            </div>
            <div className="info-row">
              <span className="info-k">修改时间</span>
              <span className="info-v">{info.mtimeText ?? "—"}</span>
            </div>
            <div className="info-row">
              <span className="info-k">格式</span>
              <span className="info-v">{(info.ext || "?").toUpperCase()}</span>
            </div>

            {exifRows.length > 0 && (
              <>
                <div className="info-sep">EXIF</div>
                {exifRows.map(([k, v]) => (
                  <div className="info-row" key={k}>
                    <span className="info-k">{k}</span>
                    <span className="info-v">{v}</span>
                  </div>
                ))}
              </>
            )}

            {exifRows.length === 0 && (
              <div className="info-note">
                这张图没有 EXIF 信息（截图、AI 生成图、或已被编辑导出时会这样）。
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
