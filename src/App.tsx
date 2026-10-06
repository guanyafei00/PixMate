import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import GenerateDialog from "./components/GenerateDialog";
import {
  ChatMsg,
  FileInfo,
  ImageItem,
  OpenedFolder,
  Settings,
  analyzeItem,
  chatWithImage,
  dirname,
  editImage,
  friendlyError,
  getDefaultSettings,
  applyTheme,
  dataUrlToBlobUrl,
  imageUrlToDataUrl,
  revokeUrl,
  grantPath,
  isRealPath,
  itemFromFile,
  basename,
  itemFromPath,
  loadSettings,
  openFolder,
  openFolderAt,
  openImage,
  readFileInfo,
  resolveEditConfig,
  exportTextFile,
  saveResultImage,
  saveDrop,
  getLaunchPath,
  saveSettings,
  trashImage,
  BROWSER_MODE,
} from "./lib/api";
import { keyOptional } from "./lib/localService";
import { AnalyzeMode } from "./lib/prompts";
import { EditAction, actionsFor } from "./lib/editActions";
import { SelectionRect, prepareEditImages } from "./lib/imageEdit";
import { SceneId, SCENES, getScene, orderActions } from "./lib/workflows";
import LocalToolsPanel from "./components/LocalToolsPanel";
import QuickDock from "./components/QuickDock";
import CommandPalette, { type CommandItem } from "./components/CommandPalette";
import EmptyState from "./components/EmptyState";
import { LocalToolId } from "./lib/workflows";
import ImageView from "./components/ImageView";
import ThumbnailRail from "./components/ThumbnailRail";
import InfoPanel from "./components/InfoPanel";
import ResultPanel from "./components/ResultPanel";
import SettingsPanel from "./components/SettingsPanel";
import { EditPhase } from "./components/EditResultBar";

const isMac = navigator.platform.toLowerCase().includes("mac");
const mod = (e: KeyboardEvent) => (isMac ? e.metaKey : e.ctrlKey);

/** 结果缓存上限：按「路径+模式」缓存，避免翻回去重复调用模型（重复计费）。 */
const RESULT_CACHE_MAX = 40;

