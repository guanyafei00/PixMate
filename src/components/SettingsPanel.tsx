import { useEffect, useRef, useState } from "react";
import {
  Settings,
  getDefaultSettings,
  testConnection,
  getGeneralState,
  setFileAssoc,
  setAutostart,
  requestClearCache,
  iopaintProbe,
  openFolder,
  BROWSER_MODE,
  type GeneralState,
} from "../lib/api";
import { isLoopbackUrl, fetchModels, describeProbe, maskKey } from "../lib/localService";
import { getSettingsPath } from "../lib/api";
import ModelPicker from "./ModelPicker";
import { PROVIDER_PRESETS } from "../lib/providers";
import { EDIT_PROVIDER_PRESETS, getEditProvider } from "../lib/editProviders";

/**
 * 设置面板：模型 + AI 图像编辑。
 *
 * 这里的每一处设计都在解决「新手第一次配置会卡在哪」：
 * - **测试连接**：发一个 1×1 探针图，当场区分「Key 无效 / 地址或模型名写错 / 连不上」。
 *   否则用户要等真正打开图片才发现失败，配置问题和图片问题会混在一起。
 * - **取 Key 的入口**：预设里直接给控制台链接，并标注哪家有免费档。
 * - **保存时自动去空格**：粘贴 Key 前后带空格是最常见的低级故障。
 * - **编辑默认复用同一个百炼 Key**：识别和编辑都在百炼上，用户不用申请第二个 Key。
 * - **明说会上传**：产品定位是本地优先，编辑走云端是一处让步，必须让用户看见。
 */
