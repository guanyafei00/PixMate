/**
 * 「一眼摘要」的解析 —— 把模型输出拆成「一句话摘要 + 正文」。
 *
 * 【为什么不做成强制 JSON】
 * 六份调研报告里的 ChatGPT 那份提出「识别结果应该是图片的第二层信息架构」
 * （一眼摘要 / 可编辑文字 / 对象卡片 / 问 AI）。但落地时有个坑：
 * 一旦要求模型返回 JSON，**不支持 JSON mode 的模型会直接失败**，
 * 而本产品的核心承诺是「任意 OpenAI 兼容模型都能用」（含本地 Ollama）。
 * 所以这里走「轻量行约定 + 兜底推断」：
 *   - 提示词请模型把摘要写在第一行（约定优于强制）
 *   - 解析不出来就从首句推断（老缓存、不听话的模型都能退化显示）
 *   - 最差情况摘要为 null，界面只是少一块，绝不报错
 *
 * 纯函数、无副作用 —— 这样可以被 scripts/summary-check.mjs 直接单测。
 */

export interface SplitResult {
  /** 一句话摘要；推断不出来时为 null（界面据此隐藏摘要块，而不是显示空白） */
  summary: string | null;
  /** 去掉摘要行之后的正文（原文一个字都不改；推断出的摘要不删原文） */
  body: string;
  /** 摘要的来源：方便排查「为什么这句成了摘要」 */
  from: "marker" | "first-sentence" | "none";
}

/** 摘要行的约定标记。中英文冒号都认，全角空格也清掉。 */
const MARKER_RE = /^\s*(?:一句话)?\s*摘要\s*[:：]\s*(.+)$/;

/** 句子结束符：中文句号/问号/叹号/分号，英文句点/问号/叹号 */
const SENTENCE_END = /[。！？；!?;]|\.(?=\s|$)/;

/** 太短就不需要摘要 —— 它本身就已经是摘要了 */
const MIN_BODY_FOR_SUMMARY = 60;

/** 从一段文本里取第一句；取不到就返回整段（截断到 60 字） */
function firstSentence(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  const m = oneLine.match(SENTENCE_END);
  if (m && m.index !== undefined && m.index > 0) {
    return oneLine.slice(0, m.index + 1);
  }
  return oneLine.length > 60 ? oneLine.slice(0, 60) + "…" : oneLine;
}

/**
 * 拆分。对输入的容忍度刻意做得很高 ——
 * 面对的是模型自由生成的文本，不是结构化数据。
 */
export function splitSummary(raw: string): SplitResult {
  const text = (raw ?? "").replace(/\r\n/g, "\n");
  const trimmed = text.trim();

  if (!trimmed) return { summary: null, body: "", from: "none" };

  const lines = text.split("\n");

  // ① 找带标记的摘要行：只在前 5 行里找 —— 摘要必须是"一眼"看到的，
  //    埋在正文中间的不算摘要（那种更可能是模型的小标题）
  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    const m = lines[i].match(MARKER_RE);
    if (m) {
      const summary = m[1].trim();
      if (!summary) continue;
      // 正文 = 去掉这一行后的其余内容（保留原有换行结构）
      const body = lines
        .filter((_, k) => k !== i)
        .join("\n")
        .replace(/^\n+/, "");
      return { summary, body, from: "marker" };
    }
  }

  // ② 没有标记（老缓存结果 / 模型没听话）→ 从首句推断。
  //    正文一个字都不改，避免"为了好看而丢内容"。
  if (trimmed.length < MIN_BODY_FOR_SUMMARY) {
    return { summary: null, body: text, from: "none" };
  }
  const firstLine = lines.find((l) => l.trim()) ?? "";
  const candidate = firstSentence(firstLine);
  // 首行本身就很长（比如是整段）时，说明它并不适合当摘要
  if (!candidate || candidate.length > 50) {
    return { summary: null, body: text, from: "none" };
  }
  /**
   * 推断出摘要后，把正文开头那一句**去掉**（无损去重）。
   * 否则摘要和正文第一句一模一样，读起来像重复渲染。
   * 注意这是"挪位置"不是"删内容"：那句话仍然显示在摘要区里，
   * 所以信息一点没少 —— 这与「正文一字不改」的原则并不冲突。
   */
  const body = text.trimStart().startsWith(candidate)
    ? text.trimStart().slice(candidate.length).replace(/^\s+/, "")
    : text;
  return { summary: candidate, body, from: "first-sentence" };
}
