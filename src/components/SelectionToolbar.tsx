import { useEffect, useRef, useState } from "react";
import { EditAction } from "../lib/editActions";

/**
 * 选区浮出的 AI 编辑工具条。
 *
 * 【停靠式，不再贴着选区漂】
 * 最初借鉴 CleanShot 让卡片贴着选区浮出，实测反馈：380px 的卡片压在图上，
 * 用户要编辑的恰恰是被挡住的那块 —— 得不偿失。所以改成停靠画布底部居中：
 * 进入框选模式时画布自动让出底部空间（.image-view.docked），互不遮挡。
 * anchor 仍传入，用于在选区变化时重置输入态。
 *
 * 两态卡片，避免一层层弹窗：
 *   ① 动作态：列出当前服务商支持的动作
 *   ② 输入态：点了「按描述改 / 整图改」后原地换成输入框
 */
export default function SelectionToolbar({
  anchor,
  selectionPx,
  actions,
  busy,
  providerName,
  supportsSelection,
  onRun,
  onClear,
}: {
  /**
   * 选区锚点。仅用于「选区变了就退出输入态」；
   * 定位已改为底部停靠，不再跟随选区。
   */
  anchor: { x: number; y: number; placeAbove: boolean; width: number };
  /** 选区在原图坐标系里的尺寸（用于展示「选中多少像素」） */
  selectionPx: { w: number; h: number } | null;
  actions: EditAction[];
  busy: boolean;
  providerName: string;
  supportsSelection: boolean;
  onRun: (action: EditAction, prompt: string) => void;
  onClear: () => void;
}) {
  const [pending, setPending] = useState<EditAction | null>(null);
  const [prompt, setPrompt] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 选区变了就退出输入态，避免把上一个选区的描述用到新选区上
  useEffect(() => {
    setPending(null);
    setPrompt("");
  }, [anchor.x, anchor.y]);

  useEffect(() => {
    if (pending) inputRef.current?.focus();
  }, [pending]);

  const visible = actions.filter((a) => (selectionPx ? true : !a.needsSelection));

  const submit = () => {
    if (!pending) return;
    onRun(pending, prompt);
    setPending(null);
    setPrompt("");
  };

  return (
    <div
      className="sel-toolbar"
      // 底部停靠：不跟随选区，不再压住图片（遮挡问题的修复）
      style={{ left: "50%", bottom: 16, top: "auto", transform: "translateX(-50%)" }}
      // 工具条上的操作不应触发画布的框选/平移
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div className="sel-head">
        <span className="sel-size">
          {selectionPx
            ? `已选中 ${selectionPx.w} × ${selectionPx.h} 像素`
            : "未框选 · 将处理整张图"}
        </span>
        <button className="sel-close" onClick={onClear} title="取消选区 (Esc)">
          ✕
        </button>
      </div>

      {!pending ? (
        <>
          <div className="sel-actions">
            {visible.map((a) => (
              <button
                key={a.id}
                className="sel-action"
                disabled={busy}
                title={a.title}
                onClick={() => {
                  if (a.needsPrompt) {
                    setPending(a);
                    setPrompt("");
                  } else {
                    onRun(a, "");
                  }
                }}
              >
                {a.label}
              </button>
            ))}
          </div>
          <div className="sel-foot">
            由「{providerName}」处理 · <strong>图片会上传到该服务商</strong>
            {!supportsSelection && " · 该服务商不支持局部编辑"}
          </div>
        </>
      ) : (
        <>
          <div className="sel-prompt">
            <input
              ref={inputRef}
              value={prompt}
              placeholder={pending.promptPlaceholder || "描述你想怎么改…"}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && prompt.trim()) submit();
                if (e.key === "Escape") setPending(null);
              }}
              disabled={busy}
            />
            <button
              className="btn primary"
              disabled={busy || !prompt.trim()}
              onClick={submit}
            >
              生成
            </button>
            <button className="btn" disabled={busy} onClick={() => setPending(null)}>
              返回
            </button>
          </div>
          <div className="sel-foot">
            {pending.needsSelection
              ? "只会修改框选范围内，区域外保持不变"
              : "会重新生成整张图"}
          </div>
        </>
      )}
    </div>
  );
}
