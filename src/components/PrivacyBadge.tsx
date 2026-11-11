import React from "react";

/**
 * 隐私分级标记（B5 / A6 交付项）。
 *
 * 设计意图：PixMate 的核心卖点是「图片不出本机 / 免费开源」，但软件里同时有
 * 本地工具和云端 AI 两类能力 —— 用户容易把「本地去水印」和「AI 识别/改图」混为一谈，
 * 误以为所有功能都离线、都不花钱。这个徽标把**动作级**的隐私事实直接打在界面上：
 *   · local    —— 本地处理，图片不出本机（去水印 / 改尺寸 / 水印 / 调色 / 批量）
 *   · cloud    —— 需联网，图片会发送给所选模型服务商（AI 识别 / 对话 / 改图 / 生图）
 *   · optional —— 可选能力，配置了才用到（如本地 Ollama 这类免 Key 服务）
 *
 * 统一话术 + 统一配色（绿=本地安全 / 灰=需联网），让「本地优先」成为看得见的承诺，
 * 而不是写在文档里的口号。组件只做呈现，不含任何业务逻辑。
 */

type Variant = "local" | "cloud" | "optional";

const META: Record<Variant, { cls: string; icon: string; text: string }> = {
  // 🔒 取「锁」意象：图片留在自己机器上
  local: { cls: "pb-local", icon: "🔒", text: "本地处理 · 图片不出本机" },
  // ☁️ 取「云」意象：图片要离开本机
  cloud: { cls: "pb-cloud", icon: "☁️", text: "需联网 · 图片会发送给所选模型" },
  optional: { cls: "pb-optional", icon: "⚙", text: "可选能力 · 配置后才会用到" },
};

export default function PrivacyBadge({
  variant,
  children,
}: {
  variant: Variant;
  /** 自定义文案；不传则用该变体的默认话术 */
  children?: React.ReactNode;
}) {
  const m = META[variant];
  return (
    <span
      className={`privacy-badge ${m.cls}`}
      data-privacy={variant}
      title={m.text}
    >
      <span className="pb-icon" aria-hidden>
        {m.icon}
      </span>
      <span className="pb-text">{children ?? m.text}</span>
    </span>
  );
}
