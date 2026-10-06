/**
 * AI 编辑结果条（浮在主图区顶部）。
 *
 * 三条产品纪律落在这里：
 * 1. **绝不 spinner** —— 生成中显示具体文案 + 闪烁光标，并给一个真实的预期时长
 *    （万相官方数据约 5–15 秒），而不是一个没有信息的转圈。
 * 2. **绝不自动覆盖原文件** —— 结果只以「待保存」状态存在，必须显式点「另存为」。
 * 3. **结果有回执** —— 保存成功后明确告知存到哪了，而不是静默。
 */
export type EditPhase =
  | { kind: "idle" }
  | { kind: "working"; label: string }
  | {
      kind: "done";
      label: string;
      /**
       * 这一步是**本地**做的（加水印/改尺寸），不是 AI 改图。
       * 必须有这个标记：结果条原来一律写「AI 编辑结果」，把本地操作也说成 AI
       * 既是误导、也让人以为花了钱（而这些操作零成本、零上传）。
       */
      local?: boolean;
      requestId?: string;
      savedPath?: string;
      /** 保存失败之类的提示（结果本身仍然保留，不丢） */
      message?: string;
    }
  | { kind: "error"; label: string; message: string };

export default function EditResultBar({
  phase,
  comparing,
  canCompare,
  onToggleCompare,
  onSave,
  onDiscard,
  onRetry,
  versions = 0,
  versionCursor = 0,
  onSelectVersion,
}: {
  phase: EditPhase;
  comparing: boolean;
  canCompare: boolean;
  onToggleCompare: () => void;
  onSave: () => void;
  onDiscard: () => void;
  onRetry: () => void;
  /** 改图结果的版本数（不含原图） */
  versions?: number;
  /** 0 = 原图；i>0 = 第 i 版 */
  versionCursor?: number;
  onSelectVersion?: (i: number) => void;
}) {
  if (phase.kind === "idle") return null;

  if (phase.kind === "working") {
    return (
      <div className="edit-bar working">
        <span className="ai-dot" />
        <span className="edit-bar-text">
          正在生成：{phase.label}
        </span>
        <span className="edit-bar-note">通常需要 5–15 秒，请稍候</span>
        <span className="caret" />
      </div>
    );
  }

  if (phase.kind === "error") {
    return (
      <div className="edit-bar error">
        <span className="edit-bar-text edit-bar-multiline">
          ⚠️ {phase.message}
        </span>
        <button className="btn" onClick={onRetry}>
          重试
        </button>
        <button className="btn" onClick={onDiscard}>
          放弃
        </button>
      </div>
    );
  }

  return (
    <div className={phase.message ? "edit-bar error" : "edit-bar done"}>
      <span className="ai-dot" />
      {/*
        版本切换条（A/B 对比的唯一入口）。
        只在真的有 2 版以上才显示 —— 只有一版时它没有意义，反而占地方。
        依据：ChatGPT 报告引的研究——8.3 万条编辑请求里最好的编辑器只满足 33%，
        所以产品必须让人敢试、能比，而不是"改一次定生死"。
      */}
      {versions >= 1 && onSelectVersion && (
        <span className="ver-bar" role="tablist" aria-label="编辑版本">
          <button
            className={"ver-chip" + (versionCursor === 0 ? " active" : "")}
            onClick={() => onSelectVersion(0)}
            title="显示原图 ( [ )"
          >
            原图
          </button>
          {Array.from({ length: versions }, (_, k) => (
            <button
              key={k}
              className={"ver-chip" + (versionCursor === k + 1 ? " active" : "")}
              onClick={() => onSelectVersion(k + 1)}
              title={`显示第 ${k + 1} 版 ( ] )`}
            >
              {k + 1}
            </button>
          ))}
        </span>
      )}
      <span className="edit-bar-text">
        {phase.local ? "本地处理" : "AI 编辑结果"}（{phase.label}）· <strong>未保存</strong>
        {phase.savedPath && (
          <span className="edit-bar-saved"> · 已保存到 {phase.savedPath}</span>
        )}
        {phase.message && (
          <span className="edit-bar-warn"> · {phase.message}</span>
        )}
      </span>
      {canCompare && (
        <button className="btn" onClick={onToggleCompare}>
          {comparing ? "看结果" : "看原图"}
        </button>
      )}
      <button className="btn primary" onClick={onSave}>
        另存为…
      </button>
      <button className="btn" onClick={onDiscard} title="丢弃结果，回到原图">
        放弃
      </button>
    </div>
  );
}
