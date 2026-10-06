import { useEffect, useMemo, useRef, useState } from "react";
import { AnalyzeMode, MODE_LABELS, MODE_THINKING, toPlainText } from "../lib/prompts";
import { ChatMsg } from "../lib/api";
import { splitSummary } from "../lib/summary";
import ChatPanel from "./ChatPanel";

/**
 * 识别结果面板 —— 交互铁律（借鉴 Typeless/Wispr Flow 类语音输入软件）：
 * 1. 识别中绝不出现 spinner：显示具体状态文案 + 闪烁光标；
 * 2. 结果到达用打字机流式浮现（约 18ms/2 字符，符合 15–25ms/字符 规范）；
 * 3. 用户一旦点击/聚焦/输入，立即跳过动画补全全文（不打扰编辑）；
 * 4. 没配模型时不甩红色报错——看图器照常工作，只给一条温和引导。
 *
 * 本次新增：
 * - 顶部模式切换「理解图片 / 提取文字」。后者是调研认定的护城河
 *   （市面 OCR 输出普遍是 unformatted blob，表格/列表/多栏全丢），
 *   此前只有一句 prompt 藏在主进程里，没有入口 —— 现在是一等功能。
 * - 「复制纯文本」：保排版的 Markdown 贴进 Word/微信会变成一堆符号，
 *   所以复制给两个口径：原样、去符号。
 * - instant：命中缓存的结果不再重放打字机动画（重复动画 = 视觉噪音）。
 */
