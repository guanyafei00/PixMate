import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { AnalyzeMode, buildPrompt, CHAT_SYSTEM_PREFIX } from "./prompts";
import {
  EditProviderId,
  MaskMode,
  getEditProvider,
  normalizeOrigin,
} from "./editProviders";
import { keyOptional, fetchModels, describeProbe } from "./localService";

/**
 * 架构分层（勿混淆职责）：
 * - 本文件 = 通道抽象层，负责「怎么拿到图」和「怎么把图交给模型」。
 *   切换模型仍只是改 base_url / api_key / model 三个字符串；
 *   「接入任意 Agent」是另一条路（P1 的 mcp_server.rs，尚未实现），不要混进这里。
 *
 * 【本次重构的核心决定 —— 废弃 base64-over-IPC】
 * 原实现：主进程 readFileSync → base64 → 拼成 data URL 字符串 → 经 IPC JSON 序列化
 *         → 渲染进程拿到几十 MB 的 JS 字符串 → 塞给 <img src>。
 * 问题：  ① base64 本身膨胀 33%；② 字符串要跨 IPC 完整拷贝一次；
 *         ③ Chromium 无法对这种字符串做渐进/流式解码，必须等整串到位；
 *         ④ 预加载相邻图 = 同时常驻 3 份全尺寸字符串。
 *         这四条直接顶撞产品第一红线「秒开」。
 * 现在：  Electron 注册自定义协议 aiiv://，由主进程用 net.fetch(file://) 把文件当流
 *         交给 Chromium —— 零 base64、零 IPC 拷贝、可流式解码、由 Chromium 自己管缓存。
 *         Tauri 侧用官方 asset 协议（convertFileSrc）达到同样效果。
 *         识别时才由主进程直接读盘转 base64 发给 API —— base64 永远不跨 IPC。
 */

export interface Settings {
  api_key: string;
  base_url: string;
  model: string;
  /**
   * 打开/切换图片时**是否自动识别**。
   *
   * 【默认关闭，这是刻意的】
   * 原实现是"打开即自动识别"，看着很贴心，但代价是：
   *   · 每翻一张图就调一次模型 —— 用户只是快速浏览时，钱在不知不觉地花掉
   *   · 用户那一张可能根本不需要 AI（只想看一眼、或只是想裁一下）
   *   · 一次翻十几张就会排队请求，界面一直在「识别中」
   * 所以改成**用户决定要不要用 AI、以及用哪种**（识别 / 提取文字 / 对话）。
   * 想要老行为的人可以在设置里打开这个开关 —— 不留退路地删掉是不对的，
   * 「打开即识别」原本是六份报告的共识 P0。
   */
  auto_analyze?: boolean;
  /**
   * 本地服务（Ollama / LM Studio 等）**不需要 API Key**。
   *
   * 【为什么要有这个字段】原实现把「Key 为空」一律当成「还没配置」，
   * 于是这两家预设虽然列在选择列表里，实际**根本用不了**。
   * 回环地址（localhost / 127.x）会自动判定为免 Key；
   * 局域网上的本地服务（如 http://127.0.0.1:11434/v1）请显式勾选 ——
   * 不能一律把局域网当免 Key，因为局域网网关（gateway 预设）是需要鉴权的。
   */
  local_no_key?: boolean;
  /* ---- AI 图像编辑（可选；全部留空则按预设默认值走 DashScope） ---- */
  /** 编辑服务商 */
  edit_provider?: EditProviderId;
  /** 编辑服务地址；留空用该服务商预设。填了兼容地址也没关系，只取 origin */
  edit_base_url?: string;
  /** 编辑模型；留空用该服务商预设 */
  edit_model?: string;
  /** 编辑用的 Key；留空则沿用上面的 api_key（默认两者同为百炼，不用填两遍） */
  edit_api_key?: string;
  /* ---- 本地 AI 去水印（IOPaint，免费离线） ---- */
  /** 本地 IOPaint 服务地址（去水印/抹除的 AI 引擎） */
  iopaint_url?: string;
  /** 服务没在运行时，应用用它自动拉起本地 IOPaint（exe + 参数） */
  iopaint_cmd?: string;
  /** IOPaint 常驻：关闭软件后服务继续在后台运行（默认关闭，退出即杀） */
  iopaint_keep_running?: boolean;
  /* ---- AI 生成配图（文生图 / 图生图，分开两个模型） ---- */
  /** 文生图模型名；留空用默认（your-image-model-2.5-flash，走网关免费） */
  gen_model?: string;
  /** 图生图模型名；留空用默认（gpt-image-2）。与文生图分开记，因为两种模式
   *  需要的模型不同 —— 实测文生图能用的 gateway 系列并不收参考图。 */
  gen_img2img_model?: string;
  /* ---- 通用 ---- */
  /** 启动时自动打开的文件夹；留空不自动打开 */
  startup_dir?: string;
  /** 外观主题：dark=黑夜 / light=白天 / system=随系统（默认） */
  theme?: "dark" | "light" | "system";
}

/**
 * 一张图。`url` 是可直接喂给 <img src> 的地址；`path` 是真实磁盘路径
 * （浏览器模式下退化为文件名，不代表可访问的文件系统位置）。
 */
export interface ImageItem {
  name: string;
  path: string;
  /** 显示地址：Electron/Tauri 为自定义协议 URL，浏览器为 data URL。 */
  url: string;
}

/**
 * 打开后的文件夹状态（P0.5 翻页浏览）。
 * 已废弃原先的 isLazy 标志：改为「url 是否为空」判断，避免标志与数据不同步。
 */
export interface OpenedFolder {
  items: ImageItem[];
  index: number;
  /** 打开的目录（Tauri/Electron 通道带回；浏览器模式没有） */
  dir?: string;
}

/** 识别请求超时。视觉模型 + 长文档 OCR 确实慢，给足 90s；超时的意义是「不无限期挂住」。 */
export const REQUEST_TIMEOUT_MS = 90_000;

/** 判断是否为真实磁盘绝对路径（用于决定能否真删文件 / 走文件流通道）。 */
export function isRealPath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("/");
}

/** 取所在目录（原实现叫 basename 但语义是 dirname —— 命名误导，已更正）。 */
export function dirname(p: string): string {
  return p.replace(/[\\/][^\\/]*$/, "");
}

/** 取文件名（跨 Windows / POSIX 分隔符）。 */
export function basename(p: string): string {
  const m = p.match(/[^\\/]*$/);
  return m && m[0] ? m[0] : p;
}

