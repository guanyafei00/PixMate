/**
 * 本地模型服务（Ollama / LM Studio）的支持代码。
 *
 * 【为什么需要单独一个模块】
 * 原实现有 4 处把「API Key 为空」当成「还没配置」：
 *   · 主进程 callVisionApi / chat：直接抛「请先在设置中填写 API Key」
 *   · 渲染层 runAnalyze：走进「去配置模型」引导，根本不发请求
 *   · testConnection：直接返回「还没填 API Key」
 * 而**本地 Ollama / LM Studio 根本不需要 Key** —— 于是这两家预设虽然列在
 * 选择列表里，实际**根本用不了**（除非用户随便填一个假 Key，还得自己猜到这一层）。
 *
 * 这个模块负责把「本地服务」这件事讲清楚：
 *   ① 什么算本地端点（纯函数，可单测）
 *   ② 本地服务到底在不在跑、上面有哪些模型（探测 + 分类）
 *   ③ 探测结果怎么翻译成人话（纯函数，可单测）
 */

// 只引入类型：api.ts 会动态 import 本模块，用 type-only 避免运行期循环依赖
import { invoke } from "@tauri-apps/api/core";
import type { Settings } from "./api";

/* ------------------------------------------------------------------ */
/* 判定：什么算「本地端点」                                             */
/* ------------------------------------------------------------------ */

/**
 * 是否是回环地址（loopback）。
 *
 * 只认回环，**不认 192.168/10.x 这类局域网地址** ——
 * 因为用户的局域网网关（本项目的 gateway 预设就是 http://127.0.0.1:8000/v1）
 * 是**需要 Key** 的。把局域网一律当成"不需要 Key"会放走真实的鉴权错误。
 * 局域网上的 Ollama 请用设置里的「本地服务」勾选显式声明。
 */
