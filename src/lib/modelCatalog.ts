/**
 * 模型清单的分组与「能不能看图」的推断。
 *
 * 【为什么需要这两件事】
 * 云端 /v1/models 拉下来动辄一两百个模型，平铺一长条根本没法选：
 *   ① 用户不知道哪个是哪个家的 → 按厂商分组
 *   ② **这个软件只能看图**，纯文本模型混在里面就是噪音 → 标出可看图的
 *      （聊天/嵌入/语音/绘图这些模型填进来只会得到一堆报错）
 *
 * 【关于「可看图」的准确性 —— 必须如实说明】
 * `/v1/models` 只返回模型名，**不返回能力**。所以这里是**按命名规则推断**，
 * 不是权威结论。因此：
 *   · 只把它当**提示**（界面明说"按名字推断"），不隐藏任何模型、不禁用任何选项
 *   · 认不出来的一律不标（宁可漏标，不可错标成"可看图"让用户踩坑）
 *   · 明确是嵌入/语音/绘图/重排这类**非对话模型**的，单独标出来
 */

/* ------------------------------------------------------------------ */
/* 厂商分组                                                           */
/* ------------------------------------------------------------------ */

/**
 * 分组规则表。**顺序敏感：先匹配到的赢**。
 * 所以具体家族写在前面，宽泛的写在后面；兜底放最后。
 */