/* ------------------------------------------------------------------ */
/* 运行环境探测                                                        */
/* ------------------------------------------------------------------ */


/**
 * 【通道说明（v0.2.0 起）】
 * Electron 壳已冻结（legacy/），通道只剩两条：
 *   - Tauri（invoke）：桌面正式通道
 *   - 浏览器（BROWSER_MODE）：只读预览，文件/AI 操作不可用
 * 因此本文件不再有 isElectron/eapi 三路分支。
 */
const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** 浏览器预览模式（只读）：无 Tauri 运行时。 */
export const BROWSER_MODE = !isTauri;

/* ------------------------------------------------------------------ */
/* 结果内存优化：dataURL ↔ Blob URL（P1.8）                             */
/*                                                                      */
/* 编辑/生图结果原以 base64 dataURL 在渲染层流转（一张 4K 图约 1.3 倍体积 */
/* 常驻内存）。改为 Blob URL 后由浏览器托管二进制，只有显示需要时才解码。 */
/* 保存时再一次性转回 dataURL —— 内存峰值只出现在保存瞬间。               */
/* ------------------------------------------------------------------ */

/** dataURL → Blob URL：显示用，配合 revokeUrl 在不再需要时释放 */
export async function dataUrlToBlobUrl(dataUrl: string): Promise<string> {
  const blob = await (await fetch(dataUrl)).blob();
  return URL.createObjectURL(blob);
}

/** blob:/data: URL → dataURL：保存/上传时才转回，一次性开销 */
export async function imageUrlToDataUrl(url: string): Promise<string> {
  if (url.startsWith("data:")) return url;
  const blob = await (await fetch(url)).blob();
  return await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error("读取结果数据失败"));
    fr.readAsDataURL(blob);
  });
}

/** 释放 Blob URL（非 blob: 地址静默忽略，方便对混合来源统一调用） */
export function revokeUrl(url: string): void {
  if (url.startsWith("blob:")) URL.revokeObjectURL(url);
}

/**
 * 磁盘路径 → 可显示 URL。
 * Electron：aiiv://local/?p=<encodeURIComponent(绝对路径)>
 *   把路径整段放进 query 而不是 pathname，是为了绕开标准 URL 解析对
 *   反斜杠 / 盘符冒号 / 中文的归一化处理，最稳。
 * Tauri：官方 asset 协议（需在 tauri.conf.json 开启 assetProtocol）。
 * 浏览器：无文件系统权限，返回空串（调用方应已用 data URL 填充 url 字段）。
 */
export function pathToDisplayUrl(p: string): string {
  if (isTauri) return convertFileSrc(p);
  return "";
}

/** 用磁盘路径补全 items 的显示 URL（Electron/Tauri 下列表接口只回路径）。 */
function itemsFromPaths(paths: string[]): ImageItem[] {
  return paths.map((p) => itemFromPath(basename(p), p));
}

/** 由路径构造一个可显示条目（文件关联打开等场景需要在前端自行组装）。 */
export function itemFromPath(name: string, path: string): ImageItem {
  return { name, path, url: pathToDisplayUrl(path) };
}

/** 由浏览器 File 构造条目：无磁盘路径，url 为 data URL，只能走渲染进程直连识别。 */
export function itemFromFile(name: string, dataUrl: string, realPath?: string): ImageItem {
  // realPath：拖入图异步落盘后的真实路径；没有时保持旧行为（path=文件名）
  return { name, path: realPath ?? name, url: dataUrl };
}

export function getDefaultSettings(): Settings {
  // 默认指向局域网网关上的免费 gateway 模型：实测 46 个模型里只有 gateway 这条线能看图，
  // 其中 your-vision-model 最快（约 3 秒）且中文描述最细。
  return {
    api_key: "",
    base_url: "http://127.0.0.1:8000/v1",
    model: "your-vision-model",
    // 图像编辑仍默认百炼（万相）—— 局域网网关只开放了 chat/completions，
    // 没有可用的图像编辑路由（详见 接手续作纪要_20260918.md 的实测记录）
    edit_provider: "dashscope",
    edit_base_url: "https://dashscope.aliyuncs.com",
    edit_model: "wanx2.1-imageedit",
    edit_api_key: "",
    // 默认**不**自动识别：用户只想看一眼时不该悄悄调模型花钱（见 Settings.auto_analyze 注释）
    auto_analyze: false,
    // 本地 IOPaint（LaMa 去水印引擎）：默认装在 D 盘独立 venv（C 盘空间紧张，实测如此）
    iopaint_url: "http://127.0.0.1:8080",
    /* ⚠️ 这条命令必须与项目里的「启动IOPaint.cmd」保持一致 —— 实测结论：
       **少了 `--host=127.0.0.1` 服务就起不来**（表现为端口 8080 永不监听，
       一直等到 120 秒超时）。这是我踩过的坑，别再删这个参数。
       另外 XDG_CACHE_HOME 环境变量也由 .cmd 设置（模型下载位置），
       软件拉起时没设它，会退回 C 盘默认缓存 —— 功能不受影响，
       但模型可能重复下一份。 */
    iopaint_cmd:
      "iopaint.exe start --model=lama --device=cpu --port=8080 --host=127.0.0.1",
    iopaint_keep_running: false,
    // 生图默认模型：网关 your-image-model 系列实测可用、免费
    gen_model: "your-image-model-2.5-flash",
    // 启动时不自动打开任何文件夹
    startup_dir: "",
    // 外观默认跟随系统
    theme: "system" as const,
  };
}

/* ------------------------------------------------------------------ */
/* 设置                                                               */
/* ------------------------------------------------------------------ */

export async function loadSettings(): Promise<Settings> {
  // 两通道统一：先取存量，再合并默认值 —— 存量缺的字段（如老数据没有
  // iopaint_cmd）用默认值兜底，避免「设置里没有启动命令」这类断档。
  let raw: string | null = null;
  if (isTauri) {
    raw = await invoke<string>("load_settings");
  } else {
    raw = localStorage.getItem("ai-viewer-settings");
  }
  if (!raw || raw === "null") return getDefaultSettings();
  return { ...getDefaultSettings(), ...(JSON.parse(raw) as Settings) };
}

export async function saveSettings(s: Settings): Promise<void> {
  if (isTauri) {
    await invoke("save_settings", { settingsJson: JSON.stringify(s) });
    return;
  }
  localStorage.setItem("ai-viewer-settings", JSON.stringify(s));
}

