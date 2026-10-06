/**
 * AI 生成配图（文生图 + 图生图）。
 *
 * 【定位】不是编辑已有图，是"从一句话造一张新图"——自媒体场景的封面/配图。
 * 【为什么免费】走用户自己网关的 your-image-model 系列（实测可用），
 *   不经过百炼，不按张计费。
 * 【模型选择】打开对话框时从网关 /v1/models 拉清单，按名字过滤出生图模型
 *   做成下拉；网关不可达或列表里没有想要的，切「手动填写」兜底。
 * 【与编辑的关系】编辑改"已有的图"，这个造"新的图"——是并列能力，不是替代。
 *
 * ── 图生图（本轮新增）──────────────────────────────────────────
 * 上传一张参考图 + 描述 → 生成新图。参考图可选：
 *   不传 = 纯文生图（行为与之前完全一致）
 *   传了 = 图生图，壳层自动改打 /v1/images/edits（multipart）
 *
 * 【为什么不给「用当前选中的图」做按钮】打开这个弹窗时可能一张图都没选
 * （空状态也能点 AI 生成），硬塞一个「用当前图」会经常是灰的。
 * 用户选了「加进现有弹窗」，那就让上传显式、可预判 —— 想用哪张就点哪张。
 *
 * 【实测到的坑，已在壳层处理】用户在用的网关目前所有生图模型都返回
 * 503 auth_not_found（服务端没配鉴权通道）。这不是用户操作问题，
 * 所以壳层把它翻译成人话；这里负责把这段人话**完整显示出来**，
 * 不做二次吞掉 —— 用户需要知道是服务端坏了，才不会反复重试。
 */
import { useEffect, useRef, useState } from "react";
import {
  generateImage,
  saveDataUrlAs,
  saveSettings,
  probeImageModels,
  type Settings,
  type ImageModelProbeResult,
} from "../lib/api";
import { fetchModels, describeProbe } from "../lib/localService";

const SIZES = [
  { v: "512x512", label: "方图 512×512（最快）" },
  { v: "768x768", label: "方图 768×768" },
  { v: "1024x1024", label: "方图 1024×1024" },
  { v: "720x1280", label: "竖图 720×1280（手机壁纸 9:16）" },
  { v: "896x1152", label: "竖图 896×1152" },
  { v: "1024x1536", label: "竖图 1024×1536" },
  { v: "1280x720", label: "横图 1280×720（封面 16:9）" },
  { v: "1152x896", label: "横图 1152×896" },
  { v: "1536x1024", label: "横图 1536×1024" },
];

/** 生图模型的名字判据：网关 121 个模型里实测能对上 6 个（your-image-model / gpt-image / gemini-...-image） */
const IMAGE_MODEL_RE =
  /image|img|flux|dall|cogview|seedream|wanx|sd3|stable|kolors|monet|irag/i;

/** 图生图更挑模型：文生图能用的模型不一定收参考图。
 *
 * 【实测依据】网关对 gemini-3.1-flash-image 回的 400 原文点名了图生图只放行
 *   gpt-image-1.5 / gpt-image-2 / grok-imagine-image(-quality)。
 *   而 your-image-model-2.5-flash 是文生图模型。
 * 分页签后这批模型在图生图页签排前面，文生图页签排后面，各排各的。
 */
const IMG2IMG_PREFERRED_RE = /gpt-image|grok-imagine/i;

const DEFAULT_MODEL = "your-image-model-2.5-flash";
/** 图生图的默认模型。与文生图默认值分开，各记各的（settings.gen_img2img_model）。 */
const DEFAULT_IMG2IMG_MODEL = "gpt-image-2";

/** 参考图体积上限：用户口里最大的图也别把 IPC 撑爆。8MB data URL ≈ 6MB 原图。 */
const MAX_REF_BYTES = 8 * 1024 * 1024;