export function isLoopbackUrl(raw: string): boolean {
  if (!raw) return false;
  let host = "";
  try {
    host = new URL(raw.includes("://") ? raw : "http://" + raw).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1" ||
    // 127.0.0.0/8 整段都是回环
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/**
 * 这次请求是否可以不带 API Key。
 * 显式勾选优先（覆盖局域网 Ollama 这类场景），其次看是不是回环地址。
 */
export function keyOptional(s: Pick<Settings, "base_url" | "local_no_key">): boolean {
  if (s.local_no_key) return true;
  return isLoopbackUrl(s.base_url);
}

/** 从 base_url 取出 origin（用于拼 /v1/models）；失败返回 null */
export function originOf(raw: string): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.includes("://") ? raw : "http://" + raw);
    return u.origin;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 探测结果与它的「人话翻译」                                            */
/* ------------------------------------------------------------------ */

/**
 * 探测结果。
 *
 * `url` 是主进程**实际请求**的地址 —— 报错必须用它，不能用渲染层传来的原始
 * base_url 自己拼：原始地址可能带 /v1，拼的时候又加一次，就会显示成
 * `/v1/v1/models`（用户实测就是这样，报错和事实不一致会误导排查）。
 */
export type LocalProbe =
  /** 服务在跑，且能列出模型 */
  | { kind: "ok"; models: string[]; url?: string }
  /** 连不上：端口没人监听 / 网络不通 —— 最常见，通常是服务没启动 */
  | { kind: "unreachable"; detail: string; url?: string }
  /** 地址能连上，但不是 OpenAI 兼容端点（404 等） */
  | { kind: "bad-endpoint"; detail: string; url?: string }
  /** 这个地址要求鉴权 —— 说明它不是"免 Key 的本地服务" */
  | { kind: "unauthorized"; detail: string; url?: string }
  /** 其他错误（超时、返回不是 JSON 等） */
  | { kind: "error"; detail: string; url?: string };

/**
 * 把探测结果翻译成可操作的提示。
 *
 * 关键是**区分"服务没启动"和"模型不存在"** —— 原实现两种情况都只给一句
 * 「请求失败：fetch failed」，用户完全不知道该去开服务还是该去 pull 模型。
 */
/** 局域网地址（非回环的私网 IP）—— 通常是自建网关/中转 */
export function isLanUrl(url?: string): boolean {
  const m = String(url || "").match(/^https?:\/\/([\d.]+)/i);
  if (!m) return false;
  const parts = m[1].split(".").map(Number);
  if (parts.length !== 4) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

/** Key 打码：只露头尾，方便用户核对"用的是不是这个 Key"，又不泄露 */
export function maskKey(key?: string): string {
  const k = (key || "").trim();
  if (!k) return "（空）";
  if (k.length <= 12) return k.slice(0, 2) + "…" + `（共 ${k.length} 位）`;
  return `${k.slice(0, 6)}…${k.slice(-4)}（共 ${k.length} 位）`;
}

export function describeProbe(
  p: LocalProbe,
  model: string,
  opts: { local?: boolean; baseUrl?: string; apiKey?: string } = {}
): { ok: boolean; message: string } {
  const isLocal = opts.local !== false; // 默认按本地处理（原有调用都是本地场景）
  switch (p.kind) {
    case "ok": {
      if (!p.models.length) {
        return { ok: false, message: "服务在跑，但没有任何已加载的模型。先在服务里加载/拉取一个视觉模型。" };
      }
      const has = p.models.includes(model);
      if (model && !has) {
        return {
          ok: false,
          message:
            `服务在跑（找到 ${p.models.length} 个模型），但没有「${model}」。` +
            `可用的有：${p.models.slice(0, 6).join(" / ")}${p.models.length > 6 ? " …" : ""}`,
        };
      }
      return { ok: true, message: `服务正常，模型「${model}」可用（该服务共 ${p.models.length} 个模型）` };
    }
    case "unreachable":
      return {
        ok: false,
        message: isLocal
          ? `连不上这个地址（${p.detail}）。本地服务多半**没在运行** —— 先启动 Ollama / LM Studio 并确认它开了本地服务器。`
          : `连不上 ${p.url || opts.baseUrl || "这个地址"}（${p.detail}）。检查网络、代理，或确认 Base URL 写得对。`,
      };
    case "bad-endpoint":
      return {
        ok: false,
        message: `地址能连上，但不像 OpenAI 兼容端点（${p.detail}）。Base URL 通常要以 /v1 结尾，例如 http://127.0.0.1:11434/v1`,
      };
    case "unauthorized":
      return {
        ok: false,
        message: isLocal
          ? `这个地址要求鉴权（${p.detail}）—— 它不是免 Key 的本地服务，请取消「本地服务」勾选并填写 API Key。`
          : [
              `API Key 被拒绝了（${p.detail}）。`,
              `已请求：${p.url || opts.baseUrl || "?"}`,
              `用的 Key：${maskKey(opts.apiKey)}`,
              ...(isLanUrl(p.url || opts.baseUrl)
                ? [
                    "这是**局域网网关**：",
                    "1. 确认网关是否要求 Key，以及这个 Key 是不是**网关发给你**的"
                      + "（填服务商的 Key 它不认）",
                    "2. 有些网关只放行聊天接口、不放行模型列表 —— 那样拉不到不影响使用，"
                      + "直接在「模型名」里手填即可",
                  ]
                : [
                    "1. Key 前后是否带了空格或换行 —— 重新完整复制一次",
                    "2. 这个 Key 是不是**这家服务商**的（阿里百炼的 Key 填不进 OpenAI 的框）",
                    "3. 有些中转站只放行聊天接口、不放行模型列表 —— 拉不到不影响使用，手填即可",
                  ]),
            ].join("\n"),
      };
    default:
      return { ok: false, message: `探测失败：${p.detail}` };
  }
}

/* ------------------------------------------------------------------ */
/* 探测通道                                                           */
/* ------------------------------------------------------------------ */

/**
 * 各通道共用的解析：OpenAI 的 /v1/models 返回 { data: [{ id }] }
 *
 * 职责边界：本模块只负责「把清单拿回来 + 分类错误」。
 * 「按厂商分组 / 标出可看图」属于展示层，放在 modelCatalog.ts ——
 * 分开之后两边都能单独测。
 */
export function parseModels(json: unknown): string[] {
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map((m) => (m as { id?: unknown })?.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/**
 * 探测本地服务上可用的模型。
 *
 * 走 `GET {origin}/v1/models` —— Ollama 与 LM Studio 都提供这个 OpenAI 兼容接口，
 * 所以一次探测两家通吃，不需要分别适配。
 */
export async function fetchModels(settings: Settings): Promise<LocalProbe> {
  const origin = originOf(settings.base_url);
  if (!origin) return { kind: "error", detail: "Base URL 填得不对，解析不出地址" };

  // Tauri 壳：交给 Rust 主进程（与 Electron 主进程同语义：带可选 Key、5s 超时、
  // 回传实际请求 URL）。【为什么改走壳】此前 Tauri 落到下面的浏览器 fetch ——
  // 依赖网关放行 CORS，还曾漏发 Key 导致永远 401（实测）。现在两端走同一条主进程路径。
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    return await invoke<LocalProbe>("fetch_models", {
      args: JSON.stringify({ baseUrl: origin, apiKey: settings.api_key || "" }),
    });
  }

  // 浏览器预览模式（只读）：直接 fetch。必须带 Key；CORS 由网关放行。
  try {
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), 5000);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (settings.api_key.trim()) {
      headers.Authorization = "Bearer " + settings.api_key.trim();
    }
    const url = `${origin}/v1/models`;
    const res = await fetch(url, { headers, signal: ctrl.signal });
    window.clearTimeout(timer);
    // url 一并带回：报错里显示「实际请求的地址」，别让渲染层自己拼
    if (res.status === 401 || res.status === 403) {
      return { kind: "unauthorized", detail: `HTTP ${res.status}`, url };
    }
    if (!res.ok) return { kind: "bad-endpoint", detail: `HTTP ${res.status}`, url };
    return { kind: "ok", models: parseModels(await res.json()), url };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      kind: "unreachable",
      detail: /abort/i.test(msg) ? "超时" : msg,
      url: `${origin}/v1/models`,
    };
  }
}