/** 把主题设置落到 <html data-theme> 上（system 时实时查系统偏好） */
export function applyTheme(theme: string | undefined | null) {
  const mode =
    theme === "light" || theme === "dark"
      ? theme
      : window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
  document.documentElement.dataset.theme = mode;
}

/** 命令层 ACL：把用户真实操作涉及的目录加入会话授权表（拖入文件/启动目录用） */
export async function grantPath(path: string): Promise<void> {
  if (!isTauri) return;
  try {
    await invoke("grant_dir", { path });
  } catch {
    /* 授权失败不阻塞主流程，后续命令会给出明确错误 */
  }
}

/* ------------------------------------------------------------------ */
/* 通用（文件关联 / 开机自启 / 缓存清理）—— 仅 Tauri 壳提供              */
/* ------------------------------------------------------------------ */

export interface GeneralState {
  autostart: boolean;
  assoc: boolean;
  exe: string;
}

export async function getGeneralState(): Promise<GeneralState | null> {
  if (!isTauri) return null;
  try {
    return await invoke<GeneralState>("general_state");
  } catch {
    return null;
  }
}

export async function setFileAssoc(
  enable: boolean
): Promise<{ ok: boolean; message?: string }> {
  if (!isTauri)
    return { ok: false, message: "此功能目前仅在桌面版（Tauri）提供" };
  return await invoke("set_file_assoc", { enable });
}

export async function setAutostart(
  enable: boolean
): Promise<{ ok: boolean; message?: string }> {
  if (!isTauri)
    return { ok: false, message: "此功能目前仅在桌面版（Tauri）提供" };
  return await invoke("set_autostart", { enable });
}

export async function requestClearCache(): Promise<{
  ok: boolean;
  message?: string;
}> {
  if (!isTauri)
    return { ok: false, message: "此功能目前仅在桌面版（Tauri）提供" };
  return await invoke("request_clear_cache");
}

/**
 * 【诊断通道】把去水印链路的 mask/image/坐标系数值落盘。
 * 与 save_drop 同模式（静态 invoke + 壳层写盘）——之前用动态 import
 * 的版本静默失败，原因不明，弃用。
 */
export async function writeDebugPng(tag: string, rectJson: string, dataUrl: string): Promise<string | null> {
  if (!isTauri) return null;
  try {
    const r = await invoke<{ path: string }>("write_debug_png", {
      args: JSON.stringify({ tag, rectJson, dataUrl }),
    });
    return r.path ?? null;
  } catch {
    return null;
  }
}

/**
 * 启动参数里的图片路径（文件关联双击打开）。无参数返回 null。
 */
export async function getLaunchPath(): Promise<string | null> {
  if (isTauri) {
    return await invoke<string | null>("get_launch_path");
  }
  return null;
}

/**
 * 拖入图片落盘：把 data URL 写进应用数据目录（drops/）并返回真实路径，
 * 同时壳层自动授权该目录。失败时前端保留假路径条目。
 */
export async function saveDrop(
  name: string,
  dataUrl: string
): Promise<{ path: string; size: number }> {
  if (isTauri) {
    return await invoke<{ path: string; size: number }>("save_drop", {
      args: JSON.stringify({ name, dataUrl }),
    });
  }
  throw new Error("browser");
}

/**
 * 持久缩略图：壳层生成 320px JPEG 并落盘（键=路径+mtime+大小），
 * 第二次打开同一文件夹毫秒级命中。
 * 返回 ok:false（RAW/HEIC 等暂不支持解码）时前端回退原图。
 */
export async function thumbnailData(
  path: string,
  size = 320
): Promise<{
  ok: boolean;
  dataUrl?: string | null;
  cached: boolean;
  elapsedMs: number;
  err?: string | null;
}> {
  if (isTauri) {
    return await invoke<{
      ok: boolean;
      dataUrl?: string | null;
      cached: boolean;
      elapsedMs: number;
      err?: string | null;
    }>("thumbnail_data", {
      args: JSON.stringify({ path, size }),
    });
  }
  return { ok: false, dataUrl: null, cached: false, elapsedMs: 0, err: "browser" };
}

/**
 * 只探测 IOPaint 服务是否在运行（不拉起、无副作用）。仅 Tauri 壳。
 *
 * 【为什么要传 cmd】壳层会拿它做诊断 —— 检查启动程序还在不在、
 * 端口有没有被占。实测这台机器上 `iopaint start` 拉起后 8080 从未监听，
 * 只说「没在运行」用户没法判断该查什么。
 */
export async function iopaintProbe(
  baseUrl: string,
  cmd?: string
): Promise<{
  ok: boolean;
  message?: string;
  model?: string;
  /** 逐条诊断结论（可行动的事实，不是套话） */
  diagnostics?: string[];
}> {
  if (!isTauri)
    return { ok: false, message: "此功能目前仅在桌面版（Tauri）提供" };
  return await invoke("iopaint_probe", {
    args: JSON.stringify({ baseUrl, cmd: cmd ?? "" }),
  });
}

/* ------------------------------------------------------------------ */
/* 打开图片 / 文件夹                                                   */
/* ------------------------------------------------------------------ */

export async function openImage(): Promise<ImageItem | null> {
  if (isTauri) {
    try {
      const r = await invoke<{ name: string; path: string }>("open_image");
      return { name: r.name, path: r.path, url: pathToDisplayUrl(r.path) };
    } catch (e) {
      if (String(e).includes("cancelled")) return null;
      throw e;
    }
  }
  return browserPickImage();
}

export async function openFolder(): Promise<OpenedFolder | null> {
  if (isTauri) {
    const res = await invoke<{ dir: string; paths: string[] }>("open_folder");
    if (!res || !res.paths.length) {
      throw new Error("所选文件夹里没有找到图片（支持 png / jpg / webp / bmp / gif）");
    }
    return { items: itemsFromPaths(res.paths), index: 0, dir: res.dir };
  }
  const items = await browserPickFolder();
  return items && items.length ? { items, index: 0 } : null;
}

/**
 * 从指定目录打开（供「打开单张图片」与「文件关联双击」复用：
 * 即便用户只点了一张，也列出同级目录，使翻页可用）。
 */