export default function App() {
  const [folder, setFolder] = useState<OpenedFolder | null>(null);
  const [index, setIndex] = useState(0);
  const [image, setImage] = useState<ImageItem | null>(null);
  const [result, setResult] = useState<string>("");
  const [instant, setInstant] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** AI 生成配图弹窗（文生图，走用户网关，免费） */
  const [genOpen, setGenOpen] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [needSetup, setNeedSetup] = useState(false);
  const [mode, setMode] = useState<AnalyzeMode>("describe");

  /* ---- AI 视觉编辑（P1.5）状态 ---- */
  /** 选区以「原图像素坐标」为唯一真源；显示时再换算回屏幕坐标，缩放平移都不会错位 */
  const [selection, setSelection] = useState<SelectionRect | null>(null);
  const [editPhase, setEditPhase] = useState<EditPhase>({ kind: "idle" });
  /** 编辑结果（data URL）。null = 还在看原图 */
  const [resultUrl, setResultUrl] = useState<string | null>(null);

  /**
   * AI 编辑的**版本栈**。
   *
   * 【为什么需要】已有「对比原图」按钮，但只有一次结果、没有历史 ——
   * 连续改两次就看不到第一次了。而 ChatGPT 报告里那条研究正是问题的关键：
   * **8.3 万条真实图片编辑请求里，最好的 AI 编辑器只满足 33%**，
   * 精确控制类任务最容易失败。所以正确的产品化不是"保证改对"，
   * 而是**让人能放心试、来回比** —— 失败一次不必重来。
   *
   * 【实现取向：薄薄一层，不重构下游】
   * `resultUrl` 的语义从"唯一的结果"变成"**当前正在看的那一版**"，
   * 于是 ImageView / 结果条 / 另存为的代码一行都不用改。
   * 版本栈只是多记一份历史，外加一个游标。
   */
  const [editVersions, setEditVersions] = useState<
    { url: string; label: string; prompt: string; requestId?: string }[]
  >([]);
  /** 0 = 原图；i>0 = editVersions[i-1] */
  const [versionCursor, setVersionCursor] = useState(0);
  /**
   * 结果内存护栏（P1.8）：结果图以 Blob URL 流转（浏览器托管二进制，不占 JS 堆），
   * 这里记着所有发出去的 URL，换图/放弃时统一 revoke。
   */
  const resultBlobUrls = useRef<Set<string>>(new Set());
  const trackBlobUrl = useCallback(async (dataUrl: string): Promise<string> => {
    const u = await dataUrlToBlobUrl(dataUrl);
    resultBlobUrls.current.add(u);
    return u;
  }, []);
  const revokeAllResultBlobs = useCallback(() => {
    resultBlobUrls.current.forEach(revokeUrl);
    resultBlobUrls.current.clear();
  }, []);
  /** 版本栈上限：超过就淘汰最旧的一版（同时释放其 Blob），A/B 对比窗口够用 */
  const MAX_EDIT_VERSIONS = 12;

  /** 切到某一版（0 = 原图）。这就是 A/B 对比的操作入口。 */
  const selectVersion = useCallback(
    (i: number) => {
      if (i < 0 || i > editVersions.length) return;
      setVersionCursor(i);
      setResultUrl(i === 0 ? null : editVersions[i - 1].url);
    },
    [editVersions]
  );
  /** 记住上一次的编辑请求，供「重试」使用 */
  const lastEdit = useRef<{
    action: EditAction;
    prompt: string;
    selection: SelectionRect | null;
  } | null>(null);
  /** 编辑请求令牌：与识别同理，防止过期响应覆盖新结果 */
  const editSeq = useRef(0);

  /* ---- 图片信息浮层（纯本地能力，不联网） ---- */
  const [infoOpen, setInfoOpen] = useState(false);
  /**
   * 本地工具面板（水印/尺寸/导出）是否打开。
   * 与「信息」面板互斥 —— 两者都浮在画布左上角，同时开会叠在一起。
   */
  const [toolsOpen, setToolsOpen] = useState(false);
  /** 快捷坞指定的工具页签（undefined = 保持面板当前页签） */
  const [toolsTab, setToolsTab] = useState<LocalToolId | undefined>(undefined);
  /** 快捷坞收起状态（记忆到 localStorage，同 railOpen 的偏好处理） */
  const [dockCollapsed, setDockCollapsed] = useState(
    () => localStorage.getItem("aiiv.dockCollapsed") === "1"
  );
  /** 命令面板（Ctrl+K） */
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** 首启引导：从未完成过引导时出现；顶栏「?」可重看 */
  const [onboarding, setOnboarding] = useState(
    () => localStorage.getItem("aiiv.onboardingDone") !== "1"
  );
  const dismissOnboarding = useCallback(() => {
    localStorage.setItem("aiiv.onboardingDone", "1");
    setOnboarding(false);
  }, []);
  /** 打开工具面板并跳到指定页签（快捷坞/命令面板共用） */
  const openToolsTab = useCallback((t: LocalToolId) => {
    setToolsTab(t);
    setToolsOpen(true);
    setInfoOpen(false);
  }, []);

  /**
   * 场景：决定动作条里哪些动作排前面、以及本地工具的顺序。
   * 持久化 —— 用户属于哪类人不会天天变。
   */
  const [sceneId, setSceneId] = useState<SceneId>(() => {
    try {
      return (window.localStorage.getItem("aiiv.scene") as SceneId) || "general";
    } catch {
      return "general";
    }
  });
  /** 取目录部分（批量产物的输出位置）。浏览器 File 场景没有真实路径，返回 null。 */
function dirnameOf(p: string): string | null {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i > 0 ? p.slice(0, i) : null;
}

const scene = getScene(sceneId);
  useEffect(() => {
    try {
      window.localStorage.setItem("aiiv.scene", sceneId);
    } catch {
      /* 记不住就算了 */
    }
  }, [sceneId]);
  /**
   * 缩略图栏默认展开。
   * 依据：Kimi 引 ImageGlass #1738（数千图文件夹切换「几乎不可用」）——
   * 这类文件夹里，**没有缩略图导航本身就是不可用的**，所以默认给，
   * 但保留收起入口（T 键），让「只想安静看一张图」的用户能拿回全宽画布。
   */
  const [railOpen, setRailOpen] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem("aiiv.railOpen") !== "0";
    } catch {
      return true;
    }
  });

  /**
   * AI 面板（右侧结果区）是否展开。
   *
   * 【为什么要有"收起"】用户要的「纯看图模式」：只想看图时，AI 区域不该占着半屏。
   * 收起后右侧留一条细条（可点开），完全对应 IINA 的「侧栏收起」。
   *
   * ⚠️ 配套设计：**面板收起时不自动识别**（见 runAnalyze 的守卫）。
   * 理由很直接 —— 用户选择"只看图"却还在后台调模型扣费，是不对的。
   * 展开时再补一次识别，所以收起不会丢功能，只是不提前花钱。
   *
   * 初始值从 localStorage 取：这是用户偏好，重启该记住。
   */
  const [panelOpen, setPanelOpen] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem("aiiv.panelOpen") !== "0";
    } catch {
      return true;
    }
  });

  // 偏好持久化（失败不影响功能：隐私模式 / 存储被禁都只是记不住而已）
  useEffect(() => {
    try {
      window.localStorage.setItem("aiiv.panelOpen", panelOpen ? "1" : "0");
    } catch {
      /* 记不住就算了，不该因此报错 */
    }
  }, [panelOpen]);

  useEffect(() => {
    try {
      window.localStorage.setItem("aiiv.railOpen", railOpen ? "1" : "0");
    } catch {
      /* 同上 */
    }
  }, [railOpen]);

  /** 纯看图模式：AI 面板 + 缩略图栏一起让位，画布吃满窗口 */
  const pureView = !panelOpen && !railOpen;
  const togglePureView = useCallback(() => {
    const on = !panelOpen && !railOpen;
    // 进入：两个都收；退出：两个都开（一键进出，不用分别操作）
    setPanelOpen(on);
    setRailOpen(on);
  }, [panelOpen, railOpen]);
  const [fileInfo, setFileInfo] = useState<FileInfo | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);
  /** 渲染层报上来的真实像素尺寸（比 EXIF 里的更可信） */
  const [pixelSize, setPixelSize] = useState<{ w: number; h: number } | null>(null);

  /**
   * 缩略图栏**延后挂载** —— 这条是实测逼出来的，不是设计洁癖。
   *
   * 直接挂上缩略图栏后复测性能，首帧从 303ms 掉到 **625ms**：
   * 缩略图的解码和主图在抢同一份 CPU（「第一张图解码」从 +106ms 涨到 +300ms）。
   * 「AI 不能牺牲看图本身」这条纪律同样适用于导航 ——
   * 所以让缩略图等主图解码完之后再上，并用空闲回调让出主线程。
   *
   * 依赖 pixelSize 是有意的：它就是「主图已经解码出来」的信号。
   * 注意本 effect 必须放在 pixelSize 声明之后，否则会踩 TDZ（变量未初始化）把整个应用搞崩。
   */
  const [railReady, setRailReady] = useState(false);
  useEffect(() => {
    if (railReady || !pixelSize) return;
    const cb = () => setRailReady(true);
    const ric = (window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    }).requestIdleCallback;
    if (typeof ric === "function") {
      const id = ric(cb, { timeout: 600 });
      return () => {
        const cic = (window as unknown as { cancelIdleCallback?: (id: number) => void })
          .cancelIdleCallback;
        if (typeof cic === "function") cic(id);
      };
    }
    const t = window.setTimeout(cb, 120);
    return () => window.clearTimeout(t);
  }, [pixelSize, railReady]);

  /**
   * 识别结果 LRU 缓存。
   *
   * 【key 必须带上模型指纹】—— 这是踩过的坑：原 key 只有「路径 + 模式」，
   * 于是用户换了模型之后重新识别，拿到的还是**旧模型**的缓存结果，
   * 会直接误判成「新模型也这么差」。豆包②报告的缓存策略里也明确点了这条：
   * 「按图片哈希 + 模型配置，模型换了要自动失效」。
   */
  const resultCache = useRef<Map<string, string>>(new Map());
  /**
   * 竞态令牌。视觉模型响应可能几秒到几十秒，用户连按翻页时，
   * 早发出的请求可能晚返回并覆盖掉当前图的结果 —— 必须丢弃过期响应。
   */
  const reqToken = useRef(0);

  /**
   * 启动时读设置，并把**缺失的字段用默认值补齐后落盘**。
   *
   * 【为什么要补齐并写回】实测踩过的坑：用户从没在设置页点过「保存」，
   * 于是 settings.json 里只有 7 个键（base_url / api_key / model 等），
   * `iopaint_cmd`、`iopaint_keep_running`、`gen_model` 这些**全都不在文件里**。
   *
   * 界面上看着正常（因为 SettingsPanel 与各处都拿 getDefaultSettings() 兜底），
   * 但 `iopaint_ensure_server` 传的是**原始 settings 对象**，
   * 它读 `settings.iopaint_cmd` 就是 undefined → 「设置里没有可用的启动命令」。
   * 结果：自动启动静默失效，用户只能看到「120 秒没就绪」这种二手提示。
   *
   * 所以这里在启动时就做一次「合并默认值 + 写盘」——
   * 让磁盘上的配置始终是完整的，后续任何只读原始 settings 的调用都拿得到。
   */
    useEffect(() => {
    let live = true;
    loadSettings()
      .then(async (loaded) => {
        if (!live) return;
        const merged = { ...getDefaultSettings(), ...(loaded ?? {}) } as Settings;
        setSettings(merged);
        // 只在「确实缺字段」时写盘，避免每次启动都无谓地改配置文件
        if (loaded && Object.keys(loaded).length < Object.keys(merged).length) {
          try {
            await saveSettings(merged);
          } catch {
            /* 写盘失败不阻断启动：内存里已是完整的，下次再试 */
          }
        }
        // 文件关联启动：argv[1] 是双击的图片 —— 授权并打开它
        try {
          const lp = await getLaunchPath();
          if (live && lp) {
            await grantPath(lp);
            const it = itemFromPath(basename(lp), lp);
            // 必须建 folder：不建的话 folderItems=[] ，批量/缩略图等全部禁用
            setFolder({ items: [it], index: 0 });
            showItem(it, "describe", false);
          }
        } catch {
          /* 启动参数打开失败不阻断启动 */
        }
      })
      .catch(() => {
        if (live) setSettings(getDefaultSettings() as Settings);
      });
    return () => {
      live = false;
    };
  }, []);

  /** 外观主题：settings.theme 变化（含随系统的系统偏好变化）时落到 <html data-theme> */
  const [darkOn, setDarkOn] = useState(
    () => document.documentElement.dataset.theme !== "light"
  );
  useEffect(() => {
    applyTheme(settings?.theme);
    setDarkOn(document.documentElement.dataset.theme !== "light");
  }, [settings?.theme]);

  /** 顶栏太阳/月亮快捷切换：立即应用 + 写盘 + 同步状态 */
  const handleThemeQuick = useCallback(async (t: "dark" | "light") => {
    applyTheme(t);
    setDarkOn(t === "dark");
    const s = { ...(settingsRef.current || getDefaultSettings()), theme: t } as Settings;
    setSettings(s);
    try {
      await saveSettings(s);
    } catch {
      /* 写盘失败不影响本次视觉生效 */
    }
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      applyTheme(settingsRef.current?.theme);
      setDarkOn(document.documentElement.dataset.theme !== "light");
    };
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  /** Ctrl+K / Cmd+K 呼出命令面板（D 方案：搜索式万能出口） */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /**
   * settings 的 ref 镜像。
   * showItem 是 useCallback 且依赖里没有 settings —— 直接把 settings 加进去会让
   * 每次设置变化都重建 showItem，进而重建 applyFolder/go/键盘监听。
   * 用 ref 读最新值既避免闭包过期，又不动依赖（本项目被 stale closure 咬过一次）。
   */
  const settingsRef = useRef<Settings | null>(null);
  settingsRef.current = settings;

  /** 模型指纹：影响识别结果的配置变了，缓存就必须失效 */
  const modelFingerprint = (s: Settings | null) =>
    s ? `${s.base_url}|${s.model}` : "";

  const cacheKey = (
    item: ImageItem,
    m: AnalyzeMode,
    s: Settings | null = settings
  ) => `${item.path}|${m}|${modelFingerprint(s)}`;

  const cacheGet = (k: string): string | undefined => {
    const v = resultCache.current.get(k);
    if (v === undefined) return undefined;
    resultCache.current.delete(k); // LRU：命中后移到队尾
    resultCache.current.set(k, v);
    return v;
  };

  const cacheSet = (k: string, v: string) => {
    resultCache.current.delete(k);
    resultCache.current.set(k, v);
    while (resultCache.current.size > RESULT_CACHE_MAX) {
      const oldest = resultCache.current.keys().next().value;
      if (oldest === undefined) break;
      resultCache.current.delete(oldest);
    }
  };

  /**
   * 邻图预热：用 new Image() 触发一次加载，把解码结果放进 Chromium 的
   * 图片内存缓存，翻页时就不用等解码。只对「更大更慢」的图有实际意义，
   * 但成本极低、失败无副作用，所以统一做。
   */
  const warmed = useRef<Set<string>>(new Set());
  const warmNeighbors = useCallback((f: OpenedFolder, i: number) => {
    [i - 1, i + 1].forEach((j) => {
      if (j < 0 || j >= f.items.length) return;
      const url = f.items[j].url;
      if (!url || warmed.current.has(url)) return;
      warmed.current.add(url);
      const im = new Image();
      im.decoding = "async";
      im.src = url;
    });
  }, []);

  /**
   * 对指定条目跑识别。产品纪律：没配模型 = 安静的纯看图器，不甩红色报错。
   * AI 是加分项，不是看图的前置条件。
   */
  const runAnalyze = useCallback(
    async (item: ImageItem, m: AnalyzeMode, force = false) => {
      // 对话模式由用户逐句驱动，不随换图/切模式自动发起
      if (m === "chat") {
        setLoading(false);
        return;
      }
      /**
       * 【纯看图守卫】AI 面板收起时不自动识别。
       *
       * 用户在"纯看图模式"下翻页，不该在后台一张张调模型扣费 ——
       * 那不叫纯看图，那叫默默花钱。展开面板时会补一次识别（见 openPanel 的 effect），
       * 所以收起只是"不提前花钱"，不丢任何功能。
       * force=true（用户主动重试 / 手动切模式）仍然照做 —— 那是明确意图。
       */
      if (!panelOpen && !force) {
        setLoading(false);
        setInstant(false);
        setError(null);
        return;
      }
      // 先取设置，再算缓存 key —— key 里含模型指纹，顺序反了会算出错的 key
      const s = settings ?? (await loadSettings());
      const key = cacheKey(item, m, s);

      if (!force) {
        const hit = cacheGet(key);
        if (hit !== undefined) {
          setNeedSetup(false);
          setError(null);
          setLoading(false);
          setInstant(true);
          setResult(hit);
          return;
        }
      }

      // 本地服务（Ollama / LM Studio）不需要 Key，别把它当成「还没配置」
      if (!s.api_key.trim() && !keyOptional(s)) {
        setNeedSetup(true);
        setLoading(false);
        setInstant(false);
        setResult("");
        setError(null);
        return;
      }

      setNeedSetup(false);
      setError(null);
      setResult("");
      setInstant(false);
      setLoading(true);

      const token = ++reqToken.current;
      try {
        const text = await analyzeItem(item, s, m);
        if (token !== reqToken.current) return; // 已被更新的请求取代，丢弃
        cacheSet(key, text);
        setResult(text);
      } catch (e) {
        if (token !== reqToken.current) return;
        setError(friendlyError(e instanceof Error ? e.message : String(e)));
      } finally {
        if (token === reqToken.current) setLoading(false);
      }
    },
    [settings, panelOpen]
  );

  /** 显示一张图并触发识别 */
  const showItem = useCallback(
    (item: ImageItem, m: AnalyzeMode, force = false) => {
      setImage(item);
      // 换图必须清掉编辑态：上一张的选区/结果放到新图上都是错的
      setSelection(null);
      revokeAllResultBlobs(); // 上一张的结果 Blob 一并释放（P1.8）
      setResultUrl(null);
      /**
       * 版本栈也必须清 —— 它属于**某一张图**，不是整个会话。
       * 不清的话，翻到下一张还能切到上一张的改图版本，那是明显的错误。
       */
      setEditVersions([]);
      setVersionCursor(0);
      setEditPhase({ kind: "idle" });
      editSeq.current++;
      /**
       * 【默认不自动识别】只切图、不调模型。
       *
       * 从前这里是直接 runAnalyze —— 翻一张算一次钱。用户只是想快速浏览时，
       * 钱在不知不觉地花，而且每张都要等模型返回。
       * 现在改成：切完图就停，等用户点「识别这张图」（或用别的模式）。
       * 设置里可以打开 auto_analyze 恢复老行为。
       * force=true 仍然照做（那是用户主动点的重试）。
       */
      if (!force && !settingsRef.current?.auto_analyze) {
        setLoading(false);
        setInstant(false);
        setError(null);
        setResult("");
        return;
      }
      return runAnalyze(item, m, force);
    },
    [runAnalyze]
  );

  /**
   * 从一个已构建好的 OpenedFolder 直接跳到第 i 张。
   * 注意：新增初始化流程务必走这里，不要写成 setFolder(f) + 再读 state.folder ——
   * React 状态更新是异步的，后续读取会拿到旧值（本项目曾被这个坑咬过一次）。
   */
  const applyFolder = useCallback(
    async (f: OpenedFolder, i: number) => {
      if (i < 0 || i >= f.items.length) return;
      setFolder(f);
      setIndex(i);
      warmNeighbors(f, i);
      await showItem(f.items[i], mode);
    },
    [mode, showItem, warmNeighbors]
  );

  /** 翻页（环形）：首张按左到末张、末张按右回转首张 */
  const go = useCallback(
    async (delta: number) => {
      if (!folder) return;
      const n = folder.items.length;
      let ni = index + delta;
      if (ni < 0) ni = n - 1;
      else if (ni >= n) ni = 0;
      setIndex(ni);
      warmNeighbors(folder, ni);
      await showItem(folder.items[ni], mode);
    },
    [folder, index, mode, showItem, warmNeighbors]
  );

  /**
   * 跳到指定序号（缩略图栏点击用）。
   * 与 go(±1) 的区别只是「目标由调用方给定」，其余流程必须一致 ——
   * 同样要预热邻图、同样要清掉上一张的编辑态（showItem 内部处理），
   * 否则从缩略图跳过去会漏掉预加载，翻页手感就不一致了。
   */
  const goTo = useCallback(
    async (i: number) => {
      if (!folder) return;
      const n = folder.items.length;
      if (i < 0 || i >= n || i === index) return;
      setIndex(i);
      warmNeighbors(folder, i);
      await showItem(folder.items[i], mode);
    },
    [folder, index, mode, showItem, warmNeighbors]
  );

  /** 启动文件夹：设置里配了 startup_dir 时，打开软件自动加载该目录（一次会话只执行一次） */
  const bootFolder = useRef(false);
  useEffect(() => {
    if (bootFolder.current || !settings) return;
    bootFolder.current = true;
    const dir = (settings.startup_dir || "").trim();
    if (!dir) return;
    (async () => {
      try {
        await grantPath(dir); // 启动目录 = 用户配置，先授权命令层再加载
        const f = await openFolderAt(dir);
        if (f && f.items.length) await applyFolder(f, 0);
      } catch {
        /* 目录不存在/为空就算了，不打扰 */
      }
    })();
  }, [settings, applyFolder]);

  // 打开单张图片 → 同时列出同级目录，使翻页可用
  const handleOpen = useCallback(async () => {    try {
      const img = await openImage();
      if (!img) return;
      const f = await openFolderAt(dirname(img.path), img.path);
      await applyFolder(f ?? { items: [img], index: 0 }, f ? f.index : 0);
    } catch (e) {
      setError(friendlyError(e instanceof Error ? e.message : String(e)));
    }
  }, [applyFolder]);

  const handleOpenFolder = useCallback(async () => {
    try {
      const f = await openFolder();
      if (f) await applyFolder(f, f.index);
    } catch (e) {
      // 原实现没有 try/catch：目录读不了（权限/被占用）时界面毫无反应
      setError(friendlyError(e instanceof Error ? e.message : String(e)));
    }
  }, [applyFolder]);

  // 拖拽图片（无目录上下文，按单图处理）
  const handleDropFile = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const item = itemFromFile(file.name, dataUrl);
        setFolder({ items: [item], index: 0 });
        setIndex(0);
        showItem(item, mode);
        /**
         * 拖入图片**异步落盘**（2026-10-04）：
         * HTML5 拖放拿不到真实路径，itemFromFile 只能造假路径（path=文件名），
         * 导致批量处理、另存为防覆盖等所有依赖真实路径的工具全部失效。
         * 落盘拿到真实路径后把 folder 换成真路径版本 —— 拖入图从此与
         * 「打开文件」完全等价。失败时静默保留旧条目（识别/预览不受影响）。
         */
        void (async () => {
          try {
            const r = await saveDrop(file.name, dataUrl);
            const real: ImageItem = { name: file.name, path: r.path, url: dataUrl };
            setFolder({ items: [real], index: 0 });
            setImage((cur) => (cur && cur.path === item.path ? real : cur));
          } catch {
            /* 落盘失败：保持假路径条目，仅部分工具受限 */
          }
        })();
      };
      reader.onerror = () => setError("读取文件失败");
      reader.readAsDataURL(file);
    },
    [mode, showItem]
  );

  /** 切换识别模式：命中缓存就秒出，否则重新调用（并丢弃上一模式的在途响应）。 */
  /**
   * 切换识别模式。
   *
   * 【只切模式，不发起识别】—— 这条是实测后改的：
   * 原来切到「提取文字」会**立刻**跑一次识别。但用户点标签的意图可能是
   * 「先看看这个标签是干嘛的」「打算切过去再点识别」——那一瞬间钱就花了，
   * 而他并没有做过"要识别"这个决定。这跟"由用户决定是否用 AI"直接冲突。
   * 现在切模式只改状态，真正发起识别只能靠面板上的「识别这张图」。
   */
  const handleModeChange = useCallback((m: AnalyzeMode) => {
    setMode(m);
    /**
     * 【切模式必须清结果 —— 这是实测逼出来的产品决策】
     * 用户把「提取文字」跑出的内容当成 OCR 结果，实际那还是
     * 上一次「理解图片」的缓存结果（切模式不自动重新识别，见上）。
     * 旧结果不清，就会一直被误读成新模式的输出。
     * 旧结果仍在缓存里（key 含 mode），点「识别这张图」立刻拿回；
     * 描述类的旧结果也不会丢 —— 切回原模式重新识别是缓存命中，秒回。
     */
    setResult("");
    setInstant(false);
  }, []);

  // 移入回收站（带确认，避免误删；回收站可找回）
  const deleteCurrent = useCallback(async () => {
    if (!folder) return;
    const item = folder.items[index];
    if (!item) return;
    if (!window.confirm(`确定将「${item.name}」移入回收站？`)) return;

    const newItems = folder.items.filter((_, j) => j !== index);
    if (!newItems.length) {
      setFolder(null);
      setImage(null);
      setResult("");
      setIndex(0);
      return;
    }

    // 真实路径（Electron/Tauri）才真正删文件；浏览器仅从本会话列表移除
    if (isRealPath(item.path)) {
      try {
        await trashImage(item.path);
      } catch (e) {
        setError(friendlyError(e instanceof Error ? e.message : String(e)));
        return;
      }
    }

    resultCache.current.delete(cacheKey(item, mode));
    const newIndex = index >= newItems.length ? newItems.length - 1 : index;
    await applyFolder({ items: newItems, index: newIndex }, newIndex);
  }, [folder, index, mode, applyFolder]);

  const handleRetry = useCallback(() => {
    if (image) runAnalyze(image, mode, true);
  }, [image, mode, runAnalyze]);

  /* ------------------------------------------------------------------ */
  /* 图片信息（本地，按需读取 —— 面板没打开就不读盘）                      */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    if (!infoOpen || !image) {
      setFileInfo(null);
      return;
    }
    let alive = true;
    setInfoLoading(true);
    readFileInfo(image.path)
      .then((i) => {
        if (alive) setFileInfo(i);
      })
      .catch(() => {
        if (alive) setFileInfo(null);
      })
      .finally(() => {
        if (alive) setInfoLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [infoOpen, image]);

  // 换图时先清掉上一张的像素尺寸，避免信息面板显示错位的数字
  useEffect(() => {
    setPixelSize(null);
  }, [image?.path]);

  /* ------------------------------------------------------------------ */
  /* AI 视觉编辑（P1.5）                                                 */
  /* ------------------------------------------------------------------ */

  const editCfg = useMemo(
    () => resolveEditConfig(settings ?? getDefaultSettings()),
    [settings]
  );
  /**
   * 动作清单：先按服务商能力过滤（避免点了必失败的按钮），再按场景排序。
   * 用「排序」而不是「过滤」——藏起来的功能用户只会以为做不到。
   */
  const editActions = useMemo(
    () => orderActions(actionsFor(editCfg.provider), scene),
    [editCfg.provider, scene]
  );

  /** 送去做编辑的底图：有结果时就在结果上继续改（支持多轮迭代） */
  const displayUrl = resultUrl ?? image?.url ?? "";

  const runEdit = useCallback(
    async (action: EditAction, prompt: string) => {
      if (!image || !displayUrl) return;

      const s = settings ?? (await loadSettings());
      const cfg = resolveEditConfig(s);
      if (!cfg.apiKey.trim()) {
        setEditPhase({
          kind: "error",
          label: action.label,
          message:
            "还没填 API Key。AI 编辑需要密钥，请到「设置 → 图像编辑」配置；" +
            "不想上传图片的话，不配也能继续把它当纯看图器用。",
        });
        return;
      }

      // 只有「需要选区」的动作才带遮罩；其余走整图编辑
      const sel = action.needsSelection ? selection : null;
      lastEdit.current = { action, prompt, selection: sel };
      const seq = ++editSeq.current;
      setEditPhase({ kind: "working", label: action.label });

      try {
        // 归一化尺寸 + 生成遮罩（尺寸必须落在服务商要求的 512–4096，且遮罩要与底图同分辨率）
        const prep = await prepareEditImages(
          displayUrl,
          sel,
          sel ? cfg.maskMode : null
        );
        if (seq !== editSeq.current) return;

        const res = await editImage({
          provider: cfg.provider,
          baseUrl: cfg.baseUrl,
          model: cfg.model,
          apiKey: cfg.apiKey,
          dsFunction: action.dsFunction,
          prompt: action.buildPrompt(prompt),
          baseImage: prep.baseDataUrl,
          maskImage: prep.maskDataUrl,
          width: prep.width,
          height: prep.height,
        });
        if (seq !== editSeq.current) return;

        // P1.8：dataURL → Blob URL 再进版本栈（降常驻内存），保存时才转回
        const blobUrl = await trackBlobUrl(res.dataUrl);
        setResultUrl(blobUrl);
        // 版本栈：把这一版压进去并把游标移到它上面（游标 = 版本数，因为 0 是原图）
        const nextIdx = Math.min(editVersions.length + 1, MAX_EDIT_VERSIONS);
        setEditVersions((v) => {
          const next = [
            ...v,
            {
              url: blobUrl,
              label: action.label,
              prompt,
              requestId: res.requestId,
            },
          ];
          // 超上限淘汰最旧的一版（连带释放其 Blob URL）
          while (next.length > MAX_EDIT_VERSIONS) {
            const dropped = next.shift();
            if (dropped) revokeUrl(dropped.url);
          }
          return next;
        });
        setVersionCursor(nextIdx);
        // 结果尺寸可能与原图不同，旧选区会错位 —— 清掉
        setSelection(null);
        setEditPhase({ kind: "done", label: action.label, requestId: res.requestId });
      } catch (e) {
        if (seq !== editSeq.current) return;
        setEditPhase({
          kind: "error",
          label: action.label,
          message: friendlyError(e instanceof Error ? e.message : String(e)),
        });
      }
    },
    [displayUrl, image, selection, settings, editVersions]
  );

  const handleSaveEditResult = useCallback(async () => {
    if (!image) return;
    /**
     * 【2026-10-04】没有编辑结果时不再静默返回 —— 那正是用户点「另存」
     * 「毫无反应」的直接原因。现在语义改为：把**当前看到的图**（原图或
     * 某一版编辑结果）另存为副本。软件的非破坏性设计里「另存」本来就是
     * 唯一的导出口，没编辑过也应该能导出原图。
     */
    const src = resultUrl ?? displayUrl;
    if (!src) return;
    try {
      const dataUrl = await imageUrlToDataUrl(src);
      const r = await saveResultImage(image.path, dataUrl, image.name);
      setEditPhase((p) =>
        p.kind === "done"
          ? r.saved
            ? { ...p, savedPath: r.path, message: undefined }
            : { ...p, message: r.message || "未保存" }
          : p
      );
    } catch (e) {
      // 另存失败绝不能静默：错误渲染到编辑结果条上（done 态才有该条），
      // 用户能看到「为什么点了另存没文件」
      const msg = friendlyError(e instanceof Error ? e.message : String(e));
      setEditPhase((p) =>
        p.kind === "done" ? { ...p, message: "另存失败：" + msg } : p
      );
    }
  }, [image, resultUrl, displayUrl]);

  const handleDiscardEditResult = useCallback(() => {
    editSeq.current++;
    revokeAllResultBlobs();
    setResultUrl(null);
    setSelection(null);
    setEditPhase({ kind: "idle" });
    // 放弃 = 整栈清掉，回到原图。语义保持原样（"这些改动我都不要了"），
    // 所以这里不是"只丢当前这一版"—— 那会让人以为历史还在。
    setEditVersions([]);
    setVersionCursor(0);
  }, [revokeAllResultBlobs]);

  const handleRetryEdit = useCallback(() => {
    const last = lastEdit.current;
    if (!last) {
      handleDiscardEditResult();
      return;
    }
    setSelection(last.selection);
    setResultUrl(null);
    // 重试保留已有版本：它会产生**新的一版**，历史仍然可比（这正是版本栈的意义）
    void runEdit(last.action, last.prompt);
  }, [handleDiscardEditResult, runEdit]);

/* ------------------------------------------------------------------ */
  /* 对话：围绕当前图片和 AI 多轮交谈                                      */
  /* ------------------------------------------------------------------ */

  const [chatLog, setChatLog] = useState<ChatMsg[]>([]);
  const [chatThinking, setChatThinking] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);

  // 换图 / 删除图片时清空对话 —— 上一张图的语境对下一张是错的
  useEffect(() => {
    setChatLog([]);
    setChatError(null);
    setChatThinking(false);
  }, [image?.path]);

  const handleChatSend = useCallback(
    async (text: string) => {
      if (!image) return;
      const s = settings ?? (await loadSettings());
      // 本地服务不需要 Key，对话也不能拦（否则本地模型只能看图不能问）
      if (!s.api_key.trim() && !keyOptional(s)) {
        setChatError("先在「设置」里填写 API Key 才能对话");
        return;
      }
      const userMsg: ChatMsg = { role: "user", content: text };
      setChatLog((prev) => [...prev, userMsg]);
      setChatError(null);
      setChatThinking(true);
      try {
        const reply = await chatWithImage(image, s, chatLog, text);
        setChatLog((prev) => [...prev, { role: "assistant", content: reply }]);
      } catch (e) {
        setChatError(friendlyError(e instanceof Error ? e.message : String(e)));
      } finally {
        setChatThinking(false);
      }
    },
    [image, settings, chatLog]
  );

  /**
   * 「按这句话去改图」：把对话里聊清楚的描述交给图像编辑通道。
   * 默认走整图编辑（对话里通常聊的是整体想法）；想局部改，用框选。
   */
  const handleChatEdit = useCallback(
    (prompt: string) => {
      // 「整图改」是唯一既不用框选、又吃描述的动作 —— 对话聊出来的描述正好喂给它
      const action = editActions.find((a) => a.id === "whole");
      if (!action) {
        setChatError("当前编辑服务商不支持按描述改图");
        return;
      }
      void runEdit(action, prompt);
    },
    [editActions, runEdit]
  );

  /** ImageView 的编辑相关 props（memo 住，避免每帧重建导致事件监听反复注册） */
  const imageEditProps = useMemo(
    () => ({
      phase: editPhase,
      actions: editActions,
      providerName: editCfg.providerName,
      supportsSelection: true,
      selection,
      onSelectionChange: setSelection,
      // 版本栈（A/B 对比）
      versionCount: editVersions.length,
      versionCursor,
      onSelectVersion: selectVersion,
      onRunAction: runEdit,
      onSave: handleSaveEditResult,
      onDiscard: handleDiscardEditResult,
      onRetry: handleRetryEdit,
    }),
    [
      editPhase,
      editActions,
      editCfg.providerName,
      selection,
      runEdit,
      handleSaveEditResult,
      handleDiscardEditResult,
      handleRetryEdit,
      editVersions.length,
      versionCursor,
      selectVersion,
    ]
  );

  const handleSaveSettings = useCallback(
    async (s: Settings) => {
      await saveSettings(s);
      setSettings(s);
      /**
       * 设置变了 → 清空识别缓存。
       * 缓存 key 里已经带了模型指纹（换了模型天然不会命中旧结果），
       * 这里再清一次是为了**立刻释放内存**，并且让「换了 Key / 地址」这类
       * 指纹看不出来的变化也一并失效 —— 换 Key 后重新识别不该复用旧结果。
       */
      resultCache.current.clear();
      /**
       * 刚配好 Key、且刚才被"没配模型"挡住过 → 补一次识别，不必重开图片。
       *
       * 但也要求 auto_analyze 开着：这条虽然只在"你被卡住"时触发，
       * 仍属于**用户没点识别就花钱**。默认关时，配完 Key 面板会变成
       * 「这张图还没有识别」+ 按钮，点一下就行 —— 多一次点击，换来的是
       * "任何一次花费都是我点的"，这个交换是值得的。
       */
      if (
        s.auto_analyze &&
        (s.api_key.trim() || keyOptional(s)) &&
        image &&
        (needSetup || error)
      ) {
        await runAnalyze(image, mode, true);
      }
    },
    [image, needSetup, error, mode, runAnalyze]
  );

  // 快捷键：←/→ 翻页，Delete 回收站，⌘/Ctrl+O 打开图片，⌘/Ctrl+, 设置，Esc 关闭设置
  // （缩放类快捷键在 ImageView 内处理，浏览键绝不为 AI 功能让路）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSettingsOpen(false);
        return;
      }
      const tag = (e.target as HTMLElement | null)?.tagName;
      const typing = tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT";
      if (!typing && folder) {
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          void go(-1);
          return;
        }
        if (e.key === "ArrowRight") {
          e.preventDefault();
          void go(1);
          return;
        }
        if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          void deleteCurrent();
          return;
        }
      }
      // W：开关工具面板（键盘优先路线；工具面板此前无快捷键）
      if (!typing && e.key.toLowerCase() === "w" && !mod(e)) {
        e.preventDefault();
        setToolsOpen((v) => !v);
        // 与顶栏「工具」按钮同一套互斥：开工具面板时收起信息浮层，
        // 否则键盘路径两个浮层会叠在画布左上角（鼠标路径是对的，键盘漏了）
        setInfoOpen(false);
        return;
      }
      if (mod(e) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void handleOpen();
      }
      if (mod(e) && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      }
      // I：切换图片信息浮层（单键，不占修饰键；打字时不触发）
      if (!typing && !mod(e) && !e.altKey && e.key.toLowerCase() === "i") {
        e.preventDefault();
        setInfoOpen((v) => !v);
        // 互斥对偶：开信息浮层时收起工具面板（与鼠标路径、W 键一致）
        setToolsOpen(false);
      }
      // T：收起/展开缩略图栏 —— 只想安静看一张图时把画布还给用户
      if (!typing && !mod(e) && !e.altKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        setRailOpen((v) => !v);
      }
      // A：收起/展开 AI 面板（面板收起时不再自动识别，见 runAnalyze 的守卫）
      if (!typing && !mod(e) && !e.altKey && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setPanelOpen((v) => !v);
      }
      // Z：纯看图模式（AI 面板 + 缩略图栏一起让位），一键进出
      if (!typing && !mod(e) && !e.altKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        togglePureView();
      }
      /**
       * [ / ] ：在「原图 ↔ 各版改图」之间来回切 —— A/B 对比的键盘入口。
       * 用方括号是因为它不占字母键、且"上一个/下一个"的方向感直观。
       * 只有真的有版本时才拦截，否则不该吃掉这两个键。
       */
      if (!typing && !mod(e) && editVersions.length > 0) {
        if (e.key === "[" || e.key === "]") {
          e.preventDefault();
          const next = e.key === "["
            ? Math.max(0, versionCursor - 1)
            : Math.min(editVersions.length, versionCursor + 1);
          selectVersion(next);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [folder, go, deleteCurrent, handleOpen, togglePureView, editVersions.length, versionCursor, selectVersion]);

  /** IINA 灵魂：看图时界面自动隐去，鼠标一动就回来。
   *
   * 这是 IINA 最定义性的一条 —— 用户在看内容时，界面应该消失；
   * 之前那版只把顶栏从 #0d0d0d 调成 rgba(12,12,13,.78)，在纯黑背景上肉眼无差，
   * 用户反馈「看不出变化」是完全对的。
   *
   * 规则（刻意保守，避免"正在用时界面自己跑了"）：
   *   · 只有打开了图片才启用（空状态不动）
   *   · 2.4s 没有鼠标/键盘/滚轮动作才隐去
   *   · **已有选区时不隐** —— 这条是硬性的：侧栏一收起，画布就变宽，
   *     选区是相对画布算的，会跟着图片一起挪位（等于用户框好的区域自己跑了）。
   *     而且选择工具栏的输入态在锚点变化时会被重置，正在输描述就被清空。
   *   · 设置面板、编辑结果条、图片信息浮层打开时不隐
   */
  const [chromeHidden, setChromeHidden] = useState(false);
  useEffect(() => {
    if (!image || settingsOpen || editPhase.kind !== "idle" || infoOpen || selection) {
      setChromeHidden(false);
      return;
    }
    let timer = 0;
    const arm = () => {
      window.clearTimeout(timer);
      setChromeHidden(false);
      timer = window.setTimeout(() => setChromeHidden(true), 2400);
    };
    arm();
    window.addEventListener("mousemove", arm, { passive: true });
    window.addEventListener("wheel", arm, { passive: true });
    window.addEventListener("keydown", arm);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("mousemove", arm);
      window.removeEventListener("wheel", arm);
      window.removeEventListener("keydown", arm);
    };
  }, [image, settingsOpen, editPhase, infoOpen, selection]);

  return (
    <div className={"app" + (chromeHidden ? " chrome-hidden" : "")}>
      <header className="topbar">
        <div className="topbar-left">
          <span className="brand">AI Image Viewer</span>
        </div>

        {/* 文件名当「文档标题」居中 —— IINA / macOS 文档窗口的做法。
            左右箭头与计数紧贴标题，让"我在哪张图"一眼可读。
            容器保留 .nav 类：自检里用 `.nav .btn` 定位删除按钮，改动别把它弄丢。 */}
        <div className="nav topbar-center">
          {image && (
            <span className="doc-title" title={image.name}>
              {image.name}
            </span>
          )}
          {folder && (
            <>
              <button
                className="btn nav-btn"
                onClick={() => go(-1)}
                title="上一张 (←)"
              >
                ‹
              </button>
              <span className="counter">
                {index + 1} / {folder.items.length}
              </span>
              <button className="btn nav-btn" onClick={() => go(1)} title="下一张 (→)">
                ›
              </button>
              <button
                className="btn"
                onClick={deleteCurrent}
                title="移入回收站 (Delete)"
              >
                删除
              </button>
            </>
          )}
        </div>

        <div className="actions">
          {/* 视图组：纯看图 / 缩略图 / 场景 / 工具 / 信息 */}
          <div className="grp">
            <button
              className={"btn" + (pureView ? " active" : "")}
              onClick={togglePureView}
              title="纯看图模式：收起 AI 面板与缩略图栏 (Z)"
            >
              纯看图
            </button>
            {folder && folder.items.length > 1 && (
              <button
                className={"btn" + (railOpen ? " active" : "")}
                onClick={() => setRailOpen((v) => !v)}
                title="缩略图导航 (T)"
              >
                缩略图
              </button>
            )}
            {/* 场景选择：决定动作顺序与本地工具顺序，不是开关而是"你是谁" */}
            <select
              className="scene-select"
              value={sceneId}
              onChange={(e) => setSceneId(e.target.value as SceneId)}
              title={scene.audience}
            >
              {SCENES.map((sc) => (
                <option key={sc.id} value={sc.id}>
                  {sc.name}
                </option>
              ))}
            </select>
            <button
              className={"btn" + (toolsOpen ? " active" : "")}
              onClick={() => {
                setToolsOpen((v) => !v);
                setInfoOpen(false); // 两块浮层同在左上角，互斥
              }}
              title="本地工具：加水印 / 改尺寸 / 导出文字（不上传、不花钱）"
            >
              工具
            </button>
            <button
              className={"btn" + (infoOpen ? " active" : "")}
              onClick={() => {
                setInfoOpen((v) => !v);
                setToolsOpen(false);
              }}
              title="图片信息与 EXIF (I)"
            >
              信息
            </button>
          </div>
          {/* 文件组 */}
          <div className="grp">
            <button className="btn" onClick={handleOpen}>
              打开图片
            </button>
            <button className="btn" onClick={handleOpenFolder}>
              打开文件夹
            </button>
          </div>
          {/* AI 组 */}
          <div className="grp">
            <button
              className="btn ai-btn"
              onClick={() => setGenOpen(true)}
              title="AI 生成配图（文生图 / 图生图，走你的网关，免费）"
            >
              AI 生成
            </button>
          </div>
          {/* 系统组 */}
          <div className="grp">
            <button
              className="btn"
              onClick={() => handleThemeQuick(darkOn ? "light" : "dark")}
              title={darkOn ? "切换到白天模式" : "切换到黑夜模式"}
            >
              {darkOn ? "☀️" : "🌙"}
            </button>
            <button
              className="btn"
              onClick={() => setOnboarding(true)}
              title="帮助与引导（命令面板：Ctrl+K）"
            >
              ?
            </button>
            <button className="btn" onClick={() => setSettingsOpen(true)}>
              设置
            </button>
          </div>
        </div>
      </header>

      <main className="body">
        {!image && onboarding && (
          <EmptyState
            onOpenImage={() => {
              dismissOnboarding();
              void handleOpen();
            }}
            onOpenFolder={() => {
              dismissOnboarding();
              void handleOpenFolder();
            }}
            onDismiss={dismissOnboarding}
          />
        )}
        {railOpen && folder && folder.items.length > 1 && (
          <ThumbnailRail
            items={folder.items}
            index={index}
            onSelect={(i) => goTo(i)}
            onClose={() => setRailOpen(false)}
            // 栏子立刻挂上（布局从第一帧起就稳定），只把缩略图加载推迟到主图解码之后
            thumbsReady={railReady}
          />
        )}
        <ImageView
          image={image}
          displayUrl={displayUrl}
          onOpen={handleOpen}
          onDropFile={handleDropFile}
          edit={imageEditProps}
          onNaturalSize={setPixelSize}
          overlay={
            <>
              {infoOpen && image && (
                <InfoPanel
                  info={fileInfo}
                  loading={infoLoading}
                  pixelSize={pixelSize}
                  onClose={() => setInfoOpen(false)}
                />
              )}
              {toolsOpen && image && (
                <LocalToolsPanel
                  initialTab={toolsTab}
                  scene={scene}
                  sourceUrl={displayUrl}
                  selection={selection}
                  sourceDir={folder && folder.items[0] ? dirnameOf(folder.items[0].path) : null}
                  folderItems={folder ? folder.items.map((i) => ({ name: i.name, path: i.path })) : []}
                  exportText={result}
                  imageName={image.name}
                  busy={editPhase.kind === "working"}
                  onProduce={(dataUrl, label) => {
                    // 本地处理结果走**同一条**非破坏性流程：可对比原图、必须另存为
                    editSeq.current++;
                    /**
                     * 【2026-10-04】错误必须可见 —— 这条链曾经被 CSP 拦截
                     * （connect-src 没有 data:，fetch(data:) 被拒），而 void
                     * 吞掉了 rejection：状态条显示「处理完成」，画布却永远
                     * 不更新，另存也走同一 fetch 同样无声失败。
                     * 现在任何失败都会落进 error 状态让人看见。
                     */
                    trackBlobUrl(dataUrl)
                      .then((u) => {
                        resultBlobUrls.current.add(u);
                        setResultUrl(u);
                        setSelection(null);
                        setEditPhase({ kind: "done", label, local: true });
                      })
                      .catch((e) => {
                        setEditPhase({
                          kind: "error",
                          label,
                          message: "结果显示失败：" + (e instanceof Error ? e.message : String(e)),
                        });
                      });
                  }}
                  onExport={(text, filename) => {
                    // 把落盘结果交回 LocalToolsPanel：成功/取消/失败都要在
                    // 导出按钮旁边有回执，不能 void 掉变成静默
                    return exportTextFile(text, filename);
                  }}
                  onOpenFolderDir={(dir) => {
                    // 批量/多平台产物目录 → 在应用内打开为当前相册
                    void (async () => {
                      const f = await openFolderAt(dir);
                      if (f) await applyFolder(f, 0);
                    })();
                  }}
                  onClose={() => setToolsOpen(false)}
                />
              )}
            </>
          }
        />
        {panelOpen ? (
        <ResultPanel
          result={result}
          loading={loading}
          error={error}
          imageName={image?.name}
          needSetup={needSetup}
          hasImage={Boolean(image)}
          mode={mode}
          instant={instant}
          onModeChange={handleModeChange}
          onSetup={() => setSettingsOpen(true)}
          onRetry={handleRetry}
          // 默认不自动识别，所以面板上的「识别这张图」就是用户发起 AI 的入口
          onAnalyze={() => {
            if (image) void runAnalyze(image, mode, true);
          }}
          modelName={settings?.model}
          chat={{
            messages: chatLog,
            thinking: chatThinking,
            error: chatError,
            disabled: !image || needSetup,
            canEdit: editActions.some((a) => a.id === "whole"),
            onSend: handleChatSend,
            onEditWithPrompt: handleChatEdit,
            // 「问 AI」入口：从摘要卡片一键切到对话面板（ChatGPT 四层结构的最后一层）
            onAsk: () => handleModeChange("chat"),
          }}
        />
        ) : (
          /* 收起态：右侧留一条细条。点它（或按 A / Z）就能展开 ——
             不做成"完全消失"，否则用户找不到回来的路。
             取向对齐 IINA：侧栏收起时留一个可点的边沿。 */
          <button
            className="result-strip"
            onClick={() => setPanelOpen(true)}
            title="展开 AI 面板 (A)"
          >
            <span className="strip-chevron">‹</span>
            <span className="strip-label">AI 识别</span>
          </button>
        )}
      </main>

      {/* 场景快捷坞（UI 方案 v0.3 / M1）：有图且非纯看图模式时出现 */}
      {image && !pureView && (
        <QuickDock
          collapsed={dockCollapsed}
          activeTab={toolsOpen ? toolsTab : undefined}
          onOpenTab={openToolsTab}
          onToggleCollapse={() => {
            setDockCollapsed((v) => {
              localStorage.setItem("aiiv.dockCollapsed", v ? "0" : "1");
              return !v;
            });
          }}
        />
      )}

      {/* 命令面板（Ctrl+K）：搜索式万能出口 */}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        hasImage={Boolean(image)}
        commands={[
          { id: "inpaint", icon: "🪄", label: "去水印（框选区域）", hint: "W", needsImage: true, run: () => openToolsTab("inpaint") },
          { id: "watermark", icon: "🛡️", label: "加水印", needsImage: true, run: () => openToolsTab("watermark") },
          { id: "resize", icon: "📐", label: "改尺寸", needsImage: true, run: () => openToolsTab("resize") },
          { id: "batch", icon: "📦", label: "批量处理", needsImage: true, run: () => openToolsTab("batch") },
          { id: "analyze", icon: "🔍", label: "识别这张图", needsImage: true, run: () => { if (image) void runAnalyze(image, mode, true); } },
          { id: "gen", icon: "✨", label: "AI 生成（文生图/图生图）", run: () => setGenOpen(true) },
          { id: "chat", icon: "💬", label: "与这张图对话", needsImage: true, run: () => handleModeChange("chat") },
          { id: "open", icon: "📂", label: "打开图片", run: () => void handleOpen() },
          { id: "folder", icon: "🗂️", label: "打开文件夹", run: () => void handleOpenFolder() },
          { id: "info", icon: "ℹ️", label: "图片信息与 EXIF", hint: "I", needsImage: true, run: () => setInfoOpen((v) => !v) },
          { id: "pure", icon: "🖥️", label: "纯看图模式", hint: "Z", run: () => togglePureView() },
          { id: "theme", icon: "🌗", label: "切换 白天/黑夜 主题", run: () => void handleThemeQuick(darkOn ? "light" : "dark") },
          { id: "settings", icon: "⚙️", label: "设置", run: () => setSettingsOpen(true) },
        ]}
      />

      {genOpen && (
        <GenerateDialog
          open={genOpen}
          onClose={() => setGenOpen(false)}
          settings={settings}
        />
      )}

      {settingsOpen && (
        <SettingsPanel
          initial={settings ?? undefined}
          onClose={() => setSettingsOpen(false)}
          onSave={handleSaveSettings}
        />
      )}
    </div>
  );
}

// 【自动检查更新】启动后 8 秒静默检查一次（可在设置里关闭）；
// 有新版本时广播 pixmate-update 事件，设置面板会显示并引导安装。
if (!BROWSER_MODE) {
  window.addEventListener("DOMContentLoaded", () => {
    setTimeout(async () => {
      try {
        if (localStorage.getItem("pixmate.autoUpdate") === "0") return;
        const { check } = await import("@tauri-apps/plugin-updater");
        const upd = await check();
        if (upd?.available) {
          window.dispatchEvent(new CustomEvent("pixmate-update", { detail: upd.version }));
        }
      } catch {
        /* 静默失败 */
      }
    }, 8000);
  });
}
