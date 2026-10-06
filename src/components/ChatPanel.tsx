import { useEffect, useRef, useState } from "react";
import { ChatMsg } from "../lib/api";

/**
 * 「对话」面板：和 AI 围绕当前图片多轮交谈。
 *
 * 需求来自用户：想通过对话来编辑图片。实现上是两层：
 *   ① 问图 —— 多轮带图对话，模型能看到当前图片（这是现在就能用的部分）；
 *   ② 改图 —— 视觉对话模型只会「说」不会「画」，像素级修改必须走图像编辑通道
 *      （百炼万相 / OpenAI 图像）。所以这里给了「按这句话去改图」的桥：
 *      对话里把需求聊清楚 → 一键把它作为改图描述交给编辑流程。
 *
 * 交互纪律与 ResultPanel 一致：等待中不出现 spinner，用具体状态文案 + 闪烁光标。
 */
export default function ChatPanel({
  messages,
  thinking,
  error,
  disabled,
  hasImage,
  canEdit,
  onSend,
  onEditWithPrompt,
}: {
  messages: ChatMsg[];
  /** 正在等模型回复 */
  thinking: boolean;
  error: string | null;
  /** 没配模型 / 没图片时禁用输入 */
  disabled: boolean;
  hasImage: boolean;
  /** 当前服务商支持图像编辑时才有「按这句话去改图」 */
  canEdit: boolean;
  onSend: (text: string) => void;
  /** 把某句话作为改图描述，交给编辑流程 */
  onEditWithPrompt: (prompt: string) => void;
}) {
  const [text, setText] = useState("");
  const [copied, setCopied] = useState<number | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // 新消息到达 / 回复流式追加时，滚到底部
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, thinking, messages[messages.length - 1]?.content]);

  const send = () => {
    const t = text.trim();
    if (!t || thinking || disabled) return;
    onSend(t);
    setText("");
    inputRef.current?.focus();
  };

  const copyMsg = async (i: number, content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(i);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setCopied(null);
    }
  };

  return (
    <div className="chat-panel">
      <div className="chat-body" ref={bodyRef}>
        {messages.length === 0 && (
          <div className="chat-empty">
            <p>有什么想问这张图的，或者想让我怎么改，直接说。</p>
            <p className="chat-hint">
              例如：「图里有什么文字？」「把背景换成傍晚的海边」「去掉左下角的水印」。
            </p>
            <p className="chat-hint dim">
              说明：对话里可以聊清楚要改什么；真正的像素级修改会交给图像编辑通道，
              聊好后点回复下方的「按这句话去改图」即可。
            </p>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={"chat-msg " + m.role}>
            <div className="chat-role">{m.role === "user" ? "我" : "AI"}</div>
            <div className="chat-bubble">
              <div className="chat-text">{m.content}</div>
              {m.role === "assistant" && (
                <div className="chat-msg-actions">
                  <button className="chat-mini" onClick={() => copyMsg(i, m.content)}>
                    {copied === i ? "已复制 ✓" : "复制"}
                  </button>
                  {canEdit && !thinking && (
                    <button
                      className="chat-mini primary"
                      onClick={() => onEditWithPrompt(m.content)}
                      title="把这条回复整理成改图描述，交给图像编辑"
                    >
                      按这句话去改图
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}

        {thinking && (
          <div className="chat-msg assistant">
            <div className="chat-role">AI</div>
            <div className="chat-bubble">
              <div className="chat-text thinking">
                正在看图并思考你的问题
                <span className="caret" />
              </div>
            </div>
          </div>
        )}

        {error && <div className="error-box">⚠️ {error}</div>}
      </div>

      <div className="chat-input-row">
        <textarea
          ref={inputRef}
          className="chat-input"
          value={text}
          rows={2}
          disabled={disabled}
          placeholder={
            !hasImage
              ? "先打开一张图片，对话会围绕它进行"
              : disabled
                ? "先在「设置」里配置模型，才能对话"
                : "问问这张图，或描述你想怎么改…（Enter 发送，Shift+Enter 换行）"
          }
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button
          className="btn primary chat-send"
          disabled={disabled || thinking || !text.trim()}
          onClick={send}
        >
          发送
        </button>
      </div>
    </div>
  );
}