export async function openFolderAt(
  dir: string,
  startPath?: string
): Promise<OpenedFolder | null> {
  if (!isTauri) return null;
  const paths = await invoke<string[]>("list_images", { dir });
  if (!paths.length) return null;

  let index = 0;
  if (startPath) {
    const target = basename(startPath).toLowerCase();
    const i = paths.findIndex((p) => p === startPath || basename(p).toLowerCase() === target);
    if (i >= 0) index = i;
  }
  return { items: itemsFromPaths(paths), index };
}

/** 移入回收站（非永久删除）。浏览器无权限，调用方应仅从本会话列表移除。 */
export async function trashImage(path: string): Promise<void> {
  if (isTauri) {
    await invoke("trash_image", { path });
  }
}

/* ------------------------------------------------------------------ */
/* AI 图像编辑（P1.5，走云端）                                          */
/* ------------------------------------------------------------------ */

export interface EditRequest {
  provider: EditProviderId;
  /** 服务 origin，适配器自行拼路径 */
  baseUrl: string;
  model: string;
  apiKey: string;
  /** 万相的功能值（description_edit / description_edit_with_mask / super_resolution / remove_watermark） */
  dsFunction?: string;
  prompt: string;
  /** 归一化后的原图（data URL） */
  baseImage: string;
  /** 与 baseImage 同分辨率的遮罩；null 表示整图编辑 */
  maskImage: string | null;
  width: number;
  height: number;
}

export interface EditResult {
  /** 编辑结果（data URL，已下载落盘到内存，不依赖服务商 24 小时过期的临时链接） */
  dataUrl: string;
  /** 服务商侧的任务号 / 请求号，出问题时便于排查 */
  requestId?: string;
}

/** 把用户设置解析成一次编辑调用所需的完整配置 */
export function resolveEditConfig(s: Settings) {
  const preset = getEditProvider(s.edit_provider);
  return {
    provider: preset.id,
    baseUrl: normalizeOrigin(s.edit_base_url || "", preset.base_url),
    model: (s.edit_model || "").trim() || preset.model,
    apiKey: (s.edit_api_key || "").trim() || s.api_key.trim(),
    maskMode: preset.maskMode as MaskMode,
    providerName: preset.name,
    consoleUrl: preset.consoleUrl,
  };
}

/**
 * 执行一次 AI 编辑。
 *
 * 【为什么浏览器预览模式直接拒绝】
 * 各家的图像编辑接口都不返回 CORS 头，渲染进程直连必被浏览器拦截 ——
 * 这正是识别请求要走主进程 Node fetch 的原因。
 * 与其塞一个「点了必然失败」的第三份实现，不如明确告诉你换桌面版跑。
 */
export async function editImage(req: EditRequest): Promise<EditResult> {
  if (isTauri) {
    return await invoke<EditResult>("edit_image", { req: JSON.stringify(req) });
  }
  throw new Error(
    "浏览器预览模式无法调用 AI 图像编辑（服务商不允许跨域）。请使用桌面版。"
  );
}

/**
 * 另存为。
 *
 * **产品红线：绝不自动覆盖原文件。** 这里做了两道保险 ——
 * 默认文件名带 `_edited` 后缀，且若用户把目标选成原文件路径则直接拒绝。
 */
/**
 * 通用"把 dataUrl 存成文件"（走系统另存为对话框，绝不静默写盘）。
 * 与 saveResultImage 的区别：文件名由调用方给全（AI 生成图不是"编辑结果"，不该带 _edited 后缀）。
 */
export async function saveDataUrlAs(
  dataUrl: string,
  defaultName: string
): Promise<{ saved: boolean; path?: string; message?: string; canceled?: boolean }> {
  if (isTauri) {
    const args = JSON.stringify({ sourcePath: "", dataUrl, defaultName });
    const r = (await invoke<{
      saved?: boolean;
      path?: string;
      message?: string;
      canceled?: boolean;
    }>("save_image", { args })) as {
      saved?: boolean;
      path?: string;
      message?: string;
      canceled?: boolean;
    };
    return {
      saved: Boolean(r?.saved),
      path: r?.path,
      message: r?.message,
      canceled: r?.canceled,
    };
  }
  if (typeof document !== "undefined") {
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = defaultName;
    a.click();
    return { saved: true, path: defaultName };
  }
  return { saved: false, message: "当前环境不支持保存" };
}

export async function saveResultImage(
  sourcePath: string,
  dataUrl: string,
  sourceName: string
): Promise<{ saved: boolean; path?: string; message?: string }> {
  const dot = sourceName.lastIndexOf(".");
  const defaultName =
    dot > 0
      ? `${sourceName.slice(0, dot)}_edited.png`
      : `${sourceName}_edited.png`;

  // Tauri：走 Rust 的另存为对话框（绝不覆盖原文件）
  if (isTauri) {
    return await eapilessSaveImage({ sourcePath, dataUrl, defaultName });
  }

  // 浏览器：没有文件系统权限，退化为下载
  if (typeof document !== "undefined") {
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = defaultName;
    a.click();
    return { saved: true, path: defaultName };
  }
  return { saved: false, message: "当前环境不支持保存" };
}

/** save_image 命令的统一封装（另存为对话框 + 原图保护），供本文件多处复用 */
async function eapilessSaveImage(args: {
  sourcePath: string;
  dataUrl: string;
  defaultName: string;
}): Promise<{ saved: boolean; path?: string; message?: string }> {
  const r = (await invoke<{
    saved?: boolean;
    path?: string;
    message?: string;
    canceled?: boolean;
  }>("save_image", { args: JSON.stringify(args) })) as {
    saved?: boolean;
    path?: string;
    message?: string;
    canceled?: boolean;
  };
  return {
    saved: Boolean(r?.saved),
    path: r?.path,
    message: r?.message,
  };
}

/* ------------------------------------------------------------------ */
/* 图片文件信息（本地，不联网）                                          */
/* ------------------------------------------------------------------ */

/** 解析出来的 EXIF，键已是中文可读标签 */
export type ExifFields = Record<string, string>;

export interface FileInfo {
  name: string;
  path: string;
  ext: string;
  bytes?: number;
  sizeText?: string;
  mtime?: string;
  mtimeText?: string;
  /** 从 EXIF 或文件头解析出的像素尺寸（渲染层通常已知，作为交叉校验） */
  width?: number;
  height?: number;
  exif?: ExifFields | null;
  error?: string;
}