const VENDOR_RULES: { re: RegExp; group: string }[] = [
  // 自建 / 网关（本项目自己的预设）
  { re: /^(gateway|cliproxy|one-api|new-api|llm-gateway)/i, group: "自建网关" },

  // 国产
  { re: /^(qwen|qvq|qwq|tongyi|wanx|-?vl)/i, group: "阿里通义千问" },
  { re: /^(glm|charglm|cogview|cogvideo)/i, group: "智谱 GLM" },
  { re: /^(moonshot|kimi)/i, group: "月之暗面 Kimi" },
  { re: /^(doubao|seed|skylark)/i, group: "字节豆包" },
  { re: /^deepseek/i, group: "深度求索 DeepSeek" },
  { re: /^(ernie|wenxin)/i, group: "百度文心" },
  { re: /^hunyuan/i, group: "腾讯混元" },
  { re: /^(spark|generalv)/i, group: "讯飞星火" },
  { re: /^(step-|stepfun)/i, group: "阶跃星辰" },
  { re: /^(yi-|01-ai)/i, group: "零一万物" },
  { re: /^(abab|minimax)/i, group: "MiniMax" },
  { re: /^baichuan/i, group: "百川" },

  // 海外
  { re: /^(gpt|chatgpt|o1|o3|o4|davinci|text-embedding)/i, group: "OpenAI" },
  { re: /^claude/i, group: "Anthropic Claude" },
  { re: /^(gemini|gemma|palm)/i, group: "Google" },
  { re: /^(llama|meta-llama|codellama)/i, group: "Meta Llama" },
  { re: /^(mistral|mixtral|pixtral|codestral|magistral)/i, group: "Mistral" },
  { re: /^(phi|phi-)/i, group: "微软 Phi" },
  { re: /^(command|cohere|embed-)/i, group: "Cohere" },
  { re: /^(grok)/i, group: "xAI Grok" },

  // 本地开源视觉模型（Ollama / LM Studio 常见）
  { re: /^(llava|bakllava|moondream|minicpm|cogvlm|internvl|bunny|obsidian)/i, group: "本地开源视觉模型" },

  // 带斜杠的第三方托管（nvidia/xxx、meta-llama/xxx 等）
  { re: /^nvidia\//i, group: "NVIDIA 托管" },
  { re: /^(openrouter|together|groq|fireworks)\//i, group: "第三方托管" },
];

/** 兜底分组名 */
const FALLBACK_GROUP = "其他";

export interface ModelGroup {
  group: string;
  models: string[];
}

/** 取厂商名（导出是为了可单测） */
export function vendorOf(id: string): string {
  const s = String(id || "").trim();
  if (!s) return FALLBACK_GROUP;
  for (const r of VENDOR_RULES) {
    if (r.re.test(s)) return r.group;
  }
  return FALLBACK_GROUP;
}

/**
 * 分组。保持「组内原有顺序」，组的顺序按**首次出现**决定 ——
 * 这样服务商自己排的序（通常把主力模型放前面）不会被我们打乱。
 */
export function groupModels(ids: string[]): ModelGroup[] {
  const order: string[] = [];
  const bucket = new Map<string, string[]>();
  for (const raw of ids) {
    const id = String(raw || "").trim();
    if (!id) continue;
    const g = vendorOf(id);
    if (!bucket.has(g)) {
      bucket.set(g, []);
      order.push(g);
    }
    bucket.get(g)!.push(id);
  }
  return order.map((g) => ({ group: g, models: bucket.get(g)! }));
}

/* ------------------------------------------------------------------ */
/* 能力推断                                                           */
/* ------------------------------------------------------------------ */

/**
 * 明确**不是**对话模型的（嵌入 / 语音 / 绘图 / 重排 / 审核）。
 * 这些混进来最容易被误选，单独标出来。
 */
const NON_CHAT_RE =
  /(embedding|embed|rerank|reranker|whisper|tts|speech|audio|voice|image-gen|dall-e|dalle|stable-diffusion|sd3|flux|midjourney|moderation|guard|ocr-model|transcribe)/i;

/**
 * 看起来**能看图**的模型（按命名规则推断）。
 *
 * 判断偏保守：认不出来就返回 false（不标）。
 * 宁可漏标让用户自己试，也不要把纯文本模型标成"可看图"——
 * 那种误导会让用户以为软件坏了。
 */
const VISION_PATTERNS: RegExp[] = [
  // 通义：qwen-vl / qwen2.5-vl / qwen2.5vl / qwen3-vl / qvq
  /qwen[\d.]*-?vl/i,
  /qwen[\d.]*vl/i,
  /^qvq/i,
  // OpenAI：gpt-4o / gpt-4.1 / gpt-4-turbo / gpt-4-vision / o3 / o4
  /^gpt-4o/i,
  /^gpt-4\.1/i,
  /^gpt-4-turbo/i,
  /^gpt-4-vision/i,
  /^gpt-5/i,
  /^o[34](-|$)/i,
  // Anthropic：claude 3 起都带视觉
  /^claude-3/i,
  // Claude 4+ 的命名是 claude-sonnet-4-xxx / claude-opus-4-x —— 版本号不在第二位，
  // 所以只写 /^claude-[4-9]/ 会漏（实测漏掉了 claude-sonnet-4-20250514）
  /^claude-[a-z]+-[3-9]/i,
  /^claude-[4-9]/i,
  // Google：gemini 1.5 起都带视觉
  /^gemini/i,
  // 智谱：glm-4v / glm-4.1v / glm-4.5v
  /glm-[\d.]+v/i,
  // 字节：doubao-*-vision
  /doubao.*vision/i,
  // Kimi：moonshot-*-vision
  /vision-preview/i,
  /kimi.*vision/i,
  // 本地开源视觉模型
  /^(llava|bakllava|moondream|minicpm-v|cogvlm|internvl|bunny)/i,
  /^(phi-3-vision|phi-4-multimodal|phi-3\.5-vision)/i,
  // 其他国产视觉
  /^(step-1v|step-1o)/i,
  /^yi-vision/i,
  /ernie.*vl/i,
  /hunyuan.*vision/i,
  /spark.*vision/i,
  /^pixtral/i,
  /^(grok-.*vision|grok-[2-9])/i,
  // 本项目自建网关上的视觉模型（预设说明里实测过 your-vision-model 等能看图）
  /^gateway/i,
];

/** 按名字推断「这个模型能不能看图」。只是提示，不是权威结论。 */
export function isLikelyVision(id: string): boolean {
  const s = String(id || "").trim();
  if (!s) return false;
  if (NON_CHAT_RE.test(s)) return false; // 非对话模型一律不算
  return VISION_PATTERNS.some((re) => re.test(s));
}

/** 是不是明显不属于对话模型（嵌入/语音/绘图/重排） */
export function isNonChat(id: string): boolean {
  return NON_CHAT_RE.test(String(id || ""));
}

/* ------------------------------------------------------------------ */
/* 筛选                                                               */
/* ------------------------------------------------------------------ */

/**
 * 过滤 + 重新分组。`visionOnly` 打开时只留可看图的 ——
 * 这是这个软件最常用的一档（几十上百个模型里通常只剩十来个能用的）。
 */
export function filterModels(
  ids: string[],
  opts: { query?: string; visionOnly?: boolean } = {}
): ModelGroup[] {
  const q = (opts.query || "").trim().toLowerCase();
  const kept = ids.filter((id) => {
    const s = String(id || "").trim();
    if (!s) return false;
    // 搜索同时匹配**模型名**与**厂商名** —— 用户通常记不住 qwen-vl-plus，
    // 但记得住"通义"。只匹配模型名的话，这个搜索框基本没用。
    if (q && !(s.toLowerCase().includes(q) || vendorOf(s).toLowerCase().includes(q))) {
      return false;
    }
    if (opts.visionOnly && !isLikelyVision(s)) return false;
    return true;
  });
  return groupModels(kept);
}

/** 统计可看图的个数（用于界面提示） */
export function countVision(ids: string[]): number {
  return ids.filter((id) => isLikelyVision(id)).length;
}
