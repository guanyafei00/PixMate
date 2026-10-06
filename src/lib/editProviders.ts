/**
 * 图像编辑服务商（云端）。
 *
 * 【为什么「编辑」不能沿用「换模型」那套抽象】
 * 视觉识别有事实标准：OpenAI 的 /chat/completions + image_url，所有服务商都兼容，
 * 所以 `api.ts` 能用「改 base_url + model 两个字符串」解决。
 * 但**图像编辑没有这个标准**——各家请求体、返回结构、同步/异步模型都不一样。
 * 硬凑一个「通用编辑抽象」只会得到一个谁都不好用的东西。
 *
 * 所以这里如实拆成两个具名适配器，各自把细节包干净：
 *   - dashscope：阿里云百炼「万相-通用图像编辑」，异步任务 + 轮询。
 *     支持真正的局部重绘（description_edit_with_mask），是本项目「框选编辑」的主力。
 *   - openai   ：OpenAI 官方 /v1/images/edits（multipart）。
 *     顺带兼容大量第三方 OpenAI 格式中转站。
 *
 * 【关于「本地优先」承诺】
 * 编辑走云端 = 这张图会上传到服务商。这是产品定位（本地优先）的一处让步，
 * 用户已明确决定采用云端（2026-09-18）。因此 UI 上必须**明说会上传**，
 * 且**绝不自动覆盖原文件**。本地模型路线（rembg/Real-ESRGAN/LaMa）留作后续
 * 的「隐私强化模式」，见 调研与决策依据.md §5.3。
 */

export type EditProviderId = "dashscope" | "openai";

/**
 * mask 图的编码方式 —— 两家语义正好相反，搞错会「改错地方」：
 * - dashscope：**白色 = 待编辑**，黑色 = 保留（必须纯白 [255,255,255] / 纯黑 [0,0,0]）
 * - openai   ：**透明 = 待编辑**，不透明 = 保留
 */
export type MaskMode = "ds-white" | "oa-alpha";

export interface EditProviderPreset {
  id: EditProviderId;
  name: string;
  /** 服务根地址，适配器会自行拼具体路径；只取 origin，多带路径会被忽略 */
  base_url: string;
  model: string;
  note: string;
  consoleUrl?: string;
  /** 该服务商的遮罩语义 */
  maskMode: MaskMode;
}

export const EDIT_PROVIDER_PRESETS: EditProviderPreset[] = [
  {
    id: "dashscope",
    name: "阿里云百炼 · 万相通用图像编辑（推荐）",
    base_url: "https://dashscope.aliyuncs.com",
    model: "wanx2.1-imageedit",
    note:
      "支持框选局部重绘、指令编辑、超分、去水印。0.14 元/张，新用户通常有免费额度；" +
      "与默认的 Qwen-VL 用同一个百炼 Key，不用再申请第二个。注意仅华北2（北京）地域可用。",
    consoleUrl: "https://bailian.console.aliyun.com/",
    maskMode: "ds-white",
  },
  {
    id: "openai",
    name: "OpenAI 官方 /images/edits（也兼容各中转站）",
    base_url: "https://api.openai.com/v1",
    model: "gpt-image-1",
    note:
      "走 multipart 的 /v1/images/edits，只支持「按描述改」，没有超分/去水印这类专用功能。" +
      "官方域名不允许浏览器跨域，浏览器预览模式下不可用。",
    consoleUrl: "https://platform.openai.com/api-keys",
    maskMode: "oa-alpha",
  },
];

export function getEditProvider(id: EditProviderId | undefined): EditProviderPreset {
  return (
    EDIT_PROVIDER_PRESETS.find((p) => p.id === id) ?? EDIT_PROVIDER_PRESETS[0]
  );
}

/**
 * 从用户填的地址里取 origin。
 * 用户很可能把上面视觉模型的兼容地址（`.../compatible-mode/v1`）直接粘过来，
 * 而编辑接口的路径完全不同 —— 所以这里只取 origin，不猜路径。
 */
export function normalizeOrigin(baseUrl: string, fallback: string): string {
  const raw = (baseUrl || "").trim() || fallback;
  try {
    return new URL(raw).origin;
  } catch {
    // 用户可能填了不带协议的地址
    try {
      return new URL("https://" + raw).origin;
    } catch {
      return fallback;
    }
  }
}