/**
 * 读取文件信息。
 *
 * 【为什么这是一条「绕开封锁」的功能】
 * AI 改图被网关卡住了（没有可用的图像编辑路由），但看图器该有的本地能力
 * 不该跟着一起停 —— 文件属性与 EXIF 完全在本地就能拿到，不需要任何 Key。
 * 这也是调研里提到的「信息浮层」借鉴点（Tiefie 那类工具的核心体验之一）。
 */
export async function readFileInfo(path: string): Promise<FileInfo | null> {
  if (isTauri) {
    try {
      return await invoke<FileInfo>("file_info", { path });
    } catch {
      return null;
    }
  }
  return null; // 浏览器模式拿不到文件系统信息
}

/* ------------------------------------------------------------------ */
/* 错误信息人话化                                                      */
/* ------------------------------------------------------------------ */

/**
 * 把模型服务商五花八门的报错翻译成能照着做的话。
 * 目标用户不一定会看 HTTP 状态码 —— 只说「API 错误 (401)」等于没说。
 */
export function friendlyError(raw: string): string {
  const msg = raw || "未知错误";
  if (/401|invalid_api_key|Incorrect API key|令牌已过期|验证不正确|Unauthorized/i.test(msg)) {
    return `${msg}\n→ 多半是 API Key 不对：重新完整复制一次（前后不要带空格），确认没过期、且与所选服务商匹配。`;
  }
  if (/402|Insufficient|余额|quota|额度/i.test(msg)) {
    return `${msg}\n→ 账户余额或免费额度不足，换一家或充值后重试。`;
  }
  if (/404|model_not_found|does not exist|Not Found/i.test(msg)) {
    return `${msg}\n→ Base URL 或模型名写错了，检查是否多了/少了 /v1 之类的路径段。`;
  }
  if (/429|rate limit|限流|too many/i.test(msg)) {
    return `${msg}\n→ 触发限流，稍等一会儿再试，或换用免费档模型。`;
  }
  // ---- 图像编辑特有 ----
  if (/DataInspection|inspection|审核|敏感|risk/i.test(msg)) {
    return `${msg}\n→ 内容审核未通过。换一张图，或调整你的描述措辞。`;
  }
  if (/InvalidParameter|invalid.*(size|resolution|image)|分辨率|尺寸|512|4096/i.test(msg)) {
    return `${msg}\n→ 图片不符合服务商要求（宽高需在 512–4096 像素、单张 ≤10MB）。`;
  }
  if (/task.*(FAILED|failed)|任务失败/i.test(msg)) {
    return `${msg}\n→ 服务商侧生成失败，常见原因是描述过于复杂或与图像冲突。换个说法再试。`;
  }
  if (/超时/.test(msg)) return msg;
  if (
    /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|Failed to fetch|请求失败|NetworkError/i.test(msg)
  ) {
    return `${msg}\n→ 连不上这个地址：核对 Base URL；本地模型（Ollama / LM Studio）请确认服务已启动、端口正确。`;
  }
  if (/读取文件夹失败|没有找到图片|读取图片失败/.test(msg)) return msg;
  return msg;
}

/* ------------------------------------------------------------------ */
/* 连接测试                                                            */
/* ------------------------------------------------------------------ */

/**
 * 探针图：8×8 真实像素（棋盘格），已用 PIL 验证可完整解码。
 *
 * 【为什么不是 1×1】
 * 曾经这里硬编码了一张 1×1「透明 PNG」，但那串 base64 是**截断的**（70 字节，
 * IDAT 数据流不完整）。PIL 解码直接报 `broken data stream when reading image file`，
 * 与服务商返回的错误一字不差 —— 结果是：**谁点「测试连接」谁就必然失败**，
 * 跟 Key 对不对毫无关系。这类问题极易误判成「Key 不对」。
 *
 * 防回归：self-check 会对这张图做**结构校验**（chunk 完整性 + CRC32 + IDAT 解压尺寸），
 * 再在渲染进程里用 Chromium 真解码一次 —— 坏图过不了自检。
 */
export const PROBE_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAG0lEQVR42mMIP/j/w5cfmCQDVtHwg/8ZBqUOAMvbnmEwZFQ7AAAAAElFTkSuQmCC";

/**
 * 测试当前配置能否连通。
 *
 * 为什么值得做：新手最容易卡在「填了 Key 却不知道对不对」。
 * 等真正打开图片才发现失败，会把配置问题和图片问题混在一起，很难排查。
 * 这里主动发一个 1×1 的探针请求，把三类问题（Key 无效 / 地址或模型名错 / 连不上）
 * 在设置页当场区分开。
 */
export async function testConnection(
  settings: Settings
): Promise<{ ok: boolean; message: string }> {
  /**
   * 本地服务不需要 Key：先探测一遍服务在不在、有没有这个模型 ——
   * 这样能区分「服务没启动」与「模型不存在」，而不是笼统报一句请求失败。
   * 探测通过后再真的发一次识别，确认端到端可用。
   */
  const local = keyOptional(settings);

  if (!local && !settings.api_key.trim()) return { ok: false, message: "还没填 API Key" };
  if (!settings.base_url.trim()) return { ok: false, message: "Base URL 为空" };
  if (!settings.model.trim()) return { ok: false, message: "模型名为空" };

  if (local) {
    const probe = await fetchModels(settings);
    const verdict = describeProbe(probe, settings.model.trim());
    // 服务不可用/模型不在 → 直接给这条更具体的结论，不必再发一次识别
    if (!verdict.ok) return verdict;
  }

  try {
    const reply = await analyzeDataUrl(
      PROBE_PNG,
      settings,
      "只回复 OK 两个字母，不要输出任何其他内容。",
      16
    );
    const brief = reply.trim().replace(/\s+/g, " ").slice(0, 40);
    return { ok: true, message: `连接成功（模型回复：${brief}）` };
  } catch (e) {
    return { ok: false, message: friendlyError(e instanceof Error ? e.message : String(e)) };
  }
}

/** 直接用 data URL 走一次识别（无需磁盘路径）——供连接测试与拖拽场景复用。 */
export async function analyzeDataUrl(
  dataUrl: string,
  settings: Settings,
  prompt: string,
  maxTokens: number
): Promise<string> {
  if (isTauri) {
    return await invoke<string>("analyze_image", {
      dataUrl,
      settingsJson: JSON.stringify(settings),
      prompt,
      maxTokens,
    });
  }
  return browserAnalyze(dataUrl, settings, prompt, maxTokens);
}

