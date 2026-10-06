/**
 * AI 编辑动作目录。
 *
 * 【设计依据】来自 调研与决策依据.md §7.1：
 * 不自己训练模型，只做「**选区工具 + 提示词输入 + 结果对比 + 非破坏性**」的体验层。
 * 用户最自然的形态是「选区 + 自然语言」，而不是传统修图工具栏。
 *
 * 动作被抽象成「声明式」的，好处有两个：
 * 1. 提示词集中在一处打磨 —— 图像编辑的效果**八成取决于 prompt**，散落各处必然退化；
 * 2. 服务商支持范围不同（比如 OpenAI 的 /images/edits 没有「超分」「去水印」），
 *    可以按 provider 过滤，而不是给用户一个点了必失败的按钮。
 */
import { EditProviderId } from "./editProviders";

/** 万相通用图像编辑支持的功能值（摘自阿里云百炼 API 参考） */
export type DashScopeFunction =
  | "description_edit"
  | "description_edit_with_mask"
  | "stylization_all"
  | "remove_watermark"
  | "super_resolution";

export interface EditAction {
  id: string;
  /** 按钮文案，尽量短 */
  label: string;
  /** 悬停说明，写清「会发生什么」 */
  title: string;
  /** 是否必须先框选 */
  needsSelection: boolean;
  /** 是否需要用户输入描述 */
  needsPrompt: boolean;
  /** 输入框的占位文案 */
  promptPlaceholder?: string;
  /** 支持的 provider；未列出即不支持 */
  providers: EditProviderId[];
  /** 万相的功能值（仅 dashscope 用） */
  dsFunction?: DashScopeFunction;
  /**
   * 组装最终 prompt。
   * 注意「局部编辑」一定要显式写「只改选中区域、区域外保持不变」——
   * 否则模型很容易顺手把整张图重画一遍，这是局部重绘最常见的翻车方式。
   */
  buildPrompt: (userInput: string) => string;
}

export const EDIT_ACTIONS: EditAction[] = [
  {
    id: "erase",
    label: "抹除",
    title: "把框选范围内的物体或瑕疵去掉，用周围背景自然填充",
    needsSelection: true,
    needsPrompt: false,
    providers: ["dashscope"],
    dsFunction: "description_edit_with_mask",
    buildPrompt: () =>
      "移除所选区域内的物体或瑕疵，用周围的环境、纹理与光照自然填充，" +
      "补全其后的背景，不要留下任何痕迹、边缘或色块。",
  },
  {
    id: "replace",
    label: "按描述改",
    title: "只用一句话描述想怎么改框选范围（区域外保持不变）",
    needsSelection: true,
    needsPrompt: true,
    providers: ["dashscope", "openai"],
    dsFunction: "description_edit_with_mask",
    promptPlaceholder: "例：换成一杯咖啡 / 把字改成“你好” / 变成红色",
    buildPrompt: (t) =>
      `只修改所选区域：${t}。` +
      "区域之外的所有内容必须与原图完全一致，不要改动、不要重新构图、不要改变整体风格与光照。",
  },
  {
    id: "whole",
    label: "整图改",
    title: "不框选，用一句话描述想把整张图改成什么样",
    needsSelection: false,
    needsPrompt: true,
    providers: ["dashscope", "openai"],
    dsFunction: "description_edit",
    promptPlaceholder: "例：把背景换成沙滩 / 转换成水彩画风格",
    buildPrompt: (t) => t,
  },
  {
    id: "sharpen",
    label: "变清晰",
    title: "对整张图做超分/去模糊（无需描述）",
    needsSelection: false,
    needsPrompt: false,
    providers: ["dashscope"],
    dsFunction: "super_resolution",
    buildPrompt: () => "",
  },
  {
    id: "dewatermark",
    label: "去水印",
    title: "去除图中文字水印（无需描述）",
    needsSelection: false,
    needsPrompt: false,
    providers: ["dashscope"],
    dsFunction: "remove_watermark",
    buildPrompt: () => "",
  },
];

/** 当前 provider 支持的动作 */
export function actionsFor(provider: EditProviderId): EditAction[] {
  return EDIT_ACTIONS.filter((a) => a.providers.includes(provider));
}

export function findAction(id: string): EditAction | undefined {
  return EDIT_ACTIONS.find((a) => a.id === id);
}