export default function ResultPanel({
  result,
  loading,
  error,
  imageName,
  needSetup,
  hasImage,
  mode,
  instant,
  onModeChange,
  onSetup,
  onRetry,
  onAnalyze,
  modelName,
  chat,
}: {
  result: string;
  loading: boolean;
  error: string | null;
  imageName?: string;
  needSetup?: boolean;
  hasImage?: boolean;
  mode: AnalyzeMode;
  instant?: boolean;
  onModeChange: (m: AnalyzeMode) => void;
  onSetup?: () => void;
  /**
   * 用户主动发起识别。
   * 默认不开自动识别之后，这是"开始用 AI"的唯一入口 ——
   * 所以它必须显眼、且说清代价（会调一次模型、把图发给服务商）。
   */
  onAnalyze?: () => void;
  /** 当前识别模型名（用于在空态里说清"会发给谁"） */
  modelName?: string;
  onRetry?: () => void;
  /** mode === "chat" 时必传：对话的状态与回调 */
  chat?: {
    messages: ChatMsg[];
    thinking: boolean;
    error: string | null;
    disabled: boolean;
    canEdit: boolean;
    onSend: (text: string) => void;
    onEditWithPrompt: (prompt: string) => void;
    /** 从摘要卡片跳去对话（「问 AI」入口 —— ChatGPT 四层结构里的最后一层） */
    onAsk?: () => void;
  };
}) {
  const [copied, setCopied] = useState<"" | "md" | "plain">("");
  const [editable, setEditable] = useState(result);
  const typingTimer = useRef<number | null>(null);

  /**
   * 「一眼摘要」：结果拆成「摘要 + 正文」。
   *
   * ⚠️ OCR 模式**必须原样透传**，绝不能套用摘要逻辑 ——
   * OCR 的产出是逐字提取的原文，任何"取首句当摘要"都会把用户要的文字从正文里挪走，
   * 属于数据损坏（不是显示问题）。所以这里按模式分流。
   */
  const split = useMemo(
    () =>
      mode === "ocr"
        ? { summary: null, body: result, from: "none" as const }
        : splitSummary(result),
    [mode, result]
  );

  // 新结果到达 → 打字机流式填充可编辑文本（命中缓存则直接全量显示）
  useEffect(() => {
    setCopied("");
    if (typingTimer.current) window.clearTimeout(typingTimer.current);
    // 打字机动画跑在「正文」上；摘要立即出现 ——
    // 这正是「一眼摘要」想要的时序：先给结论，再补细节
    const target = split.body;
    if (!target) {
      setEditable("");
      return;
    }
    if (instant) {
      setEditable(target);
      return;
    }
    let i = 0;
    const step = () => {
      i = Math.min(target.length, i + 2);
      setEditable(target.slice(0, i));
      if (i < target.length) {
        typingTimer.current = window.setTimeout(step, 18);
      }
    };
    typingTimer.current = window.setTimeout(step, 18);
    return () => {
      if (typingTimer.current) window.clearTimeout(typingTimer.current);
    };
  }, [split.body, instant]);

  // 用户介入（聚焦/键盘）→ 立即补全全文，动画让位于编辑
  const skipTyping = () => {
    if (typingTimer.current) window.clearTimeout(typingTimer.current);
    if (split.body && editable !== split.body) setEditable(split.body);
  };

  const copy = async (kind: "md" | "plain") => {
    const text = kind === "plain" ? toPlainText(editable) : editable;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied(""), 1500);
    } catch {
      setCopied("");
    }
  };

  const showEmptyHint = !loading && !error && !result && !(needSetup && hasImage);

  return (
    <aside className="result-panel">
      <div className="result-head">
        <span className="result-title">
          <span className="ai-dot" /> AI 识别
        </span>
        {imageName && <span className="result-file">{imageName}</span>}
      </div>

      {/* 模式切换：护城河的入口。浏览键与图片操作一概不受影响。 */}
      <div className="mode-tabs" role="tablist">
        {(Object.keys(MODE_LABELS) as AnalyzeMode[]).map((m) => (
          <button
            key={m}
            role="tab"
            aria-selected={mode === m}
            className={"mode-tab" + (mode === m ? " active" : "")}
            disabled={!hasImage}
            onClick={() => onModeChange(m)}
            title={
              m === "ocr"
                ? "只提取文字，保留表格/列表/多栏排版"
                : "整体理解：主体、场景、颜色、构图、用途"
            }
          >
            {MODE_LABELS[m]}
          </button>
        ))}
      </div>

      <div className="result-body">
        {/* 对话模式：整个面板换成聊天界面（有自己的等待态与报错展示） */}
        {mode === "chat" && chat && (
          <ChatPanel
            messages={chat.messages}
            thinking={chat.thinking}
            error={chat.error}
            disabled={chat.disabled}
            hasImage={Boolean(hasImage)}
            canEdit={chat.canEdit}
            onSend={chat.onSend}
            onEditWithPrompt={chat.onEditWithPrompt}
          />
        )}

        {mode !== "chat" && loading && (
          <div className="thinking">
            {MODE_THINKING[mode]}
            <span className="caret" />
          </div>
        )}

        {mode !== "chat" && !loading && error && (
          <>
            <div className="error-box">⚠️ {error}</div>
            {onRetry && (
              <button className="btn retry-btn" onClick={onRetry}>
                重试
              </button>
            )}
          </>
        )}

        {/* 没配模型：安静的纯看图模式，只给一条温和引导 */}
        {mode !== "chat" && !loading && !error && needSetup && hasImage && (
          <div className="setup-guide">
            <div className="setup-title">当前是「纯看图」模式</div>
            <p>
              图片可以正常查看、缩放、翻页。想让 AI
              自动识别内容、提取图中的文字，配置一个视觉模型即可（支持任意 OpenAI
              兼容服务，也有本地 Ollama 的离线方案）。
            </p>
            {onSetup && (
              <button className="btn primary" onClick={onSetup}>
                去设置模型
              </button>
            )}
          </div>
        )}

        {mode !== "chat" && showEmptyHint && !hasImage && (
          <div className="placeholder">打开图片后，识别结果会显示在这里。</div>
        )}

        {/* 有图但还没识别 —— 这里不再是"空着等"，而是**让用户选**：
            要不要用 AI、用哪种、以及代价是什么。默认不自动识别，所以这屏是常态。 */}
        {mode !== "chat" && showEmptyHint && hasImage && (
          <div className="ai-choose">
            <div className="ai-choose-title">这张图还没有识别</div>
            <button className="btn primary ai-choose-go" onClick={onAnalyze}>
              识别这张图
            </button>
            <p className="ai-choose-hint">
              当前用「{MODE_LABELS[mode]}」——换上面的标签可以改成别的用法：
              <br />
              <strong>理解图片</strong> 描述画面内容 ·{" "}
              <strong>提取文字</strong> 保留排版的 OCR ·{" "}
              <strong>对话</strong> 就这张图追问
            </p>
            <p className="ai-choose-cost">
              点一次会调用 1 次模型{modelName ? `（${modelName}）` : ""}，
              图片会发送给该服务商；结果会缓存，同一张图来回翻不会重复调用。
            </p>
          </div>
        )}

        {/* 一眼摘要：先给结论，正文随后流式补上。
            只读展示，不参与编辑/复制 —— 可编辑的正文仍是唯一真源，语义不变。 */}
        {mode !== "chat" && !loading && !error && split.summary && (
          <div className="summary-card" title={`摘要来源：${split.from}`}>
            <div className="summary-text">{split.summary}</div>
            {chat?.onAsk && (
              <button
                className="summary-ask"
                onClick={chat.onAsk}
                title="就这张图继续追问"
              >
                追问
              </button>
            )}
          </div>
        )}

        {mode !== "chat" && !loading && !error && result && (
          <textarea
            className="result-edit"
            value={editable}
            onChange={(e) => {
              skipTyping();
              setEditable(e.target.value);
            }}
            onFocus={skipTyping}
            onKeyDown={skipTyping}
            spellCheck={false}
            placeholder={
              mode === "ocr"
                ? "提取到的文字会显示在这里，可手动修正…"
                : "识别结果可在此手动编辑…"
            }
          />
        )}
      </div>

      {mode !== "chat" && (
        <div className="result-foot">
          {result && !loading && onRetry && (
            <button className="btn" onClick={onRetry} title="用当前模式重新识别">
              重新识别
            </button>
          )}
          {mode === "ocr" && result && !loading && (
            <button
              className="btn"
              disabled={!editable}
              onClick={() => copy("plain")}
              title="去掉 Markdown 符号，便于粘贴到 Word / 微信 / 表格"
            >
              {copied === "plain" ? "已复制 ✓" : "复制纯文本"}
            </button>
          )}
          <button className="btn primary" disabled={!editable} onClick={() => copy("md")}>
            {copied === "md" ? "已复制 ✓" : "复制"}
          </button>
        </div>
      )}
    </aside>
  );
}