/**
 * AI 生成配图（文生图）/ 图生图：壳里完成请求与下载，渲染层只拿 dataUrl。
 * 默认走用户网关的 your-image-model 系列 —— 实测可用且免费。
 *
 * 【传了 refImage 就走图生图】壳层会自动把端点从
 * `/v1/images/generations`（JSON）换成 `/v1/images/edits`（multipart 上传参考图）。
 * 渲染层不需要关心端点差异 —— 那属于网络细节，正是壳层的职责。
 */
export async function generateImage(args: {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  size: string;
  /** 图生图的参考图（data URL）。留空 = 文生图。 */
  refImage?: string | null;
}): Promise<{ ok: boolean; dataUrl?: string; message?: string; httpStatus?: number }> {
  if (isTauri) {
    const payload = JSON.stringify(args);
    const r = (await invoke<{
      ok: boolean;
      dataUrl?: string;
      message?: string;
      httpStatus?: number;
    }>("generate_image", { args: payload })) as {
      ok: boolean;
      dataUrl?: string;
      message?: string;
      httpStatus?: number;
    };
    return r;
  }
  return { ok: false, message: "当前环境不支持 AI 生成" };
}

/**
 * 生图模型体检：逐个模型**实跑一次**，报告每个模型此刻能不能出图。
 *
 * 【为什么不用 /models 判断可用性】实测用户的网关 /models 正常返回 121 个模型，
 * 文字对话也正常，但图像模型会在 200 / 500 / 503 之间抖动（凭据池在轮换）。
 * 列表里有 ≠ 能用。这个命令发真实请求，拿到的是**此刻**的真话。
 *
 * ⚠️ 会消耗额度：每个模型一次 512×512 真实请求。
 */
export interface ImageModelProbeResult {
  model: string;
  ok: boolean;
  ms: number;
  message: string;
  httpStatus?: number;
}

export interface ImageModelProbeReport {
  ok: boolean;
  total: number;
  usable: number;
  results: ImageModelProbeResult[];
  summary: string;
  message?: string;
}

export async function probeImageModels(args: {
  baseUrl: string;
  apiKey: string;
  models: string[];
  /** true = 测图生图端点（multipart），false = 测文生图端点（JSON） */
  img2img?: boolean;
}): Promise<ImageModelProbeReport> {
  if (isTauri) {
    return await invoke<ImageModelProbeReport>("probe_image_models", {
      args: JSON.stringify(args),
    });
  }
  return {
    ok: false,
    total: 0,
    usable: 0,
    results: [],
    summary: "浏览器预览模式无法访问网关，请用桌面版测试生图",
  };
}

/**
 * 本地 IOPaint 去水印（LaMa）：图片与遮罩交给壳层，由壳层 multipart 上传给本地服务。
 * 【为什么走壳】本地服务通常不带 CORS 头，渲染进程直连必被浏览器拦截 ——
 * 与识别请求走主进程是同一条理由。
 */
export async function iopaintInpaint(args: {
  baseUrl: string;
  imageDataUrl: string;
  maskDataUrl: string;
}): Promise<{ ok: boolean; dataUrl?: string; message?: string }> {
  if (isTauri) {
    return await invoke<{ ok: boolean; dataUrl?: string; message?: string }>(
      "iopaint_inpaint",
      { args: JSON.stringify(args) }
    );
  }
  return { ok: false, message: "浏览器预览模式无法访问本地 IOPaint，请用桌面版" };
}

/**
 * 探活 / 自动拉起本地 IOPaint 服务。
 * 服务已在运行 → 直接返回（started=false）；没有 → 用启动命令拉起并等就绪。
 */
export async function iopaintEnsureServer(args: {
  baseUrl: string;
  /** 留空时用默认启动命令兜底 —— 见下方说明 */
  cmd?: string;
}): Promise<{
  ok: boolean;
  started: boolean;
  message?: string;
  model?: string | null;
  device?: string | null;
}> {
  if (isTauri) {
    /* 【为什么要用默认值兜底】实测踩过的坑：用户从没点过设置页的「保存」，
       settings.json 里根本没有 iopaint_cmd 这个键，而调用方传的是
       **原始 settings 对象**（不是默认值合并后的），于是壳层收到空字符串，
       直接返回「没有可用的启动命令」—— 自动启动静默失效。
       这里兜一层底：就算配置缺失，也用默认命令试一次，
       至少能把服务拉起来；诊断信息由 iopaint_probe 给出。 */
    const d = getDefaultSettings();
    return await invoke<{
      ok: boolean;
      started: boolean;
      message?: string;
      model?: string | null;
      device?: string | null;
    }>("iopaint_ensure_server", {
      args: JSON.stringify({
        baseUrl: args.baseUrl || d.iopaint_url || "http://127.0.0.1:8080",
        cmd: (args.cmd ?? "").trim() || d.iopaint_cmd || "",
      }),
    });
  }
  return { ok: false, started: false, message: "浏览器预览模式无法管理本地服务，请用桌面版" };
}

/**
 * 配置文件的实际路径（按壳区分：Electron 是 userData/settings.json，
 * Tauri 是 tauri-plugin-store 的文件）。设置页显示它 —— "存哪了"应当可见。
 */
export async function getSettingsPath(): Promise<string> {
  if (isTauri) {
    const r = (await invoke<{ path?: string }>("settings_path", {})) as { path?: string };
    return r?.path || "";
  }
  return "";
}

/**
 * 批量产物的落盘（批量几十张，不能每张弹一次保存框）。
 *
 * 安全模型与 Tauri/Electron 两侧的主进程护栏一致：
 * **只允许写进父目录名为 aiiv-processed 的目录** ——
 * 弹窗省掉的前提，是渲染层再被攻破也写不到别处。
 */
export async function writeProcessed(
  path: string,
  dataUrl: string
): Promise<{ saved: boolean; path?: string; message?: string }> {
  if (isTauri) {
    // Tauri 命令收一个 JSON 字符串参数（与 main.rs 的 WriteProcessedArgs 对应）
    const args = JSON.stringify({ path, dataUrl });
    const r = (await invoke<Record<string, unknown>>("write_processed", { args })) as {
      saved?: boolean;
      path?: string;
      message?: string;
    };
    return { saved: Boolean(r?.saved), path: r?.path, message: r?.message };
  }
  return { saved: false, message: "当前环境不支持批量落盘" };
}