export default function SettingsPanel({
  initial,
  onClose,
  onSave,
}: {
  initial?: Settings;
  onClose: () => void;
  onSave: (s: Settings) => void;
}) {
  /** 记录 mousedown 是否落在遮罩上（配合遮罩的 onMouseDown，防拖选误关） */
  const maskDown = useRef(false);
  /** 配置文件的实际路径（底部显示）—— "存哪了"应当可见，否则改了没生效没法排查 */
  const [cfgPath, setCfgPath] = useState("");
  useEffect(() => {
    getSettingsPath()
      .then((p) => setCfgPath(p || ""))
      .catch(() => {});
  }, []);
  /** 401 且表单里的 Key 与已保存的不同时置真 —— 显示「用已保存的 Key 重试」 */
  const [keyMismatch, setKeyMismatch] = useState(false);
  // 与默认值合并：老版本存下来的设置里没有编辑相关字段，不合并会出现 undefined 输入框
  const [form, setForm] = useState<Settings>({
    ...getDefaultSettings(),
    ...(initial ?? {}),
  });
  const [saving, setSaving] = useState(false);
  const [presetId, setPresetId] = useState<string>("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(
    null
  );
  /**
   * 拉取到的模型清单（云端 / 本地共用一套）。
   * 非空时展开 ModelPicker —— 按厂商分组、标出可看图的，而不是一长条平铺。
   */
  const [fetched, setFetched] = useState<string[] | null>(null);
  const [fetchNote, setFetchNote] = useState<string>("");
  const [fetching, setFetching] = useState(false);
  const [ipTesting, setIpTesting] = useState(false);
  /** IOPaint 高级设置（地址 / 启动命令）默认折叠 —— 见 JSX 里的说明 */
  const [showIopaintAdvanced, setShowIopaintAdvanced] = useState(false);
  /** 设置分页：model=模型与识别 / edit=AI 图像编辑 / iopaint=本地去水印 / general=通用 */
  const [tab, setTab] = useState<"model" | "edit" | "iopaint" | "general">("model");
  const browserMode = BROWSER_MODE;

  /** IOPaint 只探测不拉起（与「测试连接」同级的无副作用体检） */
  const runIopaintProbe = async () => {
    setIpTesting(true);
    setTestResult(null);
    try {
      const base = (form.iopaint_url || "").trim() || "http://127.0.0.1:8080";
      // 带上启动命令：壳层要靠它诊断「启动程序在不在、端口有没有被占」，
      // 只报「没在运行」用户没法判断该查哪
      const r = await iopaintProbe(base, form.iopaint_cmd || "");
      setTestResult({ ok: Boolean(r.ok), message: r.message || (r.ok ? "IOPaint 在运行" : "IOPaint 服务没有响应") });
    } catch (e) {
      setTestResult({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setIpTesting(false);
    }
  };

  const preset = PROVIDER_PRESETS.find((p) => p.id === presetId);
  const editPreset = getEditProvider(form.edit_provider);

  /**
   * 是否走「本地服务」：显式勾选，或地址是回环（localhost / 127.x）。
   * 回环自动判定是为了"选完 Ollama 预设就能直接用"，不用额外点一下。
   */
  const loopback = isLoopbackUrl(form.base_url);
  const keyNotNeeded = Boolean(form.local_no_key) || loopback;

  const update = (k: keyof Settings, v: string | boolean) => {
    setForm((f) => ({ ...f, [k]: v }));
    setTestResult(null); // 改动后旧结论失效，避免误导
  };

  /**
   * 拉取这个服务上有哪些模型（云端 / 本地同一个入口）。
   *
   * 两件事一起做：
   *   ① 把清单拿回来 → 展开 ModelPicker（按厂商分组、标可看图的）
   *   ② 拿不到时给出**可操作**的原因 —— 靠 describeProbe，与「测试连接」同一套话术，
   *      避免同一个错误在两处说法不同。
   */
  const handleFetch = async () => {
    setFetching(true);
    try {
      const probe = await fetchModels(normalize(form));
      // 把地址与 Key 一起传过去：401 时报错里要能看出"发到了哪、用的哪个 Key"，
      // 否则用户只能对着一句"Key 被拒绝"瞎猜
      const verdict = describeProbe(probe, form.model.trim(), {
        local: keyNotNeeded,
        baseUrl: normalize(form).base_url,
        apiKey: form.api_key,
      });
      if (probe.kind === "ok") {
        setFetched(probe.models);
        // 空清单也算成功拿到响应，但要说清楚"服务在跑、只是没有模型"
        setFetchNote(verdict.ok ? "" : verdict.message);
      } else {
        setFetched(null);
        setFetchNote("");
        setTestResult(verdict);
        // 401 且表单里的 Key 与**已保存**的不同 → 很可能是复制串了
        // （实测案例：保存的 Key 能拉回 121 个模型，表单里却是另一个 Key → 401）
        // 直接给一个「用已保存的 Key 重试」按钮，而不是让用户对着两个打码的 Key 猜
        setKeyMismatch(
          probe.kind === "unauthorized" &&
            Boolean(initial?.api_key) &&
            initial!.api_key.trim() !== form.api_key.trim()
        );
      }
    } catch (e) {
      setFetched(null);
      setTestResult({ ok: false, message: String((e as Error)?.message || e) });
    } finally {
      setFetching(false);
    }
  };

  /**
   * 「用已保存的 Key 重试」。
   * 不走 form state —— setForm 是异步的，紧接着的探测会拿不到新值；
   * 直接用已保存的 Key 构造请求，拉成功后再把它写回表单。
   */
  const handleFetchAfterKeyFix = async () => {
    if (!initial?.api_key) return;
    setFetching(true);
    try {
      const fixed = { ...normalize(form), api_key: initial.api_key };
      const probe = await fetchModels(fixed);
      const verdict = describeProbe(probe, form.model.trim(), {
        local: keyNotNeeded,
        baseUrl: fixed.base_url,
        apiKey: fixed.api_key,
      });
      if (probe.kind === "ok") {
        setFetched(probe.models);
        setFetchNote(verdict.ok ? "" : verdict.message);
        setTestResult({ ok: true, message: "已用保存的 Key 拉到清单" });
        update("api_key", initial.api_key);
      } else {
        setTestResult(verdict);
      }
    } catch (e) {
      setTestResult({ ok: false, message: String((e as Error)?.message || e) });
    } finally {
      setFetching(false);
    }
  };

  /** 选择服务商预设后自动填入端点与模型，降低配置门槛 */
  const applyPreset = (id: string) => {
    const p = PROVIDER_PRESETS.find((x) => x.id === id);
    if (!p) return;
    setPresetId(id);
    // 本地服务不需要 Key：选中预设时顺带把开关打开，避免选完了却用不了
    setForm((f) => ({
      ...f,
      base_url: p.base_url,
      model: p.model,
      local_no_key: p.local ? true : f.local_no_key,
    }));
    setTestResult(null);
  };

  /** 切换编辑服务商：端点与模型跟着换成该家的预设 */
  const applyEditProvider = (id: string) => {
    const p = getEditProvider(id as never);
    setForm((f) => ({
      ...f,
      edit_provider: p.id,
      edit_base_url: p.base_url,
      edit_model: p.model,
    }));
  };

  /** 粘贴 Key 前后带空格是最常见的低级故障，保存前统一去掉 */
  const normalize = (s: Settings): Settings => ({
    ...s,
    api_key: s.api_key.trim(),
    base_url: s.base_url.trim(),
    model: s.model.trim(),
    edit_base_url: (s.edit_base_url ?? "").trim(),
    edit_model: (s.edit_model ?? "").trim(),
    edit_api_key: (s.edit_api_key ?? "").trim(),
    iopaint_url: (s.iopaint_url ?? "").trim(),
    iopaint_cmd: (s.iopaint_cmd ?? "").trim(),
  });

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await testConnection(normalize(form)));
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await onSave(normalize(form));
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
        className="modal-mask"
        onMouseDown={(e) => {
          // 记下"按下"是否落在遮罩上：在输入框里拖动全选时，鼠标**松开**可能落在弹窗外，
          // 那也会触发 click —— 不判断的话设置页会整个消失（用户实测的「闪退」）
          maskDown.current = e.target === e.currentTarget;
        }}
        onClick={(e) => {
          if (maskDown.current && e.target === e.currentTarget) onClose();
        }}
      >
      <div className="modal set-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>设置</span>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        {browserMode && (
          <p className="lt-err">
            当前是浏览器预览模式（只读）：AI 功能与文件操作不可用。请使用桌面版获得完整功能。
          </p>
        )}

        <div className="set-body">
          {/* 左侧固定分页导航：不随右侧内容滚动 */}
          <div className="set-nav">
            <button className={tab === "model" ? "active" : ""} onClick={() => setTab("model")}>模型与识别</button>
            <button className={tab === "edit" ? "active" : ""} onClick={() => setTab("edit")}>AI 图像编辑</button>
            <button className={tab === "iopaint" ? "active" : ""} onClick={() => setTab("iopaint")}>本地去水印</button>
            <button className={tab === "general" ? "active" : ""} onClick={() => setTab("general")}>通用</button>
          </div>

          <div className="set-content">
          {tab === "model" && (
          <>
          {/* ---------------- 识别模型 ---------------- */}
          <div className="modal-section">识别模型（用来读懂图片内容）</div>

        <label className="field">
          <span>服务商预设（选择后自动填入端点与模型）</span>
          <select value={presetId} onChange={(e) => applyPreset(e.target.value)}>
            <option value="" disabled>
              选择服务商…
            </option>
            {PROVIDER_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        {preset && (
          <p className="preset-note">
            💡 {preset.note ?? "已填入该服务商的端点与模型名。"}
            {preset.consoleUrl && (
              <>
                {" "}
                <a
                  className="preset-link"
                  href={preset.consoleUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {preset.free ? "去领取免费的 Key →" : "去申请 API Key →"}
                </a>
              </>
            )}
          </p>
        )}

        {keyMismatch && (
          <div className="key-mismatch">
            <span>
              已保存的 Key（{maskKey(initial?.api_key)}）和现在填的不是同一个 ——
              多半是复制串了。
            </span>
            <button
              className="btn"
              onClick={() => {
                update("api_key", initial!.api_key);
                setKeyMismatch(false);
                // 填回正确的 Key 后直接重拉一次，省得再点一遍
                void handleFetchAfterKeyFix();
              }}
            >
              用已保存的 Key 重试
            </button>
          </div>
        )}

        <label className="field">
          <span>API Key</span>
          <input
            type="password"
            value={form.api_key}
            placeholder={keyNotNeeded ? "本地服务不需要 Key，留空即可" : "sk-..."}
            onChange={(e) => update("api_key", e.target.value)}
          />
        </label>

        {/*
          自动识别开关。
          默认关闭 —— 只切图不调模型；快速浏览几十张时不会悄悄产生费用。
          「打开即自动识别」原本是六份报告的共识 P0，所以**保留为可选项**而不是直接删掉。
        */}
        <label className="field field-check">
          <input
            type="checkbox"
            checked={Boolean(form.auto_analyze)}
            onChange={(e) => update("auto_analyze", e.target.checked)}
          />
          <span>
            打开图片时自动识别
            <em className="field-note">
              默认关闭：只切图、不调用模型。想看识别结果时在右侧点「识别这张图」即可；
              打开这个开关就恢复成「打开即识别」的老行为。
            </em>
          </span>
        </label>

        {/*
          「本地服务」开关。
          本地 Ollama / LM Studio 不需要 API Key —— 没有这个开关的话，
          空 Key 会被当成「还没配置」，这两家预设实际根本用不了
          （用户得自己猜到"随便填个假 Key"这一层）。
          回环地址会自动判定，这个勾选主要给局域网上的本地服务用。
        */}
        <label className="field field-check">
          <input
            type="checkbox"
            checked={keyNotNeeded}
            onChange={(e) => update("local_no_key", e.target.checked)}
          />
          <span>
            本地服务（不需要 API Key）
            <em className="field-note">
              {loopback
                ? "已按 localhost 地址自动启用（Ollama / LM Studio 默认不需要 Key）"
                : "勾上后不填 Key 也能用；仅对你自己搭的、免鉴权的本地服务使用"}
            </em>
          </span>
        </label>

        <label className="field">
          <span>Base URL（兼容 OpenAI 的端点）</span>
          <input
            value={form.base_url}
            placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"
            onChange={(e) => update("base_url", e.target.value)}
          />
        </label>

        <label className="field">
          <span>模型名</span>
          {/* 输入框 + 拉取按钮：模型名（尤其本地的 qwen2.5vl:7b）没人记得住，
              能从服务上直接拉一份就没必要手填 */}
          <div className="field-row">
            <input
              value={form.model}
              placeholder="qwen-vl-plus"
              onChange={(e) => update("model", e.target.value)}
            />
            <button
              className="btn"
              onClick={handleFetch}
              disabled={fetching}
              title="列出这个服务上有哪些模型（按厂商分组，并标出看名字能看图的）"
            >
              {fetching ? "拉取中…" : "拉取模型"}
            </button>
          </div>
        </label>

        {fetched && (
          <ModelPicker
            models={fetched}
            current={form.model.trim()}
            note={fetchNote}
            onPick={(id) => {
              update("model", id);
              setFetched(null); // 选完收起，别挡着下面的字段
            }}
            onClose={() => setFetched(null)}
          />
        )}

        {testResult && (
          <div className={testResult.ok ? "test-result ok" : "test-result bad"}>
            {testResult.ok ? "✅ " : "⚠️ "}
            <span className="test-result-text">{testResult.message}</span>
          </div>
        )}

        <p className="hint">
          默认阿里 Qwen-VL（中文识别强、成本低）。也支持任意 OpenAI
          兼容服务：豆包、智谱、Kimi、OpenAI、本地 Ollama、LM Studio。
          <br />
          想零成本先跑通：选「智谱 GLM-4V Flash（免费档）」。
          <br />
          API Key 只存在本机（Electron 存于应用数据目录，浏览器存 localStorage），
          <strong>不会上传到任何第三方，也不会写进工程文件</strong>。
        </p>

        </>
        )}

        {tab === "edit" && (
        <>
        {/* ---------------- 图像编辑 ---------------- */}
        <div className="modal-section">AI 图像编辑（把图改掉：抹除 / 按描述改 / 变清晰 / 去水印）</div>

        <label className="field">
          <span>编辑服务商</span>
          <select
            value={form.edit_provider ?? "dashscope"}
            onChange={(e) => applyEditProvider(e.target.value as never)}
          >
            {EDIT_PROVIDER_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        <p className="preset-note">
          💡 {editPreset.note}
          {editPreset.consoleUrl && (
            <>
              {" "}
              <a
                className="preset-link"
                href={editPreset.consoleUrl}
                target="_blank"
                rel="noreferrer"
              >
                去控制台 →
              </a>
            </>
          )}
        </p>

        <label className="field">
          <span>编辑模型</span>
          <input
            value={form.edit_model ?? ""}
            placeholder="wanx2.1-imageedit"
            onChange={(e) => update("edit_model", e.target.value)}
          />
        </label>

        <label className="field">
          <span>编辑服务地址（可留空用默认）</span>
          <input
            value={form.edit_base_url ?? ""}
            placeholder="https://dashscope.aliyuncs.com"
            onChange={(e) => update("edit_base_url", e.target.value)}
          />
        </label>

        <label className="field">
          <span>编辑专用 Key（可留空，默认沿用上面的 API Key）</span>
          <input
            type="password"
            value={form.edit_api_key ?? ""}
            placeholder="留空即用上面的 Key"
            onChange={(e) => update("edit_api_key", e.target.value)}
          />
        </label>

        <p className="hint">
          ⚠️ <strong>编辑功能会把图片上传到上面这个服务商</strong>
          （因为要由它生成新图）。识别、看图、翻页都仍然在本地。
          <br />
          不想上传就别用编辑功能 —— 不配这一块，其余功能完全不受影响。
          <br />
          <strong>编辑结果永远不会自动覆盖原图</strong>，必须先「另存为」才落盘。
        </p>
        <p className="hint">
          ℹ️ 局域网网关（gateway）目前<strong>没有可用的图像编辑路由</strong>
          —— 它对外的图像模型都缺授权，所以「AI 改图」只能用百炼或 OpenAI。
          识别（看图）可以正常用网关的免费模型，两者互不影响。
        </p>

        </>
        )}

        {tab === "iopaint" && (
        <>
        {/* ---------------- 本地 AI 去水印（IOPaint） ---------------- */}
        <div className="modal-section">本地 AI 去水印（IOPaint · 免费离线）</div>

        <label className="field-row" style={{ alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={Boolean(form.iopaint_keep_running)}
            onChange={(e) => update("iopaint_keep_running", e.target.checked)}
          />
          <span>IOPaint 常驻 —— 关闭软件后服务继续在后台运行（下次进入去水印秒就绪）</span>
        </label>

        {/*
          【为什么把地址与启动命令收进「高级」】
          实测（2026-10-03）这两个字段**正常情况下根本不需要用户碰**：
          - 地址默认 `http://127.0.0.1:8080`，装在本机就不会变
          - 启动命令有正确的默认值（已含关键的 `--host=127.0.0.1`），
            装好 venv 就该是这个路径
          之前它们一直平铺在页面上，用户看到两个原始输入框，第一反应就是
          「这俩要不要填？填什么？」—— 这正是「不想再打开网页取输入网址」的由来：
          界面把内部细节露出来了，看起来像需要用户配置。
          现在默认折叠，只有真要改（换端口 / 换安装路径）时才展开。
        */}
        <button
          className="btn"
          style={{ margin: "4px 0 8px", alignSelf: "flex-start" }}
          onClick={() => setShowIopaintAdvanced((v) => !v)}
        >
          {showIopaintAdvanced ? "▾ 收起高级设置" : "▸ 高级设置（换端口 / 换安装路径时才用）"}
        </button>

        {showIopaintAdvanced && (
        <>
        <label className="field">
          <span>IOPaint 服务地址</span>
          <input
            value={form.iopaint_url ?? ""}
            placeholder="http://127.0.0.1:8080"
            onChange={(e) => update("iopaint_url", e.target.value)}
          />
        </label>

        <label className="field">
          <span>启动命令（服务没在跑时，应用用它自动拉起）</span>
          <input
            value={form.iopaint_cmd ?? ""}
            placeholder="iopaint.exe start --model=lama --device=cpu --port=8080（示例，填你的 IOPaint 完整路径） --host=127.0.0.1"
            onChange={(e) => update("iopaint_cmd", e.target.value)}
          />
        </label>
        </>
        )}

        <p className="hint">
          ✅ <strong>平时不用管这里</strong> —— 去水印选「IOPaint · 本地 AI」引擎，
          服务没启动时软件会<strong>自动拉起</strong>，图片不出本机、不花钱、不用 Key。
          实测自动拉起约 12 秒，去水印本身约 1~10 秒。
          <br />
          首次使用要下载模型（约 200MB，<strong>只下这一次</strong>）。
          关掉软件时服务会一并关闭（可在上面勾「常驻」让它留在后台）。
        </p>
        </>
        )}

        {tab === "general" && <GeneralSection form={form} update={update} />}

          </div>
        </div>

        <div className="modal-foot set-foot">
          {tab === "model" && (
            <button className="btn" onClick={runTest} disabled={testing}>
              {testing ? "测试中…" : "测试连接"}
            </button>
          )}
          {tab === "iopaint" && (
            <button className="btn" onClick={runIopaintProbe} disabled={ipTesting}>
              {ipTesting ? "检测中…" : "检测 IOPaint 服务"}
            </button>
          )}
          <span className="foot-spacer" />
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={saving} onClick={save}>
            保存
          </button>
        </div>
        {tab === "iopaint" && testResult && (
          <p
            className={testResult.ok ? "lt-note" : "lt-err"}
            /* 诊断结论是多行的（逐条列事实），必须保留换行，否则挤成一坨读不了 */
            style={{ margin: "10px 0 0", whiteSpace: "pre-wrap" }}
          >
            {testResult.message}
          </p>
        )}
        {cfgPath && (
          <p className="lt-note" style={{ margin: "10px 0 0" }}>
            配置文件：{cfgPath}
          </p>
        )}
      </div>
    </div>
  );
}

/* ==================================================================== */
/* 通用设置子面板：文件关联 / 开机自启 / 缓存清理（仅 Tauri 壳可用）       */
/* ==================================================================== */

export function GeneralSection({
  form,
  update,
}: {
  form: Settings;
  update: (k: keyof Settings, v: string | boolean) => void;
}) {
  const [genState, setGenState] = useState<GeneralState | null>(null);
  const [genBusy, setGenBusy] = useState(false);
  const [genMsg, setGenMsg] = useState("");

  useEffect(() => {
    getGeneralState().then(setGenState);
  }, []);

  const act = async (fn: () => Promise<{ ok: boolean; message?: string }>) => {
    setGenBusy(true);
    setGenMsg("");
    try {
      const r = await fn();
      setGenMsg(r.message || (r.ok ? "完成" : "失败"));
      const st = await getGeneralState();
      setGenState(st);
    } catch (e) {
      setGenMsg(String(e).slice(0, 120));
    } finally {
      setGenBusy(false);
    }
  };

  return (
    <>
      {/* ---------------- 通用 ---------------- */}
      <div className="modal-section">通用</div>

      <label className="field">
        <span>外观主题（图片画布无论哪个主题都保持纯黑）</span>
        <select
          value={form.theme ?? "system"}
          onChange={(e) => update("theme", e.target.value)}
        >
          <option value="system">跟随系统</option>
          <option value="dark">黑夜</option>
          <option value="light">白天</option>
        </select>
      </label>

      <label className="field">
        <span>启动时自动打开的文件夹（留空则不自动打开）</span>
        <div className="lt-btns">
          <input
            value={form.startup_dir ?? ""}
            placeholder="例：D:\图库\2026"
            onChange={(e) => update("startup_dir", e.target.value)}
          />
          <button
            className="btn"
            onClick={async () => {
              const f = await openFolder();
              if (f?.dir) update("startup_dir", f.dir);
            }}
          >
            浏览…
          </button>
        </div>
      </label>

      <div className="lt-btns">
        <button
          className="btn"
          disabled={genBusy || !genState}
          onClick={() => act(() => setFileAssoc(!(genState?.assoc ?? false)))}
        >
          {genState?.assoc ? "移除图片「打开方式」关联" : "加入图片「打开方式」列表"}
        </button>
        <button
          className="btn"
          disabled={genBusy || !genState}
          onClick={() => act(() => setAutostart(!(genState?.autostart ?? false)))}
        >
          {genState?.autostart ? "关闭开机自启" : "开启开机自启"}
        </button>
        <button
          className="btn"
          disabled={genBusy || !genState}
          onClick={() => act(() => requestClearCache())}
        >
          清理缓存（下次启动生效）
        </button>
      </div>
      {genMsg && <p className="lt-note">{genMsg}</p>}
      {!genState && (
        <p className="lt-note">
          文件关联 / 开机自启 / 缓存清理目前仅在桌面版（Tauri）提供。
        </p>
      )}
      <p className="hint">
        ℹ️ 文件关联只是把本程序加进右键「打开方式」列表，<strong>不会抢掉默认看图器</strong>
        —— 想设默认：右键图片 → 打开方式 → 选择其他应用 → AI Image Viewer → 勾「始终」。
        <br />
        缩略图由 Windows 自己生成，与关联无关，关联后照常显示。
        <br />
        缓存清理只清 WebView2 本地缓存，<strong>不影响任何设置与识别记录</strong>；
        为避免和运行中的程序抢文件，登记后下次启动时自动执行。
      </p>
    </>
  );
}
