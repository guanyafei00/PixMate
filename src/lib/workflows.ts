/**
 * 场景预设：让同一个工具服务三类人，而不是做三个产品。
 *
 * 【为什么不是「做三个版本」】
 * 用户要求「自媒体 / 电商 / 教师办公 三个都做」。如果真做三套，就是三份维护成本，
 * 而且会背离「秒开、干净」的核心主张（六份调研里反复警告的"功能堆积"）。
 *
 * 但如果仔细看这三类人的动作，会发现它们**共用同一套底层能力**：
 *   去水印、按描述改局部、换背景、OCR 提取 —— 差别只在
 *   ① 用哪些动作、什么顺序  ② 说什么话（提示词）  ③ 哪个"非 AI 的小工具"最刚需
 * 所以我们做的是**一个场景层**：同一套引擎，三套入口与话术。
 *
 * 【本地工具为什么单独列出来】
 * 加水印、改尺寸这类事，**用 AI 做是错的**：本地 canvas 几毫秒就能完成，
 * 走云端要 0.14 元/张 + 几秒等待 + 把图上传。所以它们被明确标成「本地」，
 * 不走 AI 链路，也不花钱。这也让"没配模型时仍是好用的纯看图器"这条主张更结实。
 */

export type SceneId = "general" | "creator" | "ecommerce" | "education" | "finance";

/** 本地工具（不调用 AI、不花钱、不上传） */
export type LocalToolId =
  | "watermark"
  | "resize"
  | "exportText"
  | "inpaint"
  | "geometry"
  | "adjust"
  | "batch"
  | "platform";

export interface PromptPreset {
  /** 按钮上的短文案 */
  label: string;
  /** 点一下填进输入框的完整话术 */
  text: string;
}

export interface Scene {
  id: SceneId;
  name: string;
  /** 服务谁 —— 界面上一句话说明，避免用户选错 */
  audience: string;
  /**
   * 这个场景优先显示的动作 id，**顺序即优先级**。
   * 不在列表里的动作会被排到后面（而不是隐藏 —— 用户随时可能用到）。
   */
  actions: string[];
  /** 常用话术：点一下就有合适的话，不用自己想怎么说 */
  presets: PromptPreset[];
  /** 该场景最刚需的本地工具 */
  localTools: LocalToolId[];
}

export const SCENES: Scene[] = [
  {
    id: "general",
    name: "通用",
    audience: "不确定时用这个：所有动作都显示，不预设话术",
    actions: ["replace", "whole", "erase", "dewatermark", "sharpen"],
    presets: [],
    localTools: ["batch", "geometry", "watermark", "resize", "inpaint", "adjust", "exportText"],
  },
  {
    id: "creator",
    name: "自媒体 / 内容",
    audience: "做公众号、小红书、视频号：日常处理截图、二次加工素材",
    // 顺序是有讲究的：自媒体最高频的是「改掉图里的字」「去别人的水印」「提文案」
    actions: ["replace", "dewatermark", "erase", "whole", "sharpen"],
    presets: [
      { label: "换掉图中文字", text: "把这段文字改成「这里写新文案」，字体样式和背景保持不变" },
      { label: "去掉这块内容", text: "移除这块区域里的内容，用周围的背景自然补全" },
      { label: "改成某平台封面比例", text: "保持主体不变，把画面扩展成 3:4 竖版比例，补全缺失的背景" },
      { label: "统一成干净背景", text: "把背景处理成干净简洁的纯色，突出主体" },
    ],
    localTools: ["geometry", "batch", "resize", "watermark", "inpaint", "adjust", "exportText"],
  },
  {
    id: "ecommerce",
    name: "电商 / 商品图",
    audience: "淘宝京东拼多多卖家、小店主：商品图换背景、去杂、加水印",
    // 电商最高频是「换背景」和「去杂物」，加水印几乎每张都要
    actions: ["whole", "replace", "erase", "sharpen"],
    presets: [
      { label: "换成纯白主图背景", text: "把整张图的背景换成纯白色，商品本身保持完全不变" },
      { label: "换成生活场景", text: "把背景换成自然的家居使用场景，商品本身保持完全不变、光照方向一致" },
      { label: "去掉画面里的杂物", text: "移除这块区域里的杂物，用周围背景自然补全，不要留下痕迹" },
      { label: "补全/摆正商品", text: "把商品摆正居中，补全边缘被裁掉的部分，保持商品外观不变" },
    ],
    localTools: ["watermark", "geometry", "inpaint", "resize", "adjust", "exportText"],
  },
  {
    id: "education",
    name: "教师 / 办公",
    audience: "试卷讲义、表格单据、资料整理：重点在把图里的字取出来",
    // 教师场景以"取字"为主，AI 改图只是辅助
    actions: ["dewatermark", "erase", "replace", "whole"],
    presets: [
      { label: "去掉试卷上的水印", text: "" },
      { label: "擦掉手写痕迹", text: "移除这块区域里的手写笔迹，还原成印刷体背景" },
    ],
    localTools: ["exportText", "geometry", "resize", "watermark", "inpaint", "adjust"],
  },
  {
    id: "finance",
    name: "票据 / 财务单据",
    audience: "发票、报销单、快递单、对账单：把票面信息整理成能用 Excel 打开的表",
    /**
     * 为什么单独列这一类：票据类图片的共同点是「字小、有红章、有折痕、
     * 一张上信息密集」，而且**最终目的几乎都是变成表格**。
     * 所以这里把「导出文字（CSV）」放到本地工具第一位 —— 那才是终点，
     * AI 改图在票据上反而容易把数字改错，不能当主力。
     */
    actions: ["sharpen", "dewatermark", "replace", "whole"],
    presets: [
      { label: "去掉票面的红章/水印", text: "" },
      { label: "把票据摆正", text: "把这张票据摆正、去掉倾斜，保持票面文字内容完全不变" },
      { label: "去掉阴影与折痕", text: "去掉这块区域的阴影/折痕，还原成平整的纸面" },
    ],
    localTools: ["exportText", "geometry", "resize", "watermark", "inpaint", "adjust"],
  },
];

export function getScene(id: SceneId | undefined): Scene {
  return SCENES.find((s) => s.id === id) ?? SCENES[0];
}

/**
 * 按场景给动作排序：场景关心的排前面，其余动作**保留在后面**。
 *
 * 为什么是"排序"而不是"过滤"：过滤会把功能藏起来，用户遇到列表外的需求时
 * 只会以为"这软件做不到"；排序既突出重点，又不砍掉能力。
 */
export function orderActions<T extends { id: string }>(actions: T[], scene: Scene): T[] {
  const idx = new Map(scene.actions.map((id, i) => [id, i]));
  return [...actions].sort((a, b) => {
    const ia = idx.has(a.id) ? (idx.get(a.id) as number) : 999;
    const ib = idx.has(b.id) ? (idx.get(b.id) as number) : 999;
    return ia - ib;
  });
}