/**
 * 导出文本（识别/OCR 结果）。
 *
 * 两条通道：
 *   · Electron：走主进程的保存对话框（用户自己选位置，不静默写盘）
 *   · 浏览器：用 blob 触发下载
 * 关键在于**不在渲染层直接写文件** —— 渲染层没有文件系统权限，
 * 也不该有（这是本项目的安全边界）。
 */
export async function exportTextFile(
  content: string,
  filename: string
): Promise<{ saved: boolean; path?: string; message?: string }> {
  // Tauri 壳：走 Rust 的系统另存为对话框 + UTF-8 BOM（与 Electron 主进程同规格），
  // 不再退化成浏览器 blob 下载 —— 下载路径没有「选位置」的环节，批量导出时不可控。
  if (isTauri) {
    const r = await invoke<{
      saved?: boolean;
      path?: string;
      message?: string;
      canceled?: boolean;
    }>("save_text", {
      args: JSON.stringify({ content, defaultName: filename }),
    });
    return { saved: Boolean(r?.saved), path: r?.path, message: r?.message };
  }
  // 浏览器兜底：造一个 blob 链接点一下
  const mime = filename.endsWith(".csv")
    ? "text/csv"
    : filename.endsWith(".md")
      ? "text/markdown"
      : "text/plain";
  const blob = new Blob(["\ufeff" + content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return { saved: true, path: filename };
}

/* ------------------------------------------------------------------ */
/* 识别                                                               */
/* ------------------------------------------------------------------ */

/**
 * 识别一张图。三条通道各自把 base64 的边界收在最里层：
 * - Electron：路径交给主进程，主进程读盘 + base64 + 请求，base64 不跨 IPC（首选）
 * - 浏览器  ：只有 data URL，直接在渲染进程 fetch
 * - Tauri   ：路径交给 Rust，同 Electron 思路
 *
 * prompt / maxTokens 由此处依据 mode 生成后传给通道 —— 提示词只有一份真源
 * （prompts.ts），主进程与 Rust 端都不再各存一份。
 */
/* ------------------------------------------------------------------ */
/* EXIF 归一化（2026-10-06）                                            */
/* ------------------------------------------------------------------ */

/**
 * 【EXIF 归一化】手机竖拍照片带 orientation=6/8（旋转 90°）：
 * 浏览器 <img> 解码时自动转正，但**原始文件字节没有** ——
 * analyze_path / chat_image_path 把原始字节直接发给网关视觉模型，
 * 模型看到的是横躺的图，理解与 OCR 质量都受损。
 *
 * 这里用 canvas 重绘（drawImage 遵循 EXIF）得到转正后的 JPEG，
 * 落到应用数据目录的固定名临时文件，返回该路径；失败返回 null
 * （调用方退回原始路径，行为与旧版一致 —— 渐进增强）。
 * 同一张图只归一化一次（path → 临时路径 缓存）。
 */
const exifNormCache = new Map<string, string>();

async function exifNormalizeDataUrl(url: string): Promise<string> {
  const src = url.startsWith("data:")
    ? url
    : await new Promise<string>((res, rej) => {
        fetch(url)
          .then((r) => r.blob())
          .then((b) => {
            const fr = new FileReader();
            fr.onload = () => res(String(fr.result));
            fr.onerror = () => rej(new Error("读取图片失败"));
            fr.readAsDataURL(b);
          })
          .catch(() => rej(new Error("读取图片失败")));
      });
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error("解码失败"));
    im.src = src;
  });
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const cx = c.getContext("2d");
  if (!cx) throw new Error("无法创建画布");
  cx.imageSmoothingQuality = "high";
  cx.drawImage(img, 0, 0);
  return c.toDataURL("image/jpeg", 0.92);
}

async function normalizeToTempPath(item: ImageItem): Promise<string | null> {
  const key = item.path || item.url;
  const hit = exifNormCache.get(key);
  if (hit) return hit;
  const dataUrl = await exifNormalizeDataUrl(item.url);
  const r = await invoke<{ path: string }>("write_temp_image", { dataUrl });
  if (!r?.path) return null;
  exifNormCache.set(key, r.path);
  return r.path;
}

/** dataUrl 版归一化（chat_image / analyze_image 的 dataUrl 入参用）。 */
export async function normalizeDataUrl(dataUrl: string): Promise<string> {
  return await exifNormalizeDataUrl(dataUrl);
}

export async function analyzeItem(
  item: ImageItem,
  settings: Settings,
  mode: AnalyzeMode
): Promise<string> {
  const prompt = buildPrompt(mode);
  /**
   * max_tokens 必须给足。
   *
   * 实测教训：局域网网关上的 your-model-2.x 是**推理型**模型，会先消耗 token 做思考再输出。
   * 给它 max_tokens=512 时返回 finish_reason=length 且 content 为空字符串 ——
   * 界面看起来就是「什么都没发生」，极难排查。给到 2048 就正常了。
   * OCR 模式输出是长文档，1000 会把表格截断 —— 这是「保留排版」能不能落地的硬前提。
   */
  const maxTokens = mode === "ocr" ? 4096 : 2048;

  if (isTauri && isRealPath(item.path)) {
    // 【EXIF 归一化】优先发转正后的临时文件；失败退回原始路径（旧行为）
    try {
      const tmp = await normalizeToTempPath(item);
      if (tmp) {
        return await invoke<string>("analyze_path", {
          path: tmp,
          settingsJson: JSON.stringify(settings),
          prompt,
          maxTokens,
        });
      }
    } catch {
      /* 归一化失败 → 用原始路径 */
    }
    return await invoke<string>("analyze_path", {
      path: item.path,
      settingsJson: JSON.stringify(settings),
      prompt,
      maxTokens,
    });
  }
  return browserAnalyze(item.url, settings, prompt, maxTokens);
}

/* ------------------------------------------------------------------ */
/* 多轮对话（识别区的「对话」标签）                                      */
/* ------------------------------------------------------------------ */

/** 一条对话消息。content 是纯文本；图片由各通道插进第一条用户消息。 */
export interface ChatMsg {
  role: "user" | "assistant";
  content: string;
}

/**
 * 带图多轮对话。
 *
 * 三条通道与识别保持同一套边界：
 * - Electron：路径交给主进程，base64 不跨 IPC（首选）
 * - Tauri  ：路径交给 Rust（chat_image_path）
 * - 浏览器 ：渲染进程直接 fetch
 *
 * 提示词唯一真源不变：系统级上下文（CHAT_SYSTEM_PREFIX）由这里拼进首条用户消息，
 * 主进程 / Rust 只当管道，只负责「把图片挂到第一条用户消息上」。
 */
