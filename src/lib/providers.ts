/**
 * 模型服务商预设清单。
 *
 * 为什么默认国产：中文 OCR 场景（竖排/艺术字/表格/票据）国产模型显著优于海外模型，
 * 价格仅 1/5–1/10（月 3 万张识别约 ¥0.42，GPT-4o 约 $1.52）——
 * 这条结论来自三方案交叉调研里的成本实测表。
 *
 * 注意：价格波动大（如 Gemini 2.5 Flash 输出价半年涨 4 倍），后续应把本清单
 * 外置为可热更新的 models.json；当前以代码常量保证类型安全。
 *
 * `consoleUrl` 是「去哪儿拿 Key」——原实现只告诉用户「Key 在百炼控制台申请」，
 * 但没给入口。对不熟悉云控制台的用户，这是第一道真实门槛。
 */
export interface ProviderPreset {
  id: string;
  name: string;
  base_url: string;
  model: string;
  note?: string;
  /** 申请 API Key 的控制台地址 */
  consoleUrl?: string;
  /** 是否含免费额度档（新手可零成本试通） */
  free?: boolean;
  /**
   * 是否是需要本地自建的服务（Ollama / LM Studio）。
   * 这类服务通常**不需要 API Key** —— 选中预设时顺带把 local_no_key 打开，
   * 否则空 Key 会被当成「还没配置」，本地模型实际用不了。
   * 打在预设上而不是靠地址猜，是为了连局域网上的本地服务也能正确识别。
   */
  local?: boolean;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "gateway",
    name: "局域网网关 · Gateway（免费，推荐）",
    base_url: "http://127.0.0.1:8000/v1",
    model: "your-vision-model",
    note:
      "局域网内的网关（本地网关）。实测结果：your-vision-model 最快（约 3 秒）且描述最细，" +
      "your-vision-model-flash / your-model-2.0-flash 也可用。网关模型很多，只有这几个能看图；" +
      "部分模型可能缺授权或超时，以实测为准。",
    free: true,
  },
  {
    id: "qwen",
    name: "阿里 Qwen-VL（云端，需自备 Key）",
    base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-vl-plus",
    note: "中文识别强，价格约为 GPT-4o 的 1/30；新用户通常有免费额度",
    consoleUrl: "https://bailian.console.aliyun.com/",
  },
  {
    id: "doubao",
    name: "字节豆包 1.5 Vision Pro",
    base_url: "https://ark.cn-beijing.volces.com/api/v3",
    model: "doubao-1-5-vision-pro-32k",
    note: "火山方舟控制台开通；也可填你的接入点 ID（ep-xxx）",
    consoleUrl: "https://console.volcengine.com/ark",
  },
  {
    id: "glm",
    name: "智谱 GLM-4V Flash（云端免费档）",
    base_url: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4v-flash",
    note: "glm-4v-flash 免费 —— 云端零成本先跑通可以选这个",
    consoleUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    free: true,
  },
  {
    id: "kimi",
    name: "Moonshot Kimi Vision",
    base_url: "https://api.moonshot.cn/v1",
    model: "moonshot-v1-8k-vision-preview",
    consoleUrl: "https://platform.moonshot.cn/console/api-keys",
  },
  {
    id: "openai",
    name: "OpenAI GPT-4o",
    base_url: "https://api.openai.com/v1",
    model: "gpt-4o",
    note: "能力强但贵约 30 倍；官方域名不允许浏览器跨域，浏览器预览下不可用",
    consoleUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "ollama",
    name: "本地 Ollama（离线 / 零上传）",
    base_url: "http://127.0.0.1:11434/v1",
    model: "qwen2.5vl:7b",
    note: "隐私最强、图片不出本机；需先 ollama pull 一个视觉模型（如 qwen2.5vl / llava）",
    consoleUrl: "https://ollama.com/library/qwen2.5vl",
    local: true,
  },
  {
    id: "lmstudio",
    name: "本地 LM Studio",
    base_url: "http://127.0.0.1:1234/v1",
    model: "（填写 LM Studio 已加载的视觉模型名）",
    note: "需在 LM Studio 里开启本地服务器",
    consoleUrl: "https://lmstudio.ai/",
    local: true,
  },
];