function ts() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export default function GenerateDialog({
  open,
  onClose,
  settings,
}: {
  open: boolean;
  onClose: () => void;
  settings: Settings | null;
}) {
  /**
   * 【为什么显式分两个页签，而不是靠「有没有传参考图」隐式切换】
   * 之前是：上传了参考图就自动变图生图，没传就文生图。用户明确要求「分开」。
   * 隐式切换有三个实际问题：
   *   1. **两种模式的模型要求不同**（文生图能用的模型未必收参考图），
   *      隐式切换时用户不知道换到了哪个模式，容易用错模型白等十几秒。
   *   2. **状态互相污染** —— 传了参考图再删掉，模型已经切走了、提示词还留着，
   *      用户以为在文生图，其实模型是图生图专用的。
   *   3. **入口名不副实** —— 菜单叫「AI 生成配图（文生图）」，点进去可能变成图生图。
   * 分成页签后：模式明示、模型各记各的、提示词切页签不丢。
   */
  const [tab, setTab] = useState<"t2i" | "i2i">("t2i");
  /** 两个模式各记自己的提示词 —— 切页签不丢内容，这是分开的主要好处 */
  const [promptT2i, setPromptT2i] = useState("");
  const [promptI2i, setPromptI2i] = useState("");
  const [modelT2i, setModelT2i] = useState(settings?.gen_model || DEFAULT_MODEL);
  const [modelI2i, setModelI2i] = useState(
    settings?.gen_img2img_model || DEFAULT_IMG2IMG_MODEL
  );
  const [imgModels, setImgModels] = useState<string[]>([]);
  const [customMode, setCustomMode] = useState(false);
  const [size, setSize] = useState("1024x1024");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // 图生图参考图（data URL）。只在 i2i 页签有意义。
  const [refImage, setRefImage] = useState<string | null>(null);
  const [refName, setRefName] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);
  /** 记录 mousedown 是否落在遮罩上（配合遮罩的 onMouseDown，防拖选误关） */
  const maskDown = useRef(false);

  const isImg2Img = tab === "i2i";
  // 当前生效的提示词 / 模型，随页签切换（两个模式状态完全独立）
  const prompt = isImg2Img ? promptI2i : promptT2i;
  const setPrompt = isImg2Img ? setPromptI2i : setPromptT2i;
  const model = isImg2Img ? modelI2i : modelT2i;
  const setModel = isImg2Img ? setModelI2i : setModelT2i;

  // ── 生图体检（2026-10-03 新增）────────────────────────────────
  // 【为什么要它】实测用户的网关图像模型会在 200/500/503 之间抖：
  //   同一个 your-image-model-2.5-flash 几分钟内 200 → 500 → 503 → 503。
  //   那种情况下「生成」按十次有五次能用，用户根本分不清是
  //   「我哪里配错了」还是「网关在抖」。这里发真实请求拿此刻的实话。
  const [probing, setProbing] = useState(false);
  const [probeResults, setProbeResults] = useState<ImageModelProbeResult[] | null>(null);
  const [probeSummary, setProbeSummary] = useState("");
  // 体检的**目标集合**。默认只测当前选中的那一个（一秒出结论），
  // 用户点「全测一遍」才扩到整个候选清单 —— 每次实测都是一次真实出图请求，
  // 不能一进弹窗就把额度烧光。
  const [probeAll, setProbeAll] = useState(false);

  // 模式/模型/候选清单任一变化 → 旧体检结论立刻作废（它说的是上一组配置的状态）
  useEffect(() => {
    setProbeResults(null);
    setProbeSummary("");
  }, [isImg2Img, model, imgModels.length]);

  // 切页签时清掉结果与错误：结果图属于上一个模式，留着会误导
  //（「我明明切到图生图了，怎么显示的还是刚才那张文生图？」）。
  // 提示词与模型**不清** —— 那是两个模式各自的记忆，切回来还要接着用。
  const switchTab = (next: "t2i" | "i2i") => {
    if (next === tab) return;
    setTab(next);
    setResult(null);
    setErr(null);
    setSaveMsg(null);
  };

  /** 跑生图体检。串行、带间隔由壳层控制，这里只管发哪几个模型。 */
  const runProbe = async (all: boolean) => {
    if (!configured || probing) return;
    setProbing(true);
    setProbeAll(all);
    setErr(null);
    setProbeResults(null);
    setProbeSummary("");
    try {
      const cur = model.trim() || (isImg2Img ? DEFAULT_IMG2IMG_MODEL : DEFAULT_MODEL);
      // 全测时测候选清单（有上限，见 PROBE_ALL_LIMIT）；单测只测当前这个
      const targets = all
        ? Array.from(new Set(probeTargets.length ? probeTargets : [cur]))
        : [cur];
      const rep = await probeImageModels({
        baseUrl: settings?.base_url || "",
        apiKey: settings?.api_key || "",
        models: targets,
        img2img: isImg2Img,
      });
      setProbeResults(rep.results);
      setProbeSummary(rep.summary);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setProbing(false);
    }
  };

  /**
   * 实时从网关拉模型清单。
   *
   * 【为什么要改成「按需拉取 + 可选自动】用户要求「实时拉取，而不是提前拉好的」。
   * 原来的实现是打开弹窗时偷偷拉一次 —— 有三个实际问题：
   *   1. **静默** —— 拉成功拉失败都不出声，用户不知道清单是什么时候的
   *   2. **过期** —— 用户开着弹窗挑活儿，网关那边模型列表变了也看不到
   *   3. **无法重试** —— 网关临时不可达（实测用户的网关会间歇失联）就没有第二次机会
   * 所以改成：打开弹窗时拉一次（快，且大多数情况够用），
   * 再提供显式的「拉取模型」按钮随时刷新，失败会给可行动的提示。
   * 这样既保留了一进弹窗就能选的体验，又给了实时刷新的入口。
   */
  const [fetching, setFetching] = useState(false);
  const [fetchNote, setFetchNote] = useState("");
  /** 清单是什么时候拉的 —— 让用户知道新旧程度 */
  const [fetchedAt, setFetchedAt] = useState<string>("");

  /**
   * 「全测一遍」实际要测的清单。
   *
   * 【为什么要设上限】全测 = 每个模型发一次**真实出图请求**，真花钱。
   * 之前按钮上直接写 `imgModels.length`，看着只是"测 6 个"，
   * 但用户的网关实际有 6 个生图模型，全测就是 6 次真出图。
   * 所以默认只测前几个，把「测哪些」的选择权交回给用户：
   * 想测完整的，可以「手动填写」模型名后单测。
   */
  const PROBE_ALL_LIMIT = 4;
  const probeTargets = imgModels.slice(0, PROBE_ALL_LIMIT);

  /**
   * 拉取模型清单。返回是否成功。
   *
   * 复用设置页那套 `fetchModels` + `describeProbe`（同一个话术来源），
   * 避免同一个错误在设置页和生图弹窗说法不同 —— 实测案例：网关间歇失联时，
   * 两处说法不一致会让用户以为是两个问题。
   */
  const loadModels = async (silent: boolean): Promise<boolean> => {
    if (!settings?.base_url) return false;
    if (!silent) setFetching(true);
    try {
      const probe = await fetchModels({
        base_url: settings?.base_url || "",
        api_key: settings?.api_key || "",
        local_no_key: settings?.local_no_key,
      } as Settings);
      if (probe.kind === "ok") {
        const all = probe.models;
        const list = all.filter((id) => IMAGE_MODEL_RE.test(id));
        // 两个模式的默认模型都要塞进清单，否则下拉里选不到
        setImgModels(
          Array.from(
            new Set([
              settings?.gen_model || DEFAULT_MODEL,
              settings?.gen_img2img_model || DEFAULT_IMG2IMG_MODEL,
              ...list,
            ])
          )
        );
        setCustomMode(false);
        const t = new Date();
        const hh = String(t.getHours()).padStart(2, "0");
        const mm = String(t.getMinutes()).padStart(2, "0");
        const ss = String(t.getSeconds()).padStart(2, "0");
        setFetchedAt(`${hh}:${mm}:${ss}`);
        if (!silent) {
          setFetchNote(
            list.length > 0
              ? `拉到 ${all.length} 个模型，其中 ${list.length} 个生图相关。`
              : `拉到 ${all.length} 个模型，但没有匹配到生图模型（名字里含 image/img/flux 等）。可以点「手动填写」直接填模型名。`
          );
        }
        setErr(null);
        return true;
      }
      // 拉不到时给可行动的提示（与设置页同一套话术）
      if (!silent) {
        const verdict = describeProbe(
          probe,
          "",
          {
            local: false,
            baseUrl: settings?.base_url || "",
            apiKey: settings?.api_key || "",
          }
        );
        setFetchNote("");
        setErr(`拉取模型失败：${verdict.message}`);
      }
      return false;
    } catch (e) {
      if (!silent) {
        setFetchNote("");
        setErr(`拉取模型失败：${e instanceof Error ? e.message : String(e)}`);
      }
      return false;
    } finally {
      if (!silent) setFetching(false);
    }
  };

  // 打开弹窗时拉一次（静默失败不打扰，用户可以手动点按钮重试）
  useEffect(() => {
    if (!open) return;
    let live = true;
    void (async () => {
      await loadModels(true);
      if (!live) return;
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 刻意**不再**有「切模式时自动换模型」的 effect：
  // 两个模式各有自己的模型记忆（modelT2i / modelI2i），用户挑过的不该被覆盖。
  // 之前那个 effect 会在上传参考图时把文生图选好的模型换成图生图专用的，
  // 用户「删掉参考图回到文生图」时模型已经被换走了 —— 正是用户要求分开的原因之一。

  // Esc 关闭弹窗：关闭按钮上写着「关闭 (Esc)」，此前却没有任何监听 —— 按了没反应。
  // 与设置弹窗、命令面板保持一致的键盘关闭行为。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const configured = Boolean(settings?.base_url);

  /** 选参考图：读成 data URL，交给壳层走 multipart */
  const pickRef = async (file: File | undefined | null) => {
    if (!file) return;
    setErr(null);
    if (file.size > MAX_REF_BYTES) {
      setErr(
        `参考图 ${(file.size / 1048576).toFixed(1)}MB 太大（上限 8MB）。先压缩再试。`
      );
      return;
    }
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result || ""));
        fr.onerror = () => reject(new Error("读文件失败"));
        fr.readAsDataURL(file);
      });
      setRefImage(dataUrl);
      setRefName(file.name);
      setResult(null); // 模式变了，旧结果不再对应
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const clearRef = () => {
    setRefImage(null);
    setRefName("");
    if (fileRef.current) fileRef.current.value = "";
  };

  const run = async () => {
    const p = prompt.trim();
    if (!p || busy) return;
    // 图生图必须有参考图，否则退化成文生图却走 edits 端点（网关会报错）
    if (isImg2Img && !refImage) {
      setErr("图生图需要先上传一张参考图。");
      return;
    }
    setErr(null);
    setSaveMsg(null);
    setResult(null);
    setBusy(true);
    try {
      const m = model.trim() || (isImg2Img ? DEFAULT_IMG2IMG_MODEL : DEFAULT_MODEL);
      // 记住这次用的模型（写回设置，下次打开沿用）。
      // 两个模式各写各的字段，互不覆盖。
      if (settings) {
        await saveSettings(
          isImg2Img
            ? { ...settings, gen_img2img_model: m }
            : { ...settings, gen_model: m }
        );
      }
      const r = await generateImage({
        baseUrl: settings?.base_url || "",
        apiKey: settings?.api_key || "",
        model: m,
        prompt: p,
        size,
        // 只在图生图模式传参考图 —— 壳层据此切换端点
        refImage: isImg2Img ? refImage : null,
      });
      if (r.ok && r.dataUrl) setResult(r.dataUrl);
      else setErr(r.message || "生成失败");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!result) return;
    setSaveMsg(null);
    try {
      // 文件名带上模式与时间，省得存一堆分不清的 AI生成-*.png
      const r = await saveDataUrlAs(
        result,
        `AI${isImg2Img ? "图生图" : "生成"}-${ts()}.png`
      );
      if (r.saved) setSaveMsg("已保存");
      else if (r.canceled) setSaveMsg(null);
      else setSaveMsg(r.message || "保存失败");
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div
      className="modal-mask"
      onMouseDown={(e) => {
        // 记下"按下"是否落在遮罩上：在弹窗里拖动选择文本时，鼠标**松开**可能
        // 落在弹窗外，那也会触发 click —— 不判断的话弹窗会整个消失
        //（与 SettingsPanel 的防误关同一套模式）
        maskDown.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (maskDown.current && e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>AI 生成配图</h2>
          <button className="icon-btn" onClick={onClose} title="关闭 (Esc)">
            ✕
          </button>
        </div>

        {!configured && (
          <p className="lt-err">
            还没有配置服务地址 —— 先到「设置」里配好（走你自己的网关就行，不花钱）。
          </p>
        )}

        {/* ── 模式页签：文生图 / 图生图 明确分开 ── */}
        <div className="gen-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={!isImg2Img}
            className={!isImg2Img ? "gen-tab active" : "gen-tab"}
            onClick={() => switchTab("t2i")}
          >
            ✍️ 文生图
            <span className="gen-tab-sub">从一句话造一张新图</span>
          </button>
          <button
            role="tab"
            aria-selected={isImg2Img}
            className={isImg2Img ? "gen-tab active" : "gen-tab"}
            onClick={() => switchTab("i2i")}
          >
            🖼️ 图生图
            <span className="gen-tab-sub">照着参考图改</span>
          </button>
        </div>

        {/* ── 参考图区：只在图生图页签出现（文生图页签压根不显示） ── */}
        {isImg2Img && (
          <div className="field">
            <span>
              参考图
              <span className="gen-hint">（图生图必需。选一张想让模型改的图）</span>
            </span>
            {refImage ? (
              <div className="gen-ref">
                <img src={refImage} alt="参考图" className="gen-ref-thumb" />
                <div className="gen-ref-info">
                  <div className="gen-ref-name" title={refName}>
                    {refName}
                  </div>
                  <div className="lt-btns">
                    <button className="btn" onClick={() => fileRef.current?.click()}>
                      换一张
                    </button>
                    <button className="btn" onClick={clearRef}>
                      移除
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <button
                className="btn"
                onClick={() => fileRef.current?.click()}
                disabled={!configured}
              >
                📁 选择参考图
              </button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={(e) => {
                void pickRef(e.target.files?.[0]);
                e.target.value = ""; // 允许连续选同一张
              }}
            />
          </div>
        )}

        <label className="field">
          <span>
            描述你想要的图
            {isImg2Img && <span className="gen-hint">（说要怎么改，例：换成夜景，去掉路人）</span>}
          </span>
          <textarea
            className="gen-prompt"
            rows={3}
            placeholder={
              isImg2Img
                ? "例：保持构图不变，把白天改成夜晚，加上霓虹灯"
                : "例：简洁商务封面，深蓝背景，中间一台笔记本电脑，顶部留白放标题"
            }
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>

        <label className="field">
          <span>
            模型
            {imgModels.length > 1
              ? `（网关上找到 ${imgModels.length} 个生图模型${fetchedAt ? ` · ${fetchedAt} 拉取` : ""}）`
              : "（还没拉取，或网关列表里没有生图模型）"}
            {isImg2Img && " · 图生图需要支持参考图的模型"}
          </span>
          {/* 拉取按钮：与设置页「模型与识别」里那个同名按钮同一套逻辑与话术。
              用户要「实时拉取」—— 网关那边模型列表会变，弹窗开着时也能刷新。 */}
          <div className="gen-fetch-row">
            <button
              className="btn"
              onClick={() => void loadModels(false)}
              disabled={fetching || !configured}
              title="立刻从网关重新拉一次模型列表（网关那边模型变了随时能刷新）"
            >
              {fetching ? "拉取中…" : "⟳ 拉取模型"}
            </button>
            {imgModels.length > 1 && (
              <button
                className="btn"
                onClick={() => {
                  setCustomMode(true);
                  setFetchNote("");
                }}
                title="网关列表里没有你要的模型？直接手写模型名"
              >
                ✏️ 手动填写
              </button>
            )}
          </div>
          {imgModels.length > 1 && !customMode ? (
            <select
              value={model}
              onChange={(e) => {
                if (e.target.value === "__custom__") {
                  setCustomMode(true);
                } else {
                  setModel(e.target.value);
                }
              }}
            >
              {/* 按当前页签的模型偏好排序：图生图页签把实测支持参考图的排前面；
                  文生图页签反过来（把 gpt-image 系排后面），因为它们是图生图专用。 */}
              {[...imgModels]
                .sort((a, b) => {
                  const pa = IMG2IMG_PREFERRED_RE.test(a) ? 0 : 1;
                  const pb = IMG2IMG_PREFERRED_RE.test(b) ? 0 : 1;
                  return isImg2Img ? pa - pb : pb - pa;
                })
                .map((m) => (
                  <option key={m} value={m}>
                    {m}
                    {m === model ? "（当前）" : ""}
                    {isImg2Img && IMG2IMG_PREFERRED_RE.test(m) ? " · 支持参考图" : ""}
                  </option>
                ))}
              <option value="__custom__">✏️ 手动填写其它模型…</option>
            </select>
          ) : (
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={isImg2Img ? DEFAULT_IMG2IMG_MODEL : DEFAULT_MODEL}
            />
          )}
          {fetchNote && <p className="lt-note">{fetchNote}</p>}
          {/* 生图体检：先测当前模型，便宜且够回答「我现在能不能生成」 */}
          <div className="lt-btns" style={{ marginTop: 6 }}>
            <button
              className="btn"
              onClick={() => runProbe(false)}
              disabled={probing || !configured}
              title={
                isImg2Img
                  ? "用 1×1 探针图打一次图生图端点，看这个模型此刻收不收参考图"
                  : "打一次真实的文生图请求，看这个模型此刻能不能出图（会消耗一次额度）"
              }
            >
              {probing && !probeAll ? "检测中…" : "🔍 检测这个模型"}
            </button>
            {imgModels.length > 1 && (
              <button
                className="btn"
                onClick={() => runProbe(true)}
                disabled={probing || !configured}
                title={
                  probeTargets.length < imgModels.length
                    ? `只实测前 ${probeTargets.length} 个（清单共 ${imgModels.length} 个）——每个都是一次真实出图请求，所以设了上限。手动填写里可以用完整模型名测。`
                    : `依次实测 ${imgModels.length} 个模型（每个都是一次真实出图请求，会消耗额度）`
                }
              >
                {probing && probeAll
                  ? "全测中…（每个约 10 秒）"
                  : `全测一遍（${probeTargets.length} 个）`}
              </button>
            )}
          </div>
        </label>

        {/* 体检结果：逐模型一行，谁的问题说谁的，不吞错误 */}
        {probeResults && (
          <div className={probeResults.some((r) => r.ok) ? "test-result ok" : "test-result bad"}>
            <div className="test-result-text">
              <div style={{ marginBottom: 4 }}>{probeSummary}</div>
              {probeResults.map((r) => (
                <div key={r.model} className="gen-probe-line">
                  {r.ok ? "✅" : "⚠️"} <strong>{r.model}</strong>
                  {" — "}
                  {r.message}
                  {r.ok && r.model !== model.trim() && (
                    <button className="btn gen-probe-pick" onClick={() => setModel(r.model)}>
                      用这个
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <label className="field">
          <span>尺寸</span>
          <select value={size} onChange={(e) => setSize(e.target.value)}>
            {SIZES.map((x) => (
              <option key={x.v} value={x.v}>
                {x.label}
              </option>
            ))}
          </select>
        </label>

        <button
          className="btn primary"
          // 图生图页签还要有参考图才能点 —— 没图就发请求，网关只会回一个
          // 让人一头雾水的错，不如直接在按钮这层拦住并给明确提示
          disabled={
            busy || !prompt.trim() || !configured || (isImg2Img && !refImage)
          }
          onClick={run}
          title={
            isImg2Img && !refImage ? "先选一张参考图" : undefined
          }
        >
          {busy
            ? "生成中…（十几秒）"
            : isImg2Img
              ? "按参考图生成"
              : "文生图生成"}
        </button>

        {err && (
          <p className="lt-err" style={{ whiteSpace: "pre-wrap" }}>
            {err}
          </p>
        )}

        {result && (
          <div className="gen-result">
            <img src={result} alt="生成结果" />
            <div className="lt-btns">
              <button className="btn primary" onClick={save}>
                保存图片
              </button>
              <button className="btn" onClick={onClose}>
                完成
              </button>
            </div>
            {saveMsg && <p className="lt-note">{saveMsg}</p>}
          </div>
        )}

        <p className="lt-note">
          {isImg2Img
            ? "图生图：参考图会上传到你的网关。不同模型收参考图的规矩不同 —— 网关放行的是 gpt-image / grok-imagine 系列，gateway 系列只能文生图。先点「检测这个模型」确认这个模型此刻收不收参考图。"
            : "文生图：默认 your-image-model 系列（实测可用、免费、不出本机网络）。它只能文生图，要改已有图请切到「图生图」页签。"}
          {"生成是「从无到有」，和「AI 编辑」改已有图是两回事。"}
          {"结果不会自动存盘 —— 生成后要点「保存图片」。"}
        </p>
      </div>
    </div>
  );
}