export async function chatWithImage(
  item: ImageItem,
  settings: Settings,
  history: ChatMsg[],
  userText: string
): Promise<string> {
  // 系统级上下文只进**整段对话的第一条**用户消息；之后的轮次原样传递。
  const maxTokens = 2048;
  const msgs: ChatMsg[] = history.map((m) => ({ role: m.role, content: m.content }));
  const hasUser = msgs.some((m) => m.role === "user");
  msgs.push({
    role: "user",
    content: hasUser ? userText : `${CHAT_SYSTEM_PREFIX}\n\n${userText}`,
  });
  const payload = msgs;

  if (isTauri && isRealPath(item.path)) {
    // 【EXIF 归一化】同识别；失败退回原始路径
    try {
      const tmp = await normalizeToTempPath(item);
      if (tmp) {
        return await invoke<string>("chat_image_path", {
          path: tmp,
          settingsJson: JSON.stringify(settings),
          messagesJson: JSON.stringify(payload),
          maxTokens,
        });
      }
    } catch {
      /* 归一化失败 → 用原始路径 */
    }
    return await invoke<string>("chat_image_path", {
      path: item.path,
      settingsJson: JSON.stringify(settings),
      messagesJson: JSON.stringify(payload),
      maxTokens,
    });
  }
  if (isTauri) {
    let du = item.url;
    try {
      du = await normalizeDataUrl(item.url);
    } catch {
      /* 保持原 url */
    }
    return await invoke<string>("chat_image", {
      dataUrl: du,
      settingsJson: JSON.stringify(settings),
      messagesJson: JSON.stringify(payload),
      maxTokens,
    });
  }
  return browserChat(item.url, settings, payload, maxTokens);
}

/** 浏览器兜底：渲染进程直接 fetch（需要服务商允许跨域）。 */
async function browserChat(
  dataUrl: string,
  settings: Settings,
  messages: ChatMsg[],
  maxTokens: number
): Promise<string> {
  if (!settings.api_key.trim()) throw new Error("请先在「设置」中填写 API Key");
  let placed = false;
  const out = messages.map((m) => {
    if (!placed && m.role === "user") {
      placed = true;
      return {
        role: m.role,
        content: [
          { type: "text", text: m.content },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      };
    }
    return { role: m.role, content: m.content };
  });
  let resp: Response;
  try {
    resp = await fetch(`${settings.base_url.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.api_key}`,
      },
      body: JSON.stringify({ model: settings.model, messages: out, max_tokens: maxTokens }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    if ((e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError") {
      throw new Error("请求超时。可能是网络不通、端点写错，或该模型响应过慢。");
    }
    throw new Error(
      `请求失败：${(e as Error)?.message || e}（浏览器预览下服务商通常不允许跨域，请用桌面版）`
    );
  }
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = json?.error?.message || json?.message || "未知错误";
    throw new Error(`API 错误 (${resp.status}): ${msg}`);
  }
  const choice = json?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("模型没有返回任何内容。可能是该模型不支持图片输入，或服务商侧异常。");
  }
  return content;
}

/* ------------------------------------------------------------------ */
/* 浏览器兜底实现（无 Node / 无 Rust 时）                              */
/* ------------------------------------------------------------------ */

function browserPickImage(): Promise<ImageItem | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = () =>
        resolve({
          name: file.name,
          path: file.name,
          url: reader.result as string,
        });
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    };
    input.click();
  });
}

/** 浏览器：webkitdirectory 选整文件夹，全量读入并按自然序排序。 */
function browserPickFolder(): Promise<ImageItem[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.setAttribute("webkitdirectory", "");
    input.setAttribute("directory", "");
    input.onchange = () => {
      const files = Array.from(input.files || []).filter((f) =>
        // 只匹配 WebView 真能解码的格式（实测见 npm run format-probe）
        /\.(png|jpe?g|jfif|webp|bmp|gif|avif|ico|svg)$/i.test(f.name)
      );
      if (!files.length) return resolve(null);
      const items: ImageItem[] = new Array(files.length);
      let loaded = 0;
      let failed = false;
      files.forEach((file, i) => {
        const reader = new FileReader();
        reader.onload = () => {
          items[i] = {
            name: file.name,
            path:
              (file as { webkitRelativePath?: string }).webkitRelativePath || file.name,
            url: reader.result as string,
          };
          loaded++;
          if (loaded === files.length && !failed) {
            items.sort((a, b) =>
              a.name.localeCompare(b.name, undefined, { numeric: true })
            );
            resolve(items);
          }
        };
        reader.onerror = () => {
          failed = true;
          resolve(null);
        };
        reader.readAsDataURL(file);
      });
    };
    input.click();
  });
}

async function browserAnalyze(
  dataUrl: string,
  settings: Settings,
  prompt: string,
  maxTokens: number
): Promise<string> {
  if (!settings.api_key.trim()) throw new Error("请先在「设置」中填写 API Key");
  if (!dataUrl) throw new Error("当前环境无法读取该图片");

  const url = `${settings.base_url.replace(/\/+$/, "")}/chat/completions`;
  const body = {
    model: settings.model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    max_tokens: maxTokens,
  };

  // 超时是必须的：没配超时的 fetch 在网络半死不活时会永久挂住，UI 一直「正在识别」
  const ac = new AbortController();
  const timer = window.setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.api_key}`,
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const msg = json?.error?.message || json?.message || "未知错误";
      throw new Error(`API 错误 (${resp.status}): ${msg}`);
    }
    const choice = json?.choices?.[0];
    const content = choice?.message?.content;
    // 空内容当成错误抛出来（推理型模型 max_tokens 太小时会返回 length + 空串）
    if (typeof content !== "string" || !content.trim()) {
      const fr = choice?.finish_reason;
      if (fr === "length") {
        throw new Error(
          "模型没有输出内容，原因是 max_tokens 被思考过程耗尽了（finish_reason=length）。" +
            "该模型属于推理型：请换用非推理模型，或调大输出预算后重试。"
        );
      }
      throw new Error(
        `模型没有返回任何内容${fr ? `（finish_reason=${fr}）` : ""}。可能是该模型不支持图片输入，或服务商侧异常。`
      );
    }
    return content as string;
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error(`请求超时（${REQUEST_TIMEOUT_MS / 1000}s），请检查网络或改用更快的模型`);
    }
    throw e;
  } finally {
    window.clearTimeout(timer);
  }
}
