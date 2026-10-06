#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::cmp::Ordering;
use std::path::Path;
use std::time::Duration;
use tauri::Emitter;
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "settings.json";
const SETTINGS_KEY: &str = "settings";

/// 识别请求超时：视觉模型 + 长文档 OCR 确实慢，给足 90s，但绝不允许无限期挂住。
const REQUEST_TIMEOUT_SECS: u64 = 180;

/// 支持的图片扩展名。
/// 只列 WebView2（Chromium 内核）真能解码的 —— 实测见 `npm run format-probe`：
/// AVIF ✅ / ICO ✅ / SVG ✅；TIFF ❌ / HEIC ❌（内核不带解码器，列了就是死入口）。
const IMG_EXTS: [&str; 10] = [
    "png", "jpg", "jpeg", "jfif", "webp", "bmp", "gif", "avif", "ico", "svg",
];

/// 模型配置（兼容任意 OpenAI 格式端点）
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Settings {
    api_key: String,
    base_url: String,
    model: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            api_key: String::new(),
            // 与前端 lib/api.ts 保持一致：中文 OCR 场景国产模型更强且成本约 1/30
            base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1".to_string(),
            model: "qwen-vl-plus".to_string(),
        }
    }
}

/// 打开图片后回传给前端的载体。
///
/// 注意这里**只有路径，没有 data_url** —— 图片显示走 Tauri 的 asset 协议
/// （前端 `convertFileSrc` → `asset://` 直接读文件），不再把整个文件读成
/// base64 再经 IPC 传递。base64 只在 `analyze_path` 内部的 Rust 侧短暂存在。
/// 这条和 Electron 端 aiiv:// 协议是同一个决定，两端语义保持一致。
#[derive(Debug, Clone, Serialize)]
struct ImagePayload {
    name: String,
    path: String,
}

#[tauri::command]
fn default_settings() -> String {
    serde_json::to_string(&Settings::default()).unwrap()
}

/// 配置文件的实际路径。
/// 【为什么要暴露】双壳的设置存在不同位置（Electron 与 Tauri 各一份）——
/// 排查"改了没生效"时，第一步就是确认这个二进制到底从哪个文件读。
/// 显示在设置页底部，让这个事实对用户可见，而不是只存在于 AI 的记忆里。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenerateArgs {
    base_url: String,
    api_key: String,
    model: String,
    prompt: String,
    size: String,
    /// 图生图的参考图（data URL）。有值 → 走 multipart 的 /v1/images/edits；
    /// 为空 → 走 JSON 的 /v1/images/generations（文生图，原有行为不变）。
    ///
    /// 【为什么参考图只在壳层解 base64】渲染层传过来的 data URL 可能有好几百 KB，
    /// 在 IPC 里再编解码两遍纯属浪费；壳层直接取 payload 段做 multipart 的文件部分。
    #[serde(default)]
    ref_image: Option<String>,
}

/// 把 data URL 解成 (二进制内容, MIME)。
/// `data:image/png;base64,xxxx` → (Vec<u8>, "image/png")。
fn decode_data_url(data_url: &str) -> Result<(Vec<u8>, &'static str), String> {
    let rest = data_url
        .strip_prefix("data:")
        .ok_or_else(|| "参考图格式不对（应以 data:image/...;base64, 开头）".to_string())?;
    let (meta, b64) = rest
        .split_once(',')
        .ok_or_else(|| "参考图缺少 base64 数据段".to_string())?;
    if !meta.contains("base64") {
        return Err("参考图不是 base64 编码的 data URL".into());
    }
    let mime = match meta.split(';').next().unwrap_or("") {
        "image/jpeg" | "image/jpg" => "image/jpeg",
        "image/webp" => "image/webp",
        "image/gif" => "image/gif",
        "image/bmp" => "image/bmp",
        _ => "image/png",
    };
    // 容忍 URL-safe base64 与缺失的填充。
    // ⚠️ 三次尝试都传 `&cleaned`（不能传 `cleaned`：第一 decode 会把它 move 掉，
    //    后面的 or_else 闭包还要借用它 —— 编译器报 E0382 "borrow of moved value"）。
    let cleaned: String = b64.chars().filter(|c| !c.is_whitespace()).collect();
    let bytes = BASE64
        .decode(&cleaned)
        .or_else(|_| {
            let pad = "=".repeat((4 - cleaned.len() % 4) % 4);
            BASE64.decode(format!("{}{}", cleaned, pad))
        })
        .or_else(|_| BASE64.decode(cleaned.replace('-', "+").replace('_', "/")))
        .map_err(|e| format!("参考图 base64 解码失败：{}", e))?;
    if bytes.is_empty() {
        return Err("参考图是空文件".into());
    }
    Ok((bytes, mime))
}

/// 从服务商的错误响应里提炼一句人话。
///
/// 【为什么要专门做】实测用户的网关在生图模型全部失联时，会回
/// `503 {"error":{"message":"auth_unavailable: no auth available (providers=codex, model=gpt-image-2)"}}`。
/// 直接把这段扔给用户毫无意义 —— 这是**服务端没配鉴权通道**，不是用户操作错了。
/// 这里识别几类已知错误并给出可行动的建议。
fn explain_gen_error(status: u16, body: &str) -> String {
    let head: String = body.chars().take(400).collect();
    // 抓出报错里的 provider 名 —— 「哪个 provider 的凭据空了」是用户唯一能采取行动的信息。
    // 实测原文形如：no auth available (providers=codex, model=gpt-image-2)
    let provider = body
        .split("providers=")
        .nth(1)
        .and_then(|s| s.split(&[',', ')'][..]).next())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let provider_hint = match &provider {
        Some(p) => format!("（缺的是网关的 `{}` 这个上游通道）", p),
        None => String::new(),
    };

    if body.contains("auth_not_found") || body.contains("auth_unavailable") {
        return format!(
            "HTTP {}：网关的模型鉴权通道不可用{}。\n\
             这不是你的操作问题 —— 网关服务端当前没有这个生图模型的可用凭据。\n\
             解决：到网关侧补上这个 provider 的凭据，或换一个该网关已放行的生图模型。\n\
             补充：如果是「0 秒就报这个错」，说明请求根本没发出去（凭据池里一个都没有）；\
n\
             如果是「等了几十秒才报」，那是上游服务器忙，等一会儿可能自己恢复。\n\
             原始信息：{}",
            status,
            provider_hint,
            head
        );
    }
    if body.contains("not supported on /v1/images") {
        return format!(
            "HTTP {}：这个模型不支持图生图端点。\n\
             网关提示：图生图只支持它自己放行的模型（如 gpt-image-2 / grok-imagine-image）。\n\
             在「模型」下拉里换一个，或留空走文生图。\n原始信息：{}",
            status, head
        );
    }
    if body.contains("unknown provider") {
        return format!(
            "HTTP {}：网关里没有这个模型对应的上游通道（unknown provider）。\n\
             也就是说它被「声明支持了但没真配」。\n\
             解决：换一个该网关已放行的模型，或让网关管理员把这条通道配上。\n\
             原始信息：{}",
            status, head
        );
    }
    if body.contains("no available server") {
        return format!(
            "HTTP {}：网关到上游模型的通道全忙或全断，稍等再试。\n\
             注意这个错误是「等了几十秒才失败」的（说明凭据是有的，只是打不通），\
n\
             与「0 秒失败」不同 —— 这种通常隔几十秒自己就好。\n\
             原始信息：{}",
            status, head
        );
    }
    if body.contains("could not convert string to float") {
        return format!(
            "HTTP {}：网关的上游服务处理请求时崩了（内部类型转换错误）。\n\
             这说明请求**确实到了上游**，但上游没能处理 —— 通常是某个参数格式它不认。\n\
             试：换尺寸（如 1024x1024）、或换模型。\n\
             原始信息：{}",
            status, head
        );
    }
    if status == 401 || status == 403 {
        return format!("HTTP {}：网关拒绝了这个 Key。检查设置里的 API Key。\n原始信息：{}", status, head);
    }
    if status == 404 {
        return format!(
            "HTTP {}：这个地址没有图生图端点。换个 base_url 试试。\n原始信息：{}",
            status, head
        );
    }
    format!("HTTP {}：{}", status, head)
}

/// 把生成结果（url 或 b64_json）统一下载成 data URL。
async fn materialize_image(client: &reqwest::Client, j: &Value) -> Result<Value, String> {    let item = j.get("data").and_then(|d| d.get(0)).cloned().unwrap_or(Value::Null);
    let url_img = item
        .get("url")
        .and_then(|v| v.as_str())
        .map(|x| x.to_string());
    let b64 = item
        .get("b64_json")
        .and_then(|v| v.as_str())
        .map(|x| x.to_string());
    let bytes: Vec<u8> = if let Some(u) = url_img {
        let r2 = client.get(&u).send().await.map_err(|e| e.to_string())?;
        if !r2.status().is_success() {
            return Err(format!("下载生成结果失败: HTTP {}", r2.status().as_u16()));
        }
        r2.bytes().await.map_err(|e| e.to_string())?.to_vec()
    } else if let Some(b) = b64 {
        BASE64.decode(b).map_err(|e| e.to_string())?
    } else {
        return Err("返回里既没有 url 也没有 b64_json".into());
    };
    let mime = if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        "image/png"
    } else if bytes.starts_with(&[0xFF, 0xD8]) {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF8") {
        "image/gif"
    } else {
        "image/png"
    };
    Ok(json!({
        "ok": true,
        "dataUrl": format!("data:{};base64,{}", mime, BASE64.encode(bytes))
    }))
}

/// 生图体检：逐个模型试跑，报告每个模型**此刻**能不能用。
///
/// 【为什么值得单独做一个命令，而不是让用户去点「生成」试错】
/// 实测用户的网关在 2026-10-03 出现过**间歇性失联**：同一个
/// `your-image-model-2.5-flash` 在几分钟内依次返回 200 → 500 → 503 → 503。
/// 那种情况下「生成」按钮按十次可能有五次能用，用户根本判断不出是
/// 「我哪里配置错了」还是「网关在抖」。
///
/// 这个命令的价值：**一次看清每个模型当下的状态**，并把错误翻译成
/// 「谁的问题」——模型没放行 / 服务端没凭据 / 网络不通，各不相同。
///
/// 【会不会花钱】会，每个模型发一次 512×512 的真实请求（1~2 张图）。
/// 所以**由调用方决定测哪些**（通常只测 settings 里的 gen_model），
/// 并且故意串行、带间隔，避免把网关打爆。
#[tauri::command]
async fn probe_image_models(args: String) -> Result<Value, String> {
    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ProbeArgs {
        base_url: String,
        api_key: String,
        /// 要测的模型清单（调用方从 /models 过滤后给出）
        models: Vec<String>,
        /// 测文生图端点还是图生图端点（后者会多传一张 1x1 探针图）
        #[serde(default)]
        img2img: bool,
    }
    let a: ProbeArgs = serde_json::from_str(&args).map_err(|e| e.to_string())?;
    let origin = a
        .base_url
        .trim()
        .trim_end_matches('/')
        .to_string();
    let origin = match origin.strip_suffix("/v1") {
        Some(s) => s.to_string(),
        None => origin,
    };
    if a.models.is_empty() {
        return Ok(json!({ "ok": false, "message": "没有要测的模型" }));
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let auth = a.api_key.trim().to_string();

    // 1×1 PNG，用作图生图探针的参考图
    const TINY_PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    let (tiny_bytes, _) = decode_data_url(&format!("data:image/png;base64,{}", TINY_PNG))
        .map_err(|e| e.to_string())?;

    let mut results: Vec<Value> = Vec::new();

    for (idx, model) in a.models.iter().enumerate() {
        if idx > 0 {
            tokio::time::sleep(Duration::from_millis(600)).await;
        }
        let endpoint = if a.img2img { "edits" } else { "generations" };
        let started = std::time::Instant::now();

        let resp = if a.img2img {
            let part = reqwest::multipart::Part::bytes(tiny_bytes.clone())
                .file_name("probe.png")
                .mime_str("image/png")
                .map_err(|e| e.to_string())?;
            let form = reqwest::multipart::Form::new()
                .text("model", model.clone())
                .text("prompt", "test")
                .text("n", "1")
                .text("size", "512x512")
                .part("image", part);
            let mut r = client
                .post(format!("{}/v1/images/{}", origin, endpoint))
                .multipart(form);
            if !auth.is_empty() {
                r = r.bearer_auth(auth.clone());
            }
            r.send().await
        } else {
            let mut r = client
                .post(format!("{}/v1/images/{}", origin, endpoint))
                .json(&json!({
                    "model": model, "prompt": "test", "n": 1, "size": "512x512"
                }));
            if !auth.is_empty() {
                r = r.bearer_auth(auth.clone());
            }
            r.send().await
        };

        match resp {
            Ok(r) => {
                let status = r.status().as_u16();
                let text = r.text().await.unwrap_or_default();
                let ms = started.elapsed().as_millis();
                if status == 200 {
                    // 真的能出图才算通过：200 但没有图字段 = 空响应
                    let has_img = serde_json::from_str::<Value>(&text)
                        .ok()
                        .and_then(|j| j.get("data").and_then(|d| d.get(0)).cloned())
                        .map(|it| it.get("url").is_some() || it.get("b64_json").is_some())
                        .unwrap_or(false);
                    results.push(json!({
                        "model": model,
                        "ok": has_img,
                        "ms": ms,
                        "message": if has_img {
                            format!("可用（{} ms）", ms)
                        } else {
                            "返回 200 但没有图片数据".to_string()
                        }
                    }));
                } else {
                    results.push(json!({
                        "model": model,
                        "ok": false,
                        "ms": ms,
                        "message": explain_gen_error(status, &text),
                        "httpStatus": status,
                    }));
                }
            }
            Err(e) => {
                results.push(json!({
                    "model": model,
                    "ok": false,
                    "ms": started.elapsed().as_millis(),
                    "message": format!("连不上：{}", e),
                }));
            }
        }
    }

    let usable: Vec<&Value> = results
        .iter()
        .filter(|r| r["ok"].as_bool() == Some(true))
        .collect();
    Ok(json!({
        "ok": !usable.is_empty(),
        "total": results.len(),
        "usable": usable.len(),
        "results": results,
        "summary": if usable.is_empty() {
            "全部模型都不可用。多半是网关的图像模型凭据没配好（不是你的设置问题）—— 见下面每条的具体报错。".to_string()
        } else {
            format!("{} / {} 个模型当前可用。", usable.len(), results.len())
        }
    }))
}

/// AI 生成配图 / 图生图。
///
/// 【两条端点，别混用】
/// - 无参考图 → `POST {base}/v1/images/generations`（JSON，文生图）
/// - 有参考图 → `POST {base}/v1/images/edits`（multipart，图生图）
///   实测网关的 400 报错原文点名了这条路径：
///   "Model X is not supported on /v1/images/generations or /v1/images/edits"
///   —— 说明 edits 端点确实存在，只是按模型放行。
///
/// 【为什么走壳】返回的是 url（可能跨域），由壳下载后转 base64 给渲染层。
#[tauri::command]
async fn generate_image(args: String) -> Result<Value, String> {
    let a: GenerateArgs = serde_json::from_str(&args).map_err(|e| e.to_string())?;
    let origin = a
        .base_url
        .trim()
        .trim_end_matches('/')
        .to_string();
    let origin = match origin.strip_suffix("/v1") {
        Some(stripped) => stripped.to_string(),
        None => origin,
    };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())?;

    let auth = a.api_key.trim().to_string();
    let ref_image = a.ref_image.as_deref().map(str::trim).filter(|s| !s.is_empty());

    let resp = if let Some(durl) = ref_image {
        // ---------- 图生图：multipart 上传参考图 ----------
        let (bytes, mime) = match decode_data_url(durl) {
            Ok(v) => v,
            Err(e) => return Ok(json!({ "ok": false, "message": e })),
        };
        // 选扩展名：mime → 后缀，部分网关按扩展名判断格式
        let ext = match mime {
            "image/jpeg" => "jpg",
            "image/webp" => "webp",
            "image/gif" => "gif",
            "image/bmp" => "bmp",
            _ => "png",
        };
        let part = reqwest::multipart::Part::bytes(bytes)
            .file_name(format!("reference.{}", ext))
            .mime_str(mime)
            .map_err(|e| e.to_string())?;
        let form = reqwest::multipart::Form::new()
            .text("model", a.model.clone())
            .text("prompt", a.prompt.clone())
            .text("n", "1")
            .text("size", a.size.clone())
            .part("image", part);
        let mut req = client
            .post(format!("{}/v1/images/edits", origin))
            .multipart(form);
        if !auth.is_empty() {
            req = req.bearer_auth(auth);
        }
        req.send().await.map_err(|e| e.to_string())?
    } else {
        // ---------- 文生图：JSON（原有行为，一字未改） ----------
        let url = format!("{}/v1/images/generations", origin);
        let mut req = client.post(&url).json(&json!({
            "model": a.model,
            "prompt": a.prompt,
            "n": 1,
            "size": a.size,
        }));
        if !auth.is_empty() {
            req = req.bearer_auth(auth);
        }
        req.send().await.map_err(|e| e.to_string())?
    };

    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if status != 200 {
        // 交给人话翻译器，别把 auth_not_found 这种扔给用户
        return Ok(json!({
            "ok": false,
            "message": explain_gen_error(status, &text),
            "rawHead": text.chars().take(200).collect::<String>(),
            "httpStatus": status,
        }));
    }
    let j: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    materialize_image(&client, &j).await
}

#[tauri::command]
fn settings_path(app: tauri::AppHandle) -> Result<Value, String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(json!({ "path": dir.join(STORE_FILE).to_string_lossy().to_string() }))
}

#[tauri::command]
fn load_settings(app: tauri::AppHandle) -> Result<String, String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    // 【透传整包，不再裁剪字段】此前这里解析成 3 字段结构体再回传，
    // 把 iopaint_cmd / edit_* / local_no_key 等前端设置全部静默丢弃 ——
    // 直接后果：Tauri 壳里 IOPaint 自动拉起拿到空命令，只能手动启动。
    // 字段校验交给前端（它有完整默认值），壳只负责存取。
    let v = store.get(SETTINGS_KEY).unwrap_or(Value::Null);
    serde_json::to_string(&v).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_settings(app: tauri::AppHandle, settings_json: String) -> Result<(), String> {
    // 只校验是合法 JSON 对象，字段透传存盘（与 load_settings 同一原则）
    let v: Value = serde_json::from_str(&settings_json).map_err(|e| e.to_string())?;
    if !v.is_object() {
        return Err("设置必须是 JSON 对象".into());
    }
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set(SETTINGS_KEY, v);
    store.save().map_err(|e| e.to_string())
}

fn mime_of(path: &str) -> &'static str {
    match Path::new(path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "gif" => "image/gif",
        _ => "application/octet-stream",
    }
}

fn read_as_data_url(path: &str) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("读取图片失败: {}", e))?;
    Ok(format!(
        "data:{};base64,{}",
        mime_of(path),
        BASE64.encode(&bytes)
    ))
}

/// 自然排序：img2 < img10（而不是字典序的 img10 < img2）。
///
/// 前端与 Electron 端都按自然序排列文件，此前只有 Rust 端用 `paths.sort()` 字典序，
/// 导致同一个文件夹在 Tauri 下翻页顺序与 Electron 下不一致 —— 这是个真 bug，已修。
fn natural_cmp(a: &str, b: &str) -> Ordering {
    let mut ai = a.chars().peekable();
    let mut bi = b.chars().peekable();
    loop {
        match (ai.peek().copied(), bi.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(ca), Some(cb)) => {
                if ca.is_ascii_digit() && cb.is_ascii_digit() {
                    let mut na = String::new();
                    while let Some(&c) = ai.peek() {
                        if c.is_ascii_digit() {
                            na.push(c);
                            ai.next();
                        } else {
                            break;
                        }
                    }
                    let mut nb = String::new();
                    while let Some(&c) = bi.peek() {
                        if c.is_ascii_digit() {
                            nb.push(c);
                            bi.next();
                        } else {
                            break;
                        }
                    }
                    let va: u128 = na.parse().unwrap_or(u128::MAX);
                    let vb: u128 = nb.parse().unwrap_or(u128::MAX);
                    if va != vb {
                        return va.cmp(&vb);
                    }
                    // 数值相同则位数少的在前："img2" < "img02"
                    if na.len() != nb.len() {
                        return na.len().cmp(&nb.len());
                    }
                } else {
                    // 大小写不敏感比较（与前端 localeCompare 的行为对齐）
                    let la = ca.to_lowercase().next().unwrap_or(ca);
                    let lb = cb.to_lowercase().next().unwrap_or(cb);
                    if la != lb {
                        return la.cmp(&lb);
                    }
                    ai.next();
                    bi.next();
                }
            }
        }
    }
}

fn list_images_in(dir: &str) -> Result<Vec<String>, String> {
    let mut paths = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|e| format!("读取文件夹失败: {}", e))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let p = entry.path();
        if p.is_file() {
            if let Some(ext) = p.extension().and_then(|s| s.to_str()) {
                if IMG_EXTS.contains(&ext.to_lowercase().as_str()) {
                    paths.push(p.to_string_lossy().to_string());
                }
            }
        }
    }
    // 按「文件名」自然排序，而不是整个绝对路径 —— 同目录下文件名排序即可，
    // 且能避免目录前缀干扰
    paths.sort_by(|a, b| {
        let na = Path::new(a)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let nb = Path::new(b)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        natural_cmp(&na, &nb)
    });
    Ok(paths)
}

#[tauri::command]
async fn open_image(app: tauri::AppHandle) -> Result<ImagePayload, String> {
    use tauri_plugin_dialog::DialogExt;

    // 【为什么用 clone 而不是直接 move】`app` 在后面还要用（grant_root 等），
    // 而 spawn_blocking 的闭包要独占捕获它。AppHandle 是轻量句柄，克隆无副作用。
    let dlg = app.clone();
    // 放进 spawn_blocking：blocking_pick_file 会阻塞当前线程，
    // 而本函数是 async fn 跑在 tokio worker 上 —— 阻塞它等于堵住整个 IPC 队列。
    // 详见 save_image 里的同类说明（那是最容易触发「界面卡死」的一个）。
    let file_path = tauri::async_runtime::spawn_blocking(move || {
        dlg.dialog()
            .file()
            .add_filter("Image", &IMG_EXTS)
            .blocking_pick_file()
    })
    .await
    .map_err(|e| format!("打开对话框异常: {}", e))?;

    let path = match file_path {
        Some(p) => p.into_path().map_err(|e| e.to_string())?,
        None => return Err("cancelled".into()),
    };

    // 对话框选定 = 用户授权：放行该图所在目录（缩略图/翻页/EXIF 都要用）
    if let Some(parent) = path.parent() {
        grant_root(Some(&app), &parent.to_string_lossy());
    }

    Ok(ImagePayload {
        name: path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("image")
            .to_string(),
        path: path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
async fn open_folder(app: tauri::AppHandle) -> Result<Value, String> {
    use tauri_plugin_dialog::DialogExt;
    // 同上：blocking_pick_folder 也要挪出 tokio worker（详见 save_image 的说明）
    let dlg2 = app.clone();
    let dir = tauri::async_runtime::spawn_blocking(move || {
        dlg2.dialog().file().blocking_pick_folder()
    })
    .await
    .map_err(|e| format!("打开对话框异常: {}", e))?;
    let path = match dir {
        Some(p) => p.into_path().map_err(|e| e.to_string())?,
        None => return Err("cancelled".into()),
    };
    let dir_str = path.to_string_lossy().to_string();
    grant_root(Some(&app), &dir_str); // 对话框选定 = 用户授权，命令层放行该目录
    let paths = list_images_in(&dir_str)?;
    Ok(json!({ "dir": dir_str, "paths": paths }))
}

#[tauri::command]
fn list_images(dir: String) -> Result<Vec<String>, String> {
    require_allowed(&dir)?;
    list_images_in(&dir)
}

/// 移入回收站（非永久删除，依赖 trash crate）
#[tauri::command]
fn trash_image(path: String) -> Result<(), String> {
    require_allowed(&path)?;
    trash::delete(&path).map_err(|e| format!("移入回收站失败: {}", e))
}

/// 调用 OpenAI 兼容 Vision 接口。
///
/// `prompt` 由前端传入 —— 提示词唯一真源是 `src/lib/prompts.ts`。
/// 此前 Rust 端自己硬编码了一份 prompt，结果漏了「保留排版」那半句，
/// 而「保留排版」正是调研认定的护城河，正式壳反而没有 —— 两端行为不一致，已修。
async fn call_vision_api(
    data_url: String,
    settings_json: String,
    prompt: String,
    max_tokens: u32,
) -> Result<String, String> {
    let settings: Settings = serde_json::from_str(&settings_json).map_err(|e| e.to_string())?;
    if settings.api_key.trim().is_empty() {
        return Err("请先在「设置」中填写 API Key".into());
    }
    if settings.base_url.trim().is_empty() || settings.model.trim().is_empty() {
        return Err("设置不完整：Base URL 与模型名都不能为空".into());
    }

    let messages = json!([
        {
            "role": "user",
            "content": [
                { "type": "text", "text": prompt },
                { "type": "image_url", "image_url": { "url": data_url } }
            ]
        }
    ]);
    post_chat(&settings, messages, max_tokens).await
}

/**
 * 多轮对话：渲染进程把完整历史（含最新一条用户消息）以 JSON 传进来，
 * Rust 只负责把图片插进**第一条用户消息**并发请求 —— 与 Electron 端同一套语义：
 * 图片不必每轮重复上传，提示词的唯一真源仍是前端。
 */
async fn post_chat(settings: &Settings, messages: Value, max_tokens: u32) -> Result<String, String> {
    let started = std::time::Instant::now();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| e.to_string())?;

    let url = format!("{}/chat/completions", settings.base_url.trim_end_matches('/'));
    let body = json!({
        "model": settings.model,
        "messages": messages,
        "max_tokens": max_tokens
    });

    let resp = client
        .post(&url)
        .bearer_auth(&settings.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                format!(
                    "请求超时（{}s）。可能是网络不通、端点写错，或该模型响应过慢；本地模型请确认服务已启动。",
                    REQUEST_TIMEOUT_SECS
                )
            } else {
                format!("请求失败: {}", e)
            }
        })?;

    let status = resp.status();
    // 慢操作遥测：>10s 的请求落一行到 run.log（目录不存在则静默跳过）
    let elapsed = started.elapsed().as_secs();
    if elapsed >= 10 {
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(std::env::temp_dir().join("aiiv-selftest-run.log").to_string_lossy().to_string())
        {
            use std::io::Write as _;
            let _ = std::io::Write::write_all(
                &mut f,
                format!("[slow] model={} {}s\n", settings.model, elapsed).as_bytes(),
            );
        }
    }
    let resp_json: Value = resp
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {}", e))?;

    if !status.is_success() {
        let msg = resp_json
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .unwrap_or("未知错误");
        return Err(format!("API 错误 ({}): {}", status, msg));
    }

    let choice = resp_json.get("choices").and_then(|c| c.get(0));
    let content = choice
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str());

    // 空内容当成错误抛出，并带上 finish_reason —— 推理型模型 max_tokens 太小时
    // 会返回 length + 空串，界面一片空白且无从排查（实测 your-model-2.x 就是如此）
    let text = match content {
        Some(t) if !t.trim().is_empty() => t.to_string(),
        _ => {
            let fr = choice
                .and_then(|c| c.get("finish_reason"))
                .and_then(|f| f.as_str())
                .unwrap_or("未知");
            if fr == "length" {
                return Err(
                    "模型没有输出内容，原因是 max_tokens 被思考过程耗尽了（finish_reason=length）。\
                     该模型属于推理型：请换用非推理模型，或调大输出预算后重试。"
                        .into(),
                );
            }
            return Err(format!(
                "模型没有返回任何内容（finish_reason={}）。可能是该模型不支持图片输入，或服务商侧异常。",
                fr
            ));
        }
    };
    Ok(text)
}

/// 多轮对话（有磁盘路径时首选）：历史由前端给出，图片插进第一条用户消息。
#[tauri::command]
async fn chat_image_path(
    path: String,
    settings_json: String,
    messages_json: String,
    max_tokens: u32,
) -> Result<String, String> {
    let settings: Settings = serde_json::from_str(&settings_json).map_err(|e| e.to_string())?;
    if settings.api_key.trim().is_empty() {
        return Err("请先在「设置」中填写 API Key".into());
    }
    require_allowed(&path)?;
    let data_url = read_as_data_url(&path)?;
    let history: Value = serde_json::from_str(&messages_json).map_err(|e| e.to_string())?;
    let messages = attach_image_to_first_user(history, &data_url);
    post_chat(&settings, messages, max_tokens).await
}

/// 多轮对话（data URL 兜底，例如拖拽进来的文件）。
#[tauri::command]
async fn chat_image(
    data_url: String,
    settings_json: String,
    messages_json: String,
    max_tokens: u32,
) -> Result<String, String> {
    let settings: Settings = serde_json::from_str(&settings_json).map_err(|e| e.to_string())?;
    if settings.api_key.trim().is_empty() {
        return Err("请先在「设置」中填写 API Key".into());
    }
    let history: Value = serde_json::from_str(&messages_json).map_err(|e| e.to_string())?;
    let messages = attach_image_to_first_user(history, &data_url);
    post_chat(&settings, messages, max_tokens).await
}

/// 把图片挂到历史里第一条用户消息上；若历史里没有用户消息，补一条。
fn attach_image_to_first_user(history: Value, data_url: &str) -> Value {
    let mut list = match history {
        Value::Array(a) => a,
        _ => vec![],
    };
    let mut placed = false;
    for m in list.iter_mut() {
        if !placed && m.get("role").and_then(|r| r.as_str()) == Some("user") {
            let text = m
                .get("content")
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .to_string();
            *m = json!({
                "role": "user",
                "content": [
                    { "type": "text", "text": text },
                    { "type": "image_url", "image_url": { "url": data_url } }
                ]
            });
            placed = true;
        }
    }
    if !placed {
        list.insert(
            0,
            json!({
                "role": "user",
                "content": [
                    { "type": "text", "text": "（用户发起了对话）" },
                    { "type": "image_url", "image_url": { "url": data_url } }
                ]
            }),
        );
    }
    Value::Array(list)
}

/// 按磁盘路径识别（首选通道）：base64 只在 Rust 侧产生并直接发给 API，不跨 IPC。
#[tauri::command]
async fn analyze_path(
    path: String,
    settings_json: String,
    prompt: String,
    max_tokens: u32,
) -> Result<String, String> {
    require_allowed(&path)?;
    let data_url = read_as_data_url(&path)?;
    call_vision_api(data_url, settings_json, prompt, max_tokens).await
}

/// 按 data URL 识别（没有磁盘路径时的兜底，例如拖拽进来的文件）。
#[tauri::command]
async fn analyze_image(
    data_url: String,
    settings_json: String,
    prompt: String,
    max_tokens: u32,
) -> Result<String, String> {
    call_vision_api(data_url, settings_json, prompt, max_tokens).await
}

/* ==================================================================== */
/* AI 图像编辑（P1.5，走云端）                                           */
/*                                                                      */
/* 与 Electron 端保持同一套语义：请求体里的 base64 只在 Rust 侧存在，     */
/* 不跨 IPC；结果下载后转成 data URL 再回前端（服务商的临时链接 24h 过期）。*/
/*                                                                      */
/* ⚠️ 注意：本机没有 Rust 工具链，这段代码**未经编译验证**。             */
/* 首次 `npm run tauri dev` 时请留意编译错误。Electron 端是已验证可用路径。*/
/* ==================================================================== */

/// 万相官方说约 5–15 秒；这里给足排队余量，但不允许无限期挂住
const EDIT_TIMEOUT_SECS: u64 = 180;
const POLL_INTERVAL_MS: u64 = 2000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditRequest {
    provider: String,
    base_url: String,
    model: String,
    api_key: String,
    ds_function: Option<String>,
    prompt: String,
    base_image: String,
    mask_image: Option<String>,
    #[allow(dead_code)]
    width: u32,
    #[allow(dead_code)]
    height: u32,
}

#[derive(Debug, Serialize)]
// 必须 rename_all：前端读的是 dataUrl，不转会变成 data_url 而拿不到值
// （原工程的 read_image_path 就栽在这个坑上：回的是 data_url，前端读 dataUrl，永远是 undefined）
#[serde(rename_all = "camelCase")]
struct EditResult {
    data_url: String,
    request_id: Option<String>,
}

/// 从 data URL 里取出 mime 与字节
fn split_data_url(data_url: &str) -> Result<(String, Vec<u8>), String> {
    let sep = data_url
        .find(";base64,")
        .ok_or_else(|| "图片数据格式异常（不是合法的 data URL）".to_string())?;
    let mime = data_url
        .get(5..sep)
        .unwrap_or("image/png")
        .to_string();
    let bytes = BASE64
        .decode(&data_url[sep + 8..])
        .map_err(|e| format!("解析图片数据失败: {}", e))?;
    Ok((mime, bytes))
}

/// 统一抽取错误信息：百炼原生用顶层 code/message，OpenAI 风格用 error.message，
/// 任务失败又在 output.message —— 三种都要认。
fn dashscope_error(v: &Value, status: u16) -> String {
    let msg = v
        .get("message")
        .and_then(|m| m.as_str())
        .or_else(|| {
            v.get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
        })
        .or_else(|| {
            v.get("output")
                .and_then(|o| o.get("message"))
                .and_then(|m| m.as_str())
        })
        .unwrap_or("未知错误");
    let code = v.get("code").and_then(|c| c.as_str()).unwrap_or("");
    if code.is_empty() {
        format!("API 错误 ({}): {}", status, msg)
    } else {
        format!("API 错误 ({} {}): {}", status, code, msg)
    }
}

/// 「绝不覆盖原文件」的判定：能规范化就比较规范路径，否则退回字符串比较。
fn same_path(a: &str, b: &str) -> bool {
    let na = std::fs::canonicalize(a).unwrap_or_else(|_| std::path::PathBuf::from(a));
    let nb = std::fs::canonicalize(b).unwrap_or_else(|_| std::path::PathBuf::from(b));
    na == nb
}

/// 阿里云百炼「万相-通用图像编辑」：提交任务 → 轮询 → 下载结果。
async fn dashscope_edit(r: &EditRequest) -> Result<EditResult, String> {
    let origin = r.base_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| e.to_string())?;

    let mut input = json!({ "base_image_url": r.base_image });
    if let Some(f) = &r.ds_function {
        if !f.is_empty() {
            input["function"] = json!(f);
        }
    }
    if !r.prompt.trim().is_empty() {
        input["prompt"] = json!(r.prompt.trim());
    }
    if let Some(m) = &r.mask_image {
        if !m.is_empty() {
            input["mask_image_url"] = json!(m);
        }
    }

    let resp = client
        .post(format!(
            "{}/api/v1/services/aigc/image2image/image-synthesis",
            origin
        ))
        // 缺这个头会报「current user api does not support synchronous calls」
        .header("X-DashScope-Async", "enable")
        .bearer_auth(&r.api_key)
        .json(&json!({ "model": r.model, "input": input, "parameters": { "n": 1 } }))
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                format!("提交任务超时（{}s）", REQUEST_TIMEOUT_SECS)
            } else {
                format!("请求失败: {}", e)
            }
        })?;

    let status = resp.status();
    let v: Value = resp.json().await.map_err(|e| format!("解析响应失败: {}", e))?;
    if !status.is_success() {
        return Err(dashscope_error(&v, status.as_u16()));
    }

    let task_id = v
        .get("output")
        .and_then(|o| o.get("task_id"))
        .and_then(|t| t.as_str())
        .ok_or_else(|| "提交任务失败：服务商没有返回 task_id".to_string())?
        .to_string();

    let deadline = std::time::Instant::now() + Duration::from_secs(EDIT_TIMEOUT_SECS);
    while std::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;

        let q = client
            .get(format!("{}/api/v1/tasks/{}", origin, task_id))
            .bearer_auth(&r.api_key)
            .send()
            .await
            .map_err(|e| format!("查询任务失败: {}", e))?;
        let qs = q.status();
        let qv: Value = q
            .json()
            .await
            .map_err(|e| format!("解析任务响应失败: {}", e))?;
        if !qs.is_success() {
            return Err(dashscope_error(&qv, qs.as_u16()));
        }

        let st = qv
            .get("output")
            .and_then(|o| o.get("task_status"))
            .and_then(|s| s.as_str())
            .unwrap_or("");

        if st == "SUCCEEDED" {
            let url = qv
                .get("output")
                .and_then(|o| o.get("results"))
                .and_then(|r| r.get(0))
                .and_then(|x| x.get("url"))
                .and_then(|u| u.as_str())
                .ok_or_else(|| "任务成功但服务商没有返回图片地址".to_string())?;

            let img = client
                .get(url)
                .send()
                .await
                .map_err(|e| format!("下载生成结果失败: {}", e))?;
            if !img.status().is_success() {
                return Err(format!("下载生成结果失败 ({})", img.status()));
            }
            let ct = img
                .headers()
                .get("content-type")
                .and_then(|x| x.to_str().ok())
                .unwrap_or("image/png")
                .split(';')
                .next()
                .unwrap_or("image/png")
                .to_string();
            let bytes = img
                .bytes()
                .await
                .map_err(|e| format!("读取生成结果失败: {}", e))?;
            return Ok(EditResult {
                data_url: format!("data:{};base64,{}", ct, BASE64.encode(&bytes)),
                request_id: Some(task_id),
            });
        }

        if st == "FAILED" {
            let msg = qv
                .get("output")
                .and_then(|o| o.get("message"))
                .and_then(|m| m.as_str())
                .unwrap_or("原因未知");
            return Err(format!("生成任务失败：{}", msg));
        }
        // PENDING / RUNNING → 继续轮询
    }

    Err(format!(
        "生成超时（等待 {} 秒）。任务可能仍在服务商侧排队，稍后可再试。",
        EDIT_TIMEOUT_SECS
    ))
}

/// OpenAI /v1/images/edits（multipart）；大量第三方中转站也照此格式。
/// 语义注意：mask 的透明区域 = 待编辑（与百炼的黑白语义相反，前端已分流）。
async fn openai_edit(r: &EditRequest) -> Result<EditResult, String> {
    let origin = r.base_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(EDIT_TIMEOUT_SECS))
        .build()
        .map_err(|e| e.to_string())?;

    let (base_mime, base_bytes) = split_data_url(&r.base_image)?;
    let ext = if base_mime.contains("jpeg") { "jpg" } else { "png" };

    let mut form = reqwest::multipart::Form::new()
        .part(
            "image",
            reqwest::multipart::Part::bytes(base_bytes)
                .file_name(format!("image.{}", ext))
                .mime_str(&base_mime)
                .map_err(|e| e.to_string())?,
        )
        .text("model", r.model.clone())
        .text(
            "prompt",
            if r.prompt.trim().is_empty() {
                "edit the image".to_string()
            } else {
                r.prompt.trim().to_string()
            },
        )
        .text("n", "1");
    if let Some(m) = &r.mask_image {
        if !m.is_empty() {
            let (_, mask_bytes) = split_data_url(m)?;
            form = form.part(
                "mask",
                reqwest::multipart::Part::bytes(mask_bytes)
                    .file_name("mask.png")
                    .mime_str("image/png")
                    .map_err(|e| e.to_string())?,
            );
        }
    }

    let resp = client
        .post(format!("{}/images/edits", origin))
        .bearer_auth(&r.api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                format!("提交超时（{}s）", EDIT_TIMEOUT_SECS)
            } else {
                format!("请求失败: {}", e)
            }
        })?;

    let status = resp.status();
    let v: Value = resp.json().await.map_err(|e| format!("解析响应失败: {}", e))?;
    if !status.is_success() {
        return Err(dashscope_error(&v, status.as_u16()));
    }

    let item = v
        .get("data")
        .and_then(|d| d.get(0))
        .cloned()
        .ok_or_else(|| "服务商没有返回图片".to_string())?;
    if let Some(b64) = item.get("b64_json").and_then(|x| x.as_str()) {
        return Ok(EditResult {
            data_url: format!("data:image/png;base64,{}", b64),
            request_id: None,
        });
    }
    if let Some(url) = item.get("url").and_then(|x| x.as_str()) {
        let img = client
            .get(url)
            .send()
            .await
            .map_err(|e| format!("下载生成结果失败: {}", e))?;
        if !img.status().is_success() {
            return Err(format!("下载生成结果失败 ({})", img.status()));
        }
        let bytes = img
            .bytes()
            .await
            .map_err(|e| format!("读取生成结果失败: {}", e))?;
        return Ok(EditResult {
            data_url: format!("data:image/png;base64,{}", BASE64.encode(&bytes)),
            request_id: None,
        });
    }
    Err("返回格式异常：既没有 b64_json 也没有 url".into())
}

#[tauri::command]
async fn edit_image(req: String) -> Result<EditResult, String> {
    let r: EditRequest = serde_json::from_str(&req).map_err(|e| e.to_string())?;
    if r.api_key.trim().is_empty() {
        return Err("还没填 API Key。AI 编辑需要密钥，请到「设置 → 图像编辑」里配置。".into());
    }
    if !r.base_image.is_empty() {
        // 提前校验一次，避免把一个坏 data URL 发出去才报错
        split_data_url(&r.base_image)?;
    } else {
        return Err("没有可用的图片数据".into());
    }

    match r.provider.as_str() {
        "dashscope" => dashscope_edit(&r).await,
        "openai" => openai_edit(&r).await,
        other => Err(format!(
            "未知编辑服务商「{}」。支持：dashscope（百炼）、openai（含兼容中转站）。",
            other
        )),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveArgs {
    source_path: String,
    data_url: String,
    default_name: String,
}

/// 另存为。**红线：绝不自动覆盖原文件。**
#[tauri::command]
async fn save_image(app: tauri::AppHandle, args: String) -> Result<Value, String> {
    use tauri_plugin_dialog::DialogExt;
    let a: SaveArgs = serde_json::from_str(&args).map_err(|e| e.to_string())?;
    let (mime, bytes) = split_data_url(&a.data_url)?;

    // 结果图的真实格式由服务商决定，后缀要跟着实际 MIME 走
    let ext = if mime.contains("jpeg") {
        "jpg"
    } else if mime.contains("webp") {
        "webp"
    } else {
        "png"
    };
    let stem = match a.default_name.rsplit_once('.') {
        Some((s, _)) => s.to_string(),
        None => a.default_name.clone(),
    };

    // 【为什么必须放进 spawn_blocking —— 这是一个会锁死整个 IPC 的坑】
    // `blocking_save_file()` 会**阻塞当前线程**直到用户在系统对话框里点确定。
    // 本函数是 `async fn`，跑在 tokio 工作线程上；Tauri 的 IPC 又是**串行队列**。
    // 于是一个模态对话框就能把一个 worker 线程占住，而系统模态框又会挡住主窗口 ——
    // 表现就是：**「另存为」点了没反应，其它工具也一起卡住**。
    // （用户 2026-10-03 实测报的就是这个症状。）
    //
    // 放进 spawn_blocking 后，对话框在**独立线程**上阻塞，
    // tokio worker 立刻释放，IPC 队列继续跑其它命令。
    let dlg3 = app.clone();
    let chosen = tauri::async_runtime::spawn_blocking(move || {
        dlg3.dialog()
            .file()
            .set_file_name(format!("{}.{}", stem, ext))
            .blocking_save_file()
    })
    .await
    .map_err(|e| format!("另存为对话框异常: {}", e))?;

    let path = match chosen {
        Some(p) => p.into_path().map_err(|e| e.to_string())?,
        None => return Ok(json!({ "saved": false, "message": "已取消保存" })),
    };
    let path_str = path.to_string_lossy().to_string();

    if !a.source_path.is_empty() && same_path(&path_str, &a.source_path) {
        return Ok(json!({
            "saved": false,
            "message": "为避免覆盖原图，请换一个文件名或目录（AI 编辑结果不会写回原文件）。"
        }));
    }

    std::fs::write(&path, &bytes).map_err(|e| format!("保存失败: {}", e))?;
    Ok(json!({ "saved": true, "path": path_str }))
}

/// 批量产物的落盘目标目录名。
/// 安全护栏的锚点：**只允许写进这个目录**，渲染层再被攻破也写不到别处。
const BATCH_DIR_NAME: &str = "aiiv-processed";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteProcessedArgs {
    path: String,
    data_url: String,
}

/// 批量产物的落盘。
///
/// 与 save_image 的区别：**不弹对话框**（批量几十张，每张弹一次没法用），
/// 但代价是渲染层直接指定路径 —— 所以必须加护栏：
/// 只允许写进「…/aiiv-processed/」目录，其余一律拒绝。
#[tauri::command]
async fn write_processed(args: String) -> Result<Value, String> {
    let a: WriteProcessedArgs = serde_json::from_str(&args).map_err(|e| e.to_string())?;
    Ok(write_processed_impl(&a))
}

fn write_processed_impl(a: &WriteProcessedArgs) -> Value {
    let (mime, bytes) = match split_data_url(&a.data_url) {
        Ok(v) => v,
        Err(e) => return json!({ "saved": false, "message": e }),
    };
    let _ = mime; // 批量文件名由前端给好（保持原名），这里不按 MIME 改后缀

    let p = std::path::Path::new(&a.path);
    let parent = p
        .parent()
        .and_then(|x| x.file_name())
        .and_then(|x| x.to_str())
        .unwrap_or("");
    if parent != BATCH_DIR_NAME {
        return json!({
            "saved": false,
            "message": "出于安全考虑，批量产物只允许写入 aiiv-processed 目录"
        });
    }
    if let Some(dir) = p.parent() {
        if let Err(e) = std::fs::create_dir_all(dir) {
            return json!({ "saved": false, "message": format!("写入失败: {}", e) });
        }
    }
    // 红线：绝不覆盖非批量目录里的同名文件（护栏已保证目录，这里再防重名冲突）
    if p.exists() {
        return json!({ "saved": false, "message": "同名文件已存在，已跳过" });
    }
    if let Err(e) = std::fs::write(p, &bytes) {
        return json!({ "saved": false, "message": format!("写入失败: {}", e) });
    }
    json!({ "saved": true, "path": a.path })
}

/* ==================================================================== */
/* 本地 IOPaint（LaMa 去水印引擎）                                        */
/*                                                                      */
/* 与 Electron 端 iopaint-inpaint / iopaint-ensure-server 同规格：        */
/* 服务探活 → 没有就用设置里的启动命令拉起进程 → JSON 上传 image+mask     */
/* 【协议】/api/v1/inpaint 收 JSON {image, mask}（dataUrl 原样可传，      */
/*   IOPaint 的 decode_base64_to_image 自带 data URL 前缀解析），         */
/*   响应是裸图片字节。                                                   */
/* 【为什么走壳】本地服务通常不带 CORS 头，渲染层直连会被 WebView 拦截。   */
/* ==================================================================== */

/// 被拉起的 IOPaint 进程（退出时一并关闭，见 main() 的 on_window_event）
///
/// 【为什么要存 pid 而不是只存 Child】实测发现 `iopaint.exe` 是 pip 装的
/// console-script 启动器：它自己会再拉起真正的 Python 服务进程，然后**壳就退出**。
/// 于是 `Child::kill()` 杀的是那个已经退出的壳 —— **真正的服务会残留**，
/// 用户会看到「软件关了但 8080 还占着」。
/// 所以额外存 pid，退出时用 `taskkill /T /F` 连**进程树**一起杀。
static IOPAINT_CHILD: std::sync::Mutex<Option<std::process::Child>> =
    std::sync::Mutex::new(None);

/// 自动拉起时的 launcher pid，供退出时按进程树清理（见 kill_iopaint_tree）
static IOPAINT_PID: std::sync::Mutex<Option<u32>> = std::sync::Mutex::new(None);

/// 「已有人在拉起 IOPaint 并等就绪」的标志。
///
/// 【为什么需要它 —— 这是一个实测踩出来的真缺陷】
/// 2026-10-03：前端在页签间来回切时会并发调 `iopaint_ensure_server`。
/// 每次调用都要跑完 60 轮 × 2 秒的轮询（最长 120 秒），
/// 而 Tauri 的 IPC 是**串行队列** —— 后来的调用排在前面那个之后，
/// 整个命令通道被堵死。用户实测症状：**界面卡死、所有工具无反应、
/// 「另存为」也没反应**。
///
/// 用它做并发守卫：已有拉起在进行时，后来的调用只做一次短探活就返回，
/// 绝不做长时间轮询。这样并发调用再多也拖不垮 IPC。
static IOPAINT_STARTING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// 连同子孙进程一起终止 IOPaint。
///
/// 【为什么不能只用 Child::kill()】`Child::kill()` 在 Windows 上只终止
/// 目标进程本身。实测 `iopaint.exe` 会拉起真正的 Python 服务再自己退出，
/// 单纯 kill 壳杀不到服务。
/// `taskkill /T /F /PID` 的 `/T` 会连子进程一起终止 —— 这才是「退出即关干净」。
/// `/F` 是强制的：IOPaint 会忽略普通的关闭请求。
fn kill_iopaint_tree() {
    let pid = IOPAINT_PID.lock().ok().and_then(|g| *g);
    #[cfg(target_os = "windows")]
    if let Some(pid) = pid {
        use std::os::windows::process::CommandExt; // creation_flags 需要它
        // 失败也没关系：可能进程早就自己退了
        let _ = std::process::Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW：别弹黑框
            .output();
    }
    #[cfg(not(target_os = "windows"))]
    let _ = pid;

    // 无论如何都清掉 Child 句柄与记录
    if let Ok(mut guard) = IOPAINT_CHILD.lock() {
        if let Some(child) = guard.as_mut() {
            let _ = child.kill(); // 壳可能还在，顺手补一刀
        }
        *guard = None;
    }
    if let Ok(mut guard) = IOPAINT_PID.lock() {
        *guard = None;
    }
}

/* ==================================================================== */
/* 命令层 ACL（安全评审的 P0 首位）                                    */
/*                                                                      */
/* 威胁模型：WebView 渲染层一旦被注入，不应能凭空指定任意路径让壳读写/删除 */
/* （trash_image 收任意路径 = 一次调用任意文件可删）。                    */
/* 规则：只有「用户真实操作授过权的目录」内的路径才允许命令层触碰 ——       */
/*   ① 系统对话框选定（open_image / open_folder，选完即授权）             */
/*   ② 用户配置的启动目录 / 拖入的文件（前端显式调 grant_dir）            */
/*   ③ write_processed 另有自己的 aiiv-processed 白名单（不受此处影响）   */
/* ==================================================================== */

static GRANTED_ROOTS: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

fn grant_root(app: Option<&tauri::AppHandle>, raw: &str) {
    let p = std::fs::canonicalize(raw).unwrap_or_else(|_| std::path::PathBuf::from(raw));
    let s = p.to_string_lossy().to_string();
    // asset 协议作用域同步扩展：否则缩窄 conf scope 后图片显示会被拦
    // （无头自检时没有 app，跳过 —— 自检不走 asset 协议）
    if let Some(app) = app {
        use tauri::Manager;
        let scope = app.asset_protocol_scope();
        let _ = scope.allow_directory(&p, true);
    }
    let mut g = GRANTED_ROOTS.lock().unwrap_or_else(|e| e.into_inner());
    if !g.iter().any(|x| x.eq_ignore_ascii_case(&s)) {
        g.push(s);
    }
}

fn path_allowed(raw: &str) -> bool {
    let cand = std::fs::canonicalize(raw).unwrap_or_else(|_| std::path::PathBuf::from(raw));
    let cs = cand.to_string_lossy().to_lowercase();
    let g = GRANTED_ROOTS.lock().unwrap_or_else(|e| e.into_inner());
    g.iter().any(|root| {
        let r = root.to_lowercase();
        cs == r || cs.starts_with(&format!("{}\\", r)) || cs.starts_with(&format!("{}/", r))
    })
}

fn require_allowed(raw: &str) -> Result<(), String> {
    if path_allowed(raw) {
        Ok(())
    } else {
        Err(format!(
            "目录未授权：{}（请先通过「打开文件夹/打开图片」进入该目录）",
            raw
        ))
    }
}

/// 前端显式授权：用户拖入文件 / 启动目录（均属用户真实操作），授权其所在目录
#[tauri::command]
fn grant_dir(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err("路径不存在".into());
    }
    let dir = if p.is_dir() {
        p.to_path_buf()
    } else {
        p.parent().map(|x| x.to_path_buf()).unwrap_or(p.to_path_buf())
    };
    grant_root(Some(&app), &dir.to_string_lossy());
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IopaintArgs {
    base_url: String,
    image_data_url: String,
    mask_data_url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IopaintEnsureArgs {
    base_url: String,
    cmd: String,
}

/// 探测本地 IOPaint 服务；就绪时返回 (模型名, None)。
/// 【实测】这个版本的探活端点是 GET /api/v1/model → ModelInfo{name,...}，
/// 没有 server-info（当时照记忆写错路径，404 了 —— 探活失败会误判成"服务没起"）。
async fn probe_iopaint(base_url: &str, timeout_secs: u64) -> Option<(Option<String>, Option<String>)> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .ok()?;
    let url = format!("{}/api/v1/model", base_url.trim().trim_end_matches('/'));
    let resp = client.get(&url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let j: Value = resp.json().await.ok()?;
    let name = j
        .get("name")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    Some((name, None))
}

#[tauri::command]
async fn iopaint_ensure_server(args: String) -> Result<Value, String> {
    let a: IopaintEnsureArgs = serde_json::from_str(&args).map_err(|e| e.to_string())?;
    let base = if a.base_url.trim().is_empty() {
        "http://127.0.0.1:8080".to_string()
    } else {
        a.base_url.trim().to_string()
    };

    // ① 已在运行 → 直接用
    if let Some((model, device)) = probe_iopaint(&base, 3).await {
        return Ok(json!({
            "ok": true, "started": false, "model": model, "device": device,
            "message": "服务已在运行"
        }));
    }

    // ② 没在运行 → 用设置里的命令拉起（首 token 是 exe，其余是参数）
    let mut parts = a.cmd.split_whitespace();
    let exe = match parts.next() {
        Some(e) => e.to_string(),
        None => {
            return Ok(json!({
                "ok": false, "started": false,
                "message": "本地 IOPaint 没有在运行，设置里也没有可用的启动命令。"
            }))
        }
    };
    let rest: Vec<String> = parts.map(|s| s.to_string()).collect();
    {
        let mut guard = IOPAINT_CHILD.lock().map_err(|e| e.to_string())?;
        if guard.is_none() {
            let mut cmd = std::process::Command::new(&exe);
            cmd.args(&rest);
            // 模型缓存目录可经环境变量 IOPAINT_CACHE_HOME 指定（避免本机路径入库）；
            // 不设则 IOPaint 用默认位置（可能重复下载模型）。
            if let Ok(cache) = std::env::var("IOPAINT_CACHE_HOME") {
                if !cache.trim().is_empty() {
                    cmd.env("XDG_CACHE_HOME", cache);
                }
            }
            // 模型下载走 hf-mirror 国内镜像（HuggingFace 官方源国内基本不可达）
            cmd.env("HF_ENDPOINT", "https://hf-mirror.com");
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW：别在用户面前弹黑框
            }
            match cmd.spawn() {
                Ok(child) => {
                    // 记 pid：退出时要用 taskkill /T 连进程树一起杀，
                    // 单靠 child.kill() 杀不到 iopaint.exe 拉起的真服务
                    if let Ok(mut g) = IOPAINT_PID.lock() {
                        *g = Some(child.id());
                    }
                    *guard = Some(child);
                }
                Err(e) => {
                    return Ok(json!({
                        "ok": false, "started": false,
                        "message": format!("自动启动 IOPaint 失败: {}", e)
                    }))
                }
            }
        }
    }

    // ③ 轮询等就绪（模型加载约 10~30s；首次启动要先下载约 200MB 模型）
    //
    // 【⚠️ 这里的并发守卫是必需的，别删】
    // 2026-10-03 实测：前端在页签间来回切时会并发调本命令多次。
    // 每次调用都要跑完下面这个 60 轮 × 2 秒的轮询（最长 120 秒），
    // 而 Tauri 的 IPC 是**串行队列**——后来的调用排在前面这个后面，
    // 整个命令通道被堵住 → 界面卡死、其它工具与「另存为」全部无反应
    // （用户当天实测报的就是这个症状）。
    //
    // 所以用 ATOMIC 记住「已有一次拉起在进行中」：
    // 并发调用直接跳过长时间轮询，只做一次探活就返回，绝不拖垮 IPC。
    let already_waiting = IOPAINT_STARTING.swap(true, std::sync::atomic::Ordering::SeqCst);
    if already_waiting {
        // 已经有别人在等了，这里只快速探一次，给个瞬时结论就走
        for _ in 0..3 {
            tokio::time::sleep(Duration::from_millis(500)).await;
            if let Some((model, device)) = probe_iopaint(&base, 2).await {
                return Ok(json!({
                    "ok": true, "started": true, "model": model, "device": device,
                    "message": "已自动启动本地 IOPaint"
                }));
            }
        }
        return Ok(json!({
            "ok": false, "started": true,
            "message": "本地 IOPaint 正在启动中（另一次操作已触发拉起），请稍候再试。"
        }));
    }

    let result = 'wait: {
        for _ in 0..60 {
            tokio::time::sleep(Duration::from_secs(2)).await;
            if let Some((model, device)) = probe_iopaint(&base, 2).await {
                break 'wait json!({
                    "ok": true, "started": true, "model": model, "device": device,
                    "message": "已自动启动本地 IOPaint"
                });
            }
        }
        // 走到这里：命令拉起了，但服务一直没就绪。
        // 【为什么文案要分类】实测这台机器上 `iopaint start` 是**前台常驻**的
        // （跑 90 秒不退出），所以「没就绪」不等于「没下载模型」。
        // 一律归因到下载会让人往错的方向查。
        json!({
            "ok": false, "started": true,
            "message": "已拉起 IOPaint，但 120 秒内服务没有就绪。\n\
                 可能原因（按常见度）：\n\
                 1) 首次使用还没下完模型（约 200MB）—— 双击项目里的「启动IOPaint.cmd」\n\
                    能在控制台看到下载进度，下完再试\n\
                 2) 8080 端口被别的程序占了\n\
                 3) IOPaint 依赖有问题（venv 没装全）\n\
                 控制台里那条命令跑完不退出是正常的（它是常驻服务），\n\
                 所以要看报错得双击那个 .cmd。"
        })
    };
    // 无论成功失败都要把「正在启动」的标记还回去，否则后面再也拉不起了
    IOPAINT_STARTING.store(false, std::sync::atomic::Ordering::SeqCst);
    Ok(result)
}

#[tauri::command]
async fn iopaint_inpaint(args: String) -> Result<Value, String> {
    let a: IopaintArgs = serde_json::from_str(&args).map_err(|e| e.to_string())?;
    let base = a.base_url.trim().trim_end_matches('/').to_string();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;
    // IOPaint 的 decode_base64_to_image 原生接受 data URL 前缀 —— 原样传即可
    let url = format!("{}/api/v1/inpaint", base);
    let resp = client
        .post(&url)
        .json(&json!({
            "image": a.image_data_url,
            "mask": a.mask_data_url,
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    if status != 200 {
        let text = resp.text().await.unwrap_or_default();
        return Ok(json!({
            "ok": false,
            "message": format!("HTTP {}: {}", status, text.chars().take(200).collect::<String>())
        }));
    }
    let ct = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?.to_vec();
    let mime = if ct.starts_with("image/") {
        ct
    } else if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        "image/png".to_string()
    } else if bytes.starts_with(&[0xFF, 0xD8]) {
        "image/jpeg".to_string()
    } else {
        "image/png".to_string()
    };
    Ok(json!({
        "ok": true,
        "dataUrl": format!("data:{};base64,{}", mime, BASE64.encode(bytes))
    }))
}

/* ==================================================================== */
/* 模型拉取（fetch_models）                                              */
/*                                                                      */
/* 与 Electron 端 fetch-models 同规格：主进程 GET {origin}/v1/models。    */
/* 【为什么必须走壳】此前 Tauri 壳的模型拉取走渲染层浏览器 fetch（依赖    */
/* 网关放行 CORS，还曾漏发 Key 导致永远 401）—— 现在两端终于走同一条路。 */
/* 返回结构与前端 LocalProbe 完全一致（kind/models/url/detail）。         */
/* ==================================================================== */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FetchModelsArgs {
    base_url: String,
    api_key: String,
}

/// 从 base_url 取出 origin（scheme://host:port）。没有协议头时按 http 补，
/// 与前端 localService.originOf 同一规则（origin 解析失败返回 None）。
fn service_origin(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let candidate = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("http://{}", raw)
    };
    let u = reqwest::Url::parse(&candidate).ok()?;
    let host = u.host_str()?.to_string();
    Some(match u.port() {
        Some(p) => format!("{}://{}:{}", u.scheme(), host, p),
        None => format!("{}://{}", u.scheme(), host),
    })
}

#[tauri::command]
async fn fetch_models(args: String) -> Result<Value, String> {
    let a: FetchModelsArgs = serde_json::from_str(&args).map_err(|e| e.to_string())?;
    let origin = match service_origin(&a.base_url) {
        Some(o) => o,
        None => return Ok(json!({ "kind": "error", "detail": "Base URL 填得不对，解析不出地址" })),
    };
    let url = format!("{}/v1/models", origin);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.get(&url).header("Accept", "application/json");
    // 有 Key 就带上（有些本地代理会要求）；没有就别发空的 Authorization
    let key = a.api_key.trim().to_string();
    if !key.is_empty() {
        req = req.bearer_auth(&key);
    }
    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            let detail = if e.is_timeout() {
                "超时（5s）".to_string()
            } else {
                format!("{}", e)
            };
            return Ok(json!({ "kind": "unreachable", "detail": detail, "url": url }));
        }
    };
    let status = resp.status();
    // 回传实际请求的 URL：报错必须用它，不能拿渲染层的原始 base_url 自己拼
    // （实测拼出过 /v1/v1/models，误导排查）
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Ok(json!({ "kind": "unauthorized", "detail": format!("HTTP {}", status.as_u16()), "url": url }));
    }
    if !status.is_success() {
        return Ok(json!({ "kind": "bad-endpoint", "detail": format!("HTTP {}", status.as_u16()), "url": url }));
    }
    let j: Value = resp.json().await.map_err(|e| e.to_string())?;
    let models: Vec<String> = j
        .get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    Ok(json!({ "kind": "ok", "models": models, "url": url }))
}

/* ==================================================================== */
/* 导出文本（save_text）                                                 */
/*                                                                      */
/* 与 Electron 端 save-text 同规格：系统另存为对话框 + UTF-8 BOM          */
/* （BOM 是给 Excel / 记事本的：中文 CSV 不带 BOM 打开就是乱码，实测）。  */
/* ==================================================================== */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveTextArgs {
    content: String,
    default_name: String,
}

#[tauri::command]
async fn save_text(app: tauri::AppHandle, args: String) -> Result<Value, String> {
    use tauri_plugin_dialog::DialogExt;
    let a: SaveTextArgs = serde_json::from_str(&args).map_err(|e| e.to_string())?;
    let name = a.default_name.clone();
    // 同上：blocking_save_file 必须挪出 tokio worker，否则会堵住 IPC 队列
    let dlg4 = app.clone();
    let chosen = tauri::async_runtime::spawn_blocking(move || {
        dlg4.dialog().file().set_file_name(&name).blocking_save_file()
    })
    .await
    .map_err(|e| format!("另存为对话框异常: {}", e))?;
    let path = match chosen {
        Some(p) => p.into_path().map_err(|e| e.to_string())?,
        None => return Ok(json!({ "saved": false, "canceled": true })),
    };
    let path_str = path.to_string_lossy().to_string();
    let mut bytes = vec![0xEF, 0xBB, 0xBF]; // UTF-8 BOM
    bytes.extend_from_slice(a.content.as_bytes());
    std::fs::write(&path, &bytes).map_err(|e| format!("保存失败: {}", e))?;
    Ok(json!({ "saved": true, "path": path_str }))
}

/* ==================================================================== */
/* 文件信息 + EXIF（file_info）                                          */
/*                                                                      */
/* 移植自 electron/file-info.cjs，语义逐条对齐：                          */
/*  - 只读文件头 512KB（EXIF 一定在文件前部，大图不整个读进来）            */
/*  - JPEG：APP1/Exif 段 → TIFF 头 → IFD0 → EXIF IFD / GPS IFD           */
/*  - PNG：IHDR 尺寸 + eXIf 块（裸 TIFF，与 JPEG 的 EXIF 同构）           */
/*  - 任何一步失败都不报错 —— 看图器不该因为 EXIF 坏了就打不开图          */
/* 【为什么补这条】此前 Rust 侧根本没有这个命令，前端 readFileInfo 调用   */
/* 失败被 catch 静默吞掉 —— Tauri 壳里 EXIF 面板整个失效还无人知晓。      */
/* ==================================================================== */

fn fmt_bytes(n: u64) -> String {
    if n < 1024 {
        format!("{} B", n)
    } else if n < 1024 * 1024 {
        format!("{:.1} KB", n as f64 / 1024.0)
    } else {
        format!("{:.1} MB", n as f64 / 1048576.0)
    }
}

/// 读一个以 NUL 结尾的 latin1 串（与 JS readAscii 一致：去尾部 NUL 再 trim）
fn read_ascii(buf: &[u8], off: usize, len: usize) -> String {
    if off + len > buf.len() {
        return String::new();
    }
    let s: String = buf[off..off + len].iter().map(|&b| b as char).collect();
    s.trim_end_matches('\0').trim().to_string()
}

/// 找到 JPEG APP1(0xFFE1) 且以 "Exif\0\0" 开头的段，返回 TIFF 头起始偏移
fn find_exif_tiff_start(buf: &[u8]) -> Option<usize> {
    if buf.len() < 4 || buf[0] != 0xFF || buf[1] != 0xD8 {
        return None; // 不是 JPEG
    }
    let mut off = 2usize;
    while off + 4 <= buf.len() {
        if buf[off] != 0xFF {
            off += 1;
            continue;
        }
        let marker = buf[off + 1];
        if marker == 0xD8 || marker == 0x01 || (0xD0..=0xD7).contains(&marker) {
            off += 2;
            continue;
        }
        if marker == 0xDA || marker == 0xD9 {
            break; // 进入图像数据，EXIF 只会在前面
        }
        let seg_len = u16::from_be_bytes([buf[off + 2], buf[off + 3]]) as usize;
        if marker == 0xE1 && read_ascii(buf, off + 4, 6) == "Exif" {
            return Some(off + 10); // 跳过 FFE1 + 长度(2) + "Exif\0\0"(6)
        }
        off += 2 + seg_len;
    }
    None
}

#[derive(Clone, Copy, PartialEq)]
enum TagSet {
    Ifd0,
    Exif,
    Gps,
}

fn tag_key(set: TagSet, tag: u16) -> Option<&'static str> {
    Some(match (set, tag) {
        (TagSet::Ifd0, 0x010F) => "make",
        (TagSet::Ifd0, 0x0110) => "model",
        (TagSet::Ifd0, 0x0112) => "orientation",
        (TagSet::Ifd0, 0x0132) => "dateTime",
        (TagSet::Ifd0, 0x0131) => "software",
        (TagSet::Ifd0, 0x011A) => "xResolution",
        (TagSet::Ifd0, 0x011B) => "yResolution",
        (TagSet::Ifd0, 0x8769) => "_exifIfd",
        (TagSet::Ifd0, 0x8825) => "_gpsIfd",
        (TagSet::Exif, 0x829A) => "exposureTime",
        (TagSet::Exif, 0x829D) => "fNumber",
        (TagSet::Exif, 0x8827) => "iso",
        (TagSet::Exif, 0x9003) => "dateTimeOriginal",
        (TagSet::Exif, 0x9004) => "dateTimeDigitized",
        (TagSet::Exif, 0x9201) => "shutterSpeedValue",
        (TagSet::Exif, 0x9202) => "apertureValue",
        (TagSet::Exif, 0x920A) => "focalLength",
        (TagSet::Exif, 0x9290) => "subSecTime",
        (TagSet::Exif, 0xA434) => "lensModel",
        (TagSet::Exif, 0xA433) => "lensMake",
        (TagSet::Exif, 0x0100) => "imageWidth",
        (TagSet::Exif, 0x0101) => "imageHeight",
        (TagSet::Gps, 0x0001) => "gpsLatRef",
        (TagSet::Gps, 0x0002) => "gpsLat",
        (TagSet::Gps, 0x0003) => "gpsLonRef",
        (TagSet::Gps, 0x0004) => "gpsLon",
        (TagSet::Gps, 0x0005) => "gpsAltRef",
        (TagSet::Gps, 0x0006) => "gpsAlt",
        _ => return None,
    })
}

/// 解析一个 IFD（与 JS parseIfd 同构；越界一律当 0 处理，绝不 panic）
fn parse_ifd(
    buf: &[u8],
    tiff: usize,
    ifd_off: u32,
    set: TagSet,
    out: &mut Map<String, Value>,
    depth: u32,
) {
    if depth > 3 || tiff >= buf.len() {
        return;
    }
    let little = buf[tiff] == 0x49;
    let rd16 = |o: usize| -> u16 {
        if o + 2 > buf.len() {
            0
        } else if little {
            u16::from_le_bytes([buf[o], buf[o + 1]])
        } else {
            u16::from_be_bytes([buf[o], buf[o + 1]])
        }
    };
    let rd32 = |o: usize| -> u32 {
        if o + 4 > buf.len() {
            0
        } else if little {
            u32::from_le_bytes([buf[o], buf[o + 1], buf[o + 2], buf[o + 3]])
        } else {
            u32::from_be_bytes([buf[o], buf[o + 1], buf[o + 2], buf[o + 3]])
        }
    };
    let abs = tiff + ifd_off as usize;
    if abs + 2 > buf.len() {
        return;
    }
    let count = rd16(abs) as usize;
    // type → 字节数；未知类型按 1（与 JS (SIZE[type]||1) 一致）
    const SIZE: [usize; 11] = [1, 1, 1, 2, 4, 8, 1, 1, 1, 4, 8];
    for i in 0..count {
        let e = abs + 2 + i * 12;
        if e + 12 > buf.len() {
            break;
        }
        let tag = rd16(e);
        let ty = rd16(e + 2) as usize;
        let num = rd32(e + 4) as usize;
        let unit = if ty < SIZE.len() { SIZE[ty] } else { 1 };
        let sz = unit * num;
        let val_off = if sz <= 4 { e + 8 } else { tiff + rd32(e + 8) as usize };
        let key = match tag_key(set, tag) {
            Some(k) => k,
            None => continue,
        };
        if val_off >= buf.len() {
            continue;
        }

        // IFD 链指针：EXIF IFD / GPS IFD 递归展开
        if key == "_exifIfd" {
            if ty == 4 {
                parse_ifd(buf, tiff, rd32(val_off), TagSet::Exif, out, depth + 1);
            }
            continue;
        }
        if key == "_gpsIfd" {
            if ty == 4 {
                parse_ifd(buf, tiff, rd32(val_off), TagSet::Gps, out, depth + 1);
            }
            continue;
        }

        let val: Value = match ty {
            2 => json!(read_ascii(buf, val_off, num)),
            3 => {
                if num == 1 {
                    json!(rd16(val_off))
                } else {
                    let arr: Vec<Value> =
                        (0..num).map(|k| json!(rd16(val_off + k * 2))).collect();
                    json!(arr)
                }
            }
            4 => json!(rd32(val_off)),
            5 | 10 => {
                // 有理数：4 字节分子 + 4 字节分母
                let nums: Vec<f64> = (0..num)
                    .map(|k| {
                        let n = rd32(val_off + k * 8) as f64;
                        let d = rd32(val_off + k * 8 + 4) as f64;
                        if d != 0.0 {
                            n / d
                        } else {
                            0.0
                        }
                    })
                    .collect();
                if nums.len() == 1 {
                    json!(nums[0])
                } else {
                    json!(nums)
                }
            }
            _ => continue, // JS 里其余类型 val=null → 不写入
        };
        // JS：val !== null && val !== "" 才写入（空串跳过，数字照写）
        let is_empty_str = val.as_str().map(|s| s.is_empty()).unwrap_or(false);
        if !is_empty_str {
            out.insert(key.to_string(), val);
        }
    }
}

fn parse_jpeg_exif(buf: &[u8]) -> Option<Map<String, Value>> {
    let tiff = find_exif_tiff_start(buf)?;
    let little = buf[tiff] == 0x49;
    let rd32 = |o: usize| -> u32 {
        if o + 4 > buf.len() {
            0
        } else if little {
            u32::from_le_bytes([buf[o], buf[o + 1], buf[o + 2], buf[o + 3]])
        } else {
            u32::from_be_bytes([buf[o], buf[o + 1], buf[o + 2], buf[o + 3]])
        }
    };
    let mut out = Map::new();
    let ifd0 = rd32(tiff + 4);
    parse_ifd(buf, tiff, ifd0, TagSet::Ifd0, &mut out, 0);
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// PNG：IHDR 给宽高；eXIf 块里是裸 TIFF（和 JPEG 的 EXIF 同构）
fn parse_png(buf: &[u8]) -> Option<(u32, u32, Option<Map<String, Value>>)> {
    if buf.len() < 24 || buf[0..4] != [0x89, 0x50, 0x4E, 0x47] {
        return None;
    }
    let w = u32::from_be_bytes([buf[16], buf[17], buf[18], buf[19]]);
    let h = u32::from_be_bytes([buf[20], buf[21], buf[22], buf[23]]);
    let mut exif = None;
    let mut off = 8usize;
    while off + 8 <= buf.len() {
        let len = u32::from_be_bytes([buf[off], buf[off + 1], buf[off + 2], buf[off + 3]]) as usize;
        let t = &buf[off + 4..off + 8];
        if t == b"eXIf" {
            let tiff = off + 8;
            if tiff < buf.len() {
                let little = buf[tiff] == 0x49;
                let rd32 = |o: usize| -> u32 {
                    if o + 4 > buf.len() {
                        0
                    } else if little {
                        u32::from_le_bytes([buf[o], buf[o + 1], buf[o + 2], buf[o + 3]])
                    } else {
                        u32::from_be_bytes([buf[o], buf[o + 1], buf[o + 2], buf[o + 3]])
                    }
                };
                // 容错：EXIF 坏了不该影响看图（与 JS try/catch 一致）
                let mut m = Map::new();
                parse_ifd(buf, tiff, rd32(tiff + 4), TagSet::Ifd0, &mut m, 0);
                if !m.is_empty() {
                    exif = Some(m);
                }
            }
            break;
        }
        if t == b"IDAT" || t == b"IEND" {
            break;
        }
        off += 12 + len;
    }
    Some((w, h, exif))
}

/// 把原始 EXIF 值整理成给人看的中文标签（与 JS humanize 逐条对齐）
fn humanize(exif: Option<&Map<String, Value>>) -> Option<Map<String, Value>> {
    let e = exif?;
    let mut out = Map::new();
    let get_str = |key: &str| -> String {
        e.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string()
    };
    let get_f64 = |key: &str| -> Option<f64> { e.get(key).and_then(|v| v.as_f64()) };
    // JS Math.round(x*10)/10：整数时不带 .0（"f/4" 而不是 "f/4.0"）
    let round1 = |x: f64| -> String {
        let r = (x * 10.0).round() / 10.0;
        if r == r.trunc() {
            format!("{}", r as i64)
        } else {
            format!("{:.1}", r)
        }
    };
    let mut put = |k: &str, v: String| {
        if !v.is_empty() {
            out.insert(k.to_string(), json!(v));
        }
    };

    let make = get_str("make");
    let model = get_str("model");
    let cam = format!("{} {}", make, model)
        .split_whitespace()
        .collect::<Vec<&str>>()
        .join(" ");
    put("相机", cam);

    let lens = {
        let a = get_str("lensModel");
        if a.is_empty() {
            get_str("lensMake")
        } else {
            a
        }
    };
    put("镜头", lens);

    if let Some(f) = get_f64("fNumber") {
        if f > 0.0 {
            put("光圈", format!("f/{}", round1(f)));
        }
    }
    if let Some(s) = get_f64("exposureTime") {
        if s > 0.0 {
            let txt = if s >= 1.0 {
                format!("{} s", round1(s))
            } else {
                format!("1/{} s", (1.0 / s).round() as i64)
            };
            put("快门", txt);
        }
    }
    if let Some(iso) = get_f64("iso") {
        if iso > 0.0 {
            put("ISO", format!("{}", iso.round() as i64));
        }
    }
    if let Some(fl) = get_f64("focalLength") {
        if fl > 0.0 {
            put("焦距", format!("{} mm", fl.round() as i64));
        }
    }
    let shot_time = {
        let a = get_str("dateTimeOriginal");
        if a.is_empty() {
            get_str("dateTime")
        } else {
            a
        }
    };
    put("拍摄时间", shot_time);
    put("软件", get_str("software"));

    if let (Some(lat_arr), Some(lon_arr)) = (
        e.get("gpsLat").and_then(|v| v.as_array()),
        e.get("gpsLon").and_then(|v| v.as_array()),
    ) {
        let dms = |a: &[Value]| -> f64 {
            a.iter()
                .take(3)
                .filter_map(|v| v.as_f64())
                .enumerate()
                .fold(0.0, |acc, (i, x)| acc + x / 60f64.powi(i as i32))
        };
        let mut lat = dms(lat_arr);
        let mut lon = dms(lon_arr);
        if get_str("gpsLatRef") == "S" {
            lat = -lat;
        }
        if get_str("gpsLonRef") == "W" {
            lon = -lon;
        }
        if lat != 0.0 || lon != 0.0 {
            put("拍摄位置", format!("{:.6}, {:.6}", lat, lon));
        }
    }

    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

#[tauri::command]
fn file_info(path: String) -> Value {
    if !path_allowed(&path) {
        let mut info = Map::new();
        info.insert("error".into(), json!("目录未授权：请先通过应用打开该图片"));
        return Value::Object(info);
    }
    let p = Path::new(&path);
    let mut info = Map::new();
    let name = p
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = p
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    info.insert("name".into(), json!(name));
    info.insert("path".into(), json!(path));
    info.insert("ext".into(), json!(ext));

    let md = match std::fs::metadata(&path) {
        Ok(m) => m,
        Err(e) => {
            info.insert("error".into(), json!(format!("读取文件属性失败：{}", e)));
            return Value::Object(info);
        }
    };
    let bytes = md.len();
    info.insert("bytes".into(), json!(bytes));
    info.insert("sizeText".into(), json!(fmt_bytes(bytes)));
    let mtime = match md.modified() {
        Ok(t) => t,
        Err(e) => {
            info.insert("error".into(), json!(format!("读取文件属性失败：{}", e)));
            return Value::Object(info);
        }
    };
    let dt: chrono::DateTime<chrono::Local> = mtime.into();
    info.insert(
        "mtime".into(),
        json!(dt.to_utc().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
    );
    info.insert(
        "mtimeText".into(),
        json!(dt.format("%Y/%-m/%-d %H:%M:%S").to_string()),
    );

    // 只读文件头若干字节就够（EXIF 一定在前面），避免大图整个读进来
    let buf = (|| -> Result<Vec<u8>, String> {
        use std::io::Read;
        let f = std::fs::File::open(&path).map_err(|e| format!("读取文件失败：{}", e))?;
        let cap = (bytes as usize).min(512 * 1024);
        let mut buf = Vec::with_capacity(cap);
        f.take(cap as u64)
            .read_to_end(&mut buf)
            .map_err(|e| format!("读取文件失败：{}", e))?;
        Ok(buf)
    })();
    let buf = match buf {
        Ok(b) => b,
        Err(msg) => {
            info.insert("error".into(), json!(msg));
            return Value::Object(info);
        }
    };

    if ext == "png" {
        if let Some((w, h, exif)) = parse_png(&buf) {
            info.insert("width".into(), json!(w));
            info.insert("height".into(), json!(h));
            if let Some(hm) = humanize(exif.as_ref()) {
                info.insert("exif".into(), Value::Object(hm));
            }
        }
    } else {
        let raw = parse_jpeg_exif(&buf);
        if let Some(hm) = humanize(raw.as_ref()) {
            info.insert("exif".into(), Value::Object(hm));
        }
        if let Some(r) = &raw {
            if let (Some(w), Some(h)) = (
                r.get("imageWidth").and_then(|v| v.as_u64()),
                r.get("imageHeight").and_then(|v| v.as_u64()),
            ) {
                info.insert("width".into(), json!(w));
                info.insert("height".into(), json!(h));
            }
        }
    }
    Value::Object(info)
}

/* ==================================================================== */
/* 通用设置：文件关联 / 开机自启 / 缓存清理                               */
/*                                                                      */
/* 全部只写 HKCU（当前用户），不碰系统层、不抢默认程序 ——                  */
/* 文件关联只是把本程序加入各格式的「打开方式」列表，是否设为默认由用户在 */
/* 资源管理器里自己勾选。缓存清理走「标记 + 下次启动生效」，避免和运行中  */
/* 的 WebView2 抢文件。                                                  */
/* ==================================================================== */

const ASSOC_PROGID: &str = "AIImageViewer.Image";
const ASSOC_EXTS: [&str; 10] = [
    "png", "jpg", "jpeg", "jfif", "webp", "bmp", "gif", "avif", "ico", "svg",
];
const RUN_VALUE_NAME: &str = "AIImageViewer";

/// 调 reg.exe（隐藏窗口）。返回 (exit_code, stdout+stderr)
fn reg(args: &[&str]) -> (i32, String) {
    let mut cmd = std::process::Command::new("reg");
    cmd.args(args);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    match cmd.output() {
        Ok(o) => (
            o.status.code().unwrap_or(-1),
            format!(
                "{}{}",
                String::from_utf8_lossy(&o.stdout),
                String::from_utf8_lossy(&o.stderr)
            ),
        ),
        Err(e) => (-1, format!("{}", e)),
    }
}

fn assoc_registered() -> bool {
    let (code, _) = reg(&[
        "query",
        r"HKCU\Software\Classes\.png\OpenWithProgids",
        "/v",
        ASSOC_PROGID,
    ]);
    code == 0
}

fn autostart_enabled() -> bool {
    let (code, _) = reg(&[
        "query",
        r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
        "/v",
        RUN_VALUE_NAME,
    ]);
    code == 0
}

#[tauri::command]
fn general_state() -> Value {
    json!({
        "autostart": autostart_enabled(),
        "assoc": assoc_registered(),
        "exe": std::env::current_exe().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
        "isTauri": true,
    })
}

/// 文件关联：注册 ProgId + 把本程序加进各扩展名的 OpenWithProgids（不抢默认）
#[tauri::command]
fn set_file_assoc(enable: bool) -> Result<Value, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_q = format!("\"{}\"", exe.to_string_lossy());
    if enable {
        let fail = |step: &str, out: &str| -> Result<Value, String> {
            Err(format!("注册失败（{}）：{}", step, out.trim().chars().take(120).collect::<String>()))
        };
        let (c, o) = reg(&["add", r"HKCU\Software\Classes\AIImageViewer.Image", "/ve", "/d", "AI Image Viewer 图片", "/f"]);
        if c != 0 { return fail("ProgId", &o); }
        let (c, o) = reg(&["add", r"HKCU\Software\Classes\AIImageViewer.Image\DefaultIcon", "/ve", "/d", &format!("{},0", exe.to_string_lossy()), "/f"]);
        if c != 0 { return fail("DefaultIcon", &o); }
        let (c, o) = reg(&[
            "add",
            r"HKCU\Software\Classes\AIImageViewer.Image\shell\open\command",
            "/ve",
            "/d",
            &format!("\"{}\" \"%1\"", exe.to_string_lossy()),
            "/f",
        ]);
        if c != 0 { return fail("open command", &o); }
        for e in ASSOC_EXTS {
            let key = format!(r"HKCU\Software\Classes\.{}\OpenWithProgids", e);
            let (c, o) = reg(&["add", &key, "/v", ASSOC_PROGID, "/d", "", "/f"]);
            if c != 0 { return fail(&format!(".{}", e), &o); }
        }
        let _ = exe_q;
        Ok(json!({ "ok": true, "assoc": true,
            "message": "已加入打开方式列表。右键图片 → 打开方式 → 选择其他应用 → AI Image Viewer → 勾「始终」即可设为默认。" }))
    } else {
        for e in ASSOC_EXTS {
            let key = format!(r"HKCU\Software\Classes\.{}\OpenWithProgids", e);
            let _ = reg(&["delete", &key, "/v", ASSOC_PROGID, "/f"]);
        }
        let _ = reg(&["delete", r"HKCU\Software\Classes\AIImageViewer.Image", "/f"]);
        Ok(json!({ "ok": true, "assoc": false, "message": "已从打开方式列表移除（已设过的默认程序需要在资源管理器里改回）" }))
    }
}

/// 开机自启：HKCU Run 键（只影响当前用户，不需要管理员）
#[tauri::command]
fn set_autostart(enable: bool) -> Result<Value, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    if enable {
        let (c, o) = reg(&[
            "add",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
            "/v",
            RUN_VALUE_NAME,
            "/d",
            &format!("\"{}\"", exe.to_string_lossy()),
            "/f",
        ]);
        if c != 0 {
            return Ok(json!({ "ok": false, "message": format!("写入失败：{}", o.trim()) }));
        }
        Ok(json!({ "ok": true, "autostart": true, "message": "已开启开机自启" }))
    } else {
        let _ = reg(&[
            "delete",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
            "/v",
            RUN_VALUE_NAME,
            "/f",
        ]);
        Ok(json!({ "ok": true, "autostart": false, "message": "已关闭开机自启" }))
    }
}

/// 缓存清理：写标记文件，**下次启动**时在 WebView2 创建之前删（运行中删必然被锁）。
#[tauri::command]
fn request_clear_cache() -> Result<Value, String> {
    let base = std::env::var("LOCALAPPDATA").map_err(|e| e.to_string())?;
    let dir = std::path::Path::new(&base).join("com.aiimageviewer.app");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let flag = dir.join("cache-clear.flag");
    // 顺手统计一下当前缓存体积，给用户一个概念
    let mut bytes = 0u64;
    for root in [dir.join("EBWebView")] {
        if root.exists() {
            for entry in walk_files(&root) {
                if let Ok(md) = entry.metadata() {
                    bytes += md.len();
                }
            }
        }
    }
    std::fs::write(&flag, "1").map_err(|e| e.to_string())?;
    Ok(json!({
        "ok": true,
        "bytes": bytes,
        "message": format!("已登记清理（当前缓存约 {:.1} MB）。下次启动软件时自动清空并重建。", bytes as f64 / 1048576.0)
    }))
}

fn walk_files(root: &Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        if let Ok(rd) = std::fs::read_dir(&d) {
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else {
                    out.push(p);
                }
            }
        }
    }
    out
}

fn walk_dirs(root: &Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        if let Ok(rd) = std::fs::read_dir(&d) {
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    out.push(p.clone());
                    stack.push(p);
                }
            }
        }
    }
    out
}

/// 只探测不拉起：给设置页的「检测 IOPaint 服务」按钮用（ensure_server 有拉起副作用）。
#[tauri::command]
async fn iopaint_probe(args: String) -> Result<Value, String> {
    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        base_url: String,
        /// 启动命令。**可选**（旧版设置里没这个字段）——
        /// 拿它只为诊断「启动程序在不在」，拿不到就跳过那一条诊断。
        #[serde(default)]
        cmd: String,
    }
    let a: Args = serde_json::from_str(&args).map_err(|e| e.to_string())?;
    let base = if a.base_url.trim().is_empty() {
        "http://127.0.0.1:8080".to_string()
    } else {
        a.base_url.trim().to_string()
    };
    // 诊断要用 cmd（启动程序路径），base 已算好
    let cmd_line = a.cmd.clone();
    match probe_iopaint(&base, 3).await {
        Some((model, _)) => Ok(json!({
            "ok": true,
            "model": model,
            "message": match model {
                Some(m) => format!("IOPaint 在运行（模型：{}）", m),
                None => "IOPaint 在运行".to_string(),
            }
        })),
        None => {
            // 【为什么要给诊断】实测这台机器上 `iopaint start` 拉起后
            // 8080 从未监听，而旧文案只说「没在运行」——用户无法判断是
            // 没启动、端口被占、还是 IOPaint 本身坏了。这里把可查的事实
            // 一次性摆出来，省得反复试。
            let mut notes: Vec<String> = Vec::new();

            // ① 启动命令里的 exe 在不在
            if let Some(exe) = cmd_line.split_whitespace().next() {
                notes.push(if std::path::Path::new(exe).exists() {
                    format!("启动程序存在：{}", exe)
                } else {
                    format!("✗ 启动程序不存在：{}（设置里的启动命令要改）", exe)
                });
            }

            // ② 端口有没有被别的程序占着
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                let port = base
                    .rsplit(':')
                    .next()
                    .and_then(|s| s.split('/').next())
                    .unwrap_or("8080")
                    .to_string();
                let out = std::process::Command::new("netstat")
                    .args(["-ano", "-p", "tcp"])
                    .creation_flags(0x0800_0000) // CREATE_NO_WINDOW：别弹黑框
                    .output();
                if let Ok(o) = out {
                    let text = String::from_utf8_lossy(&o.stdout);
                    let listening: Vec<&str> = text
                        .lines()
                        .filter(|l| l.contains(&format!(":{}", port)) && l.contains("LISTENING"))
                        .collect();
                    if listening.is_empty() {
                        notes.push(format!("端口 {} 空闲（没有被别的程序占）", port));
                    } else {
                        notes.push(format!(
                            "⚠ 端口 {} 已被占用，但 IOPaint 没响应 —— 多半是别的程序占了",
                            port
                        ));
                    }
                }
            }

            let mut msg = String::from("IOPaint 服务没有在运行。\n");
            for n in &notes {
                msg.push_str("  · ");
                msg.push_str(n);
                msg.push('\n');
            }
            msg.push_str("  · 去水印时选 IOPaint 引擎会自动拉起（最多等 120 秒）\n");
            msg.push_str("  · 想看真实报错请双击项目里的「启动IOPaint.cmd」，控制台会打印下载进度与错误");

            Ok(json!({
                "ok": false,
                "message": msg,
                "diagnostics": notes,
            }))
        }
    }
}

/* ==================================================================== */
/* 无头自检（E2E 验证通道，绕开 CDP wedged 问题）                          */
/*                                                                      */
/* 设置环境变量 AIIV_SELFTEST_OUT 后启动：进程直接执行一组真实命令        */
/* （file_info / list_images / write_processed），结果写 JSON 后退出。    */
/* 全程不开窗口、不进事件循环 —— scripts/selftest-check.py 负责驱动。     */
/* ==================================================================== */

/* ==================================================================== */
/* 缩略图持久缓存（2026-10-04）                                          */
/*                                                                      */
/* 【为什么在壳层做】前端 <img> 直接加载原图解码做缩略：一张 20MB 大图    */
/* 解码 1 秒+，虚拟滚动每次路过都要重新解码；Windows Photos 也因为       */
/* 「缩略图不缓存」被长期吐槽（实测 4000 张图加载一分多钟）。             */
/* 这里生成 320px JPEG 落盘，第二次打开同一文件夹毫秒级命中。            */
/* 缓存键 = FNV1a(路径 + mtime + 文件大小 + 尺寸)：图片一变自动失效。     */
/* ==================================================================== */

/// FNV-1a 64 位哈希：够散、无依赖。
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

fn thumbs_dir() -> Option<std::path::PathBuf> {
    let base = std::env::var("LOCALAPPDATA").ok()?;
    let d = std::path::Path::new(&base)
        .join("com.aiimageviewer.app")
        .join("thumbs");
    let _ = std::fs::create_dir_all(&d);
    Some(d)
}

/// 缩略图核心（同步）：命中缓存直接读；未命中解码->缩放->写缓存。
/// 返回 (dataUrl, cached, elapsedMs, 失败原因)。
fn thumbnail_impl(path: &str, size: u32) -> (Option<String>, bool, u128, Option<String>) {
    let t0 = std::time::Instant::now();
    let p = std::path::Path::new(path);
    if !p.exists() {
        return (None, false, 0, Some("文件不存在".into()));
    }
    let meta = match std::fs::metadata(p) {
        Ok(m) => m,
        Err(e) => return (None, false, 0, Some(format!("读取元数据失败: {}", e))),
    };
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let key_src = format!("{}|{}|{}|{}", path, mtime, meta.len(), size);
    let key = fnv1a(key_src.as_bytes());
    let d = match thumbs_dir() {
        Some(d) => d,
        None => return (None, false, 0, Some("无法定位缓存目录".into())),
    };
    let cache = d.join(format!("{:016x}.jpg", key));

    // ① 命中：直接读缓存
    if let Ok(bytes) = std::fs::read(&cache) {
        let url = format!("data:image/jpeg;base64,{}", base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD, &bytes));
        return (Some(url), true, t0.elapsed().as_millis(), None);
    }

    // ② 未命中：解码原图 -> 等比缩放 -> 写缓存
    //    解码大图可达秒级，调用方必须放在 spawn_blocking 里。
    //    三段错误（打开/格式探测/解码）统一折叠成一条原因，前端只管回退。
    let img = (|| -> Option<image::DynamicImage> {
        let r = image::ImageReader::open(p).ok()?;
        let r = r.with_guessed_format().ok()?;
        r.decode().ok()
    })();
    let img = match img {
        Some(i) => i,
        None => {
            // RAW/HEIC/TIFF 等暂不支持解码 —— 前端回退到原图 <img>
            return (
                None,
                false,
                t0.elapsed().as_millis(),
                Some("解码失败（格式可能不支持）".into()),
            );
        }
    };
    let thumb = if img.width() > size || img.height() > size {
        img.thumbnail(size, size)
    } else {
        img
    };
    let mut jpg = std::io::Cursor::new(Vec::new());
    if let Err(e) = thumb.write_to(&mut jpg, image::ImageFormat::Jpeg) {
        return (None, false, t0.elapsed().as_millis(), Some(format!("JPEG 编码失败: {}", e)));
    }
    let bytes = jpg.into_inner();
    let _ = std::fs::write(&cache, &bytes);
    let url = format!("data:image/jpeg;base64,{}", base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD, &bytes));
    (Some(url), false, t0.elapsed().as_millis(), None)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThumbArgs {
    path: String,
    #[serde(default = "default_thumb_size")]
    size: u32,
}
fn default_thumb_size() -> u32 {
    320
}

/// 缩略图命令：解码可能秒级，必须 spawn_blocking，别堵 tokio worker。
/// 拖入图片落盘：把浏览器拖放的 data URL 写成真实文件并返回路径。
///
/// 【为什么必须有】HTML5 拖放受浏览器安全限制拿不到真实路径，
/// itemFromFile 只能造一个假路径（path=文件名）——
/// 导致批量处理（需要目录）、另存为防覆盖（需要源路径）全部失效，
/// 识别也只能走前端 fetch 的 90s 短超时兜底。
/// 落盘后拖入图与「打开文件」完全等价：真实路径 + 自动授权所在目录。
#[tauri::command]
fn save_drop(app: tauri::AppHandle, args: String) -> Result<Value, String> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        name: String,
        data_url: String,
    }
    let a: Args = serde_json::from_str(&args).map_err(|e| e.to_string())?;
    let (mime, bytes) = split_data_url(&a.data_url)?;
    if bytes.is_empty() {
        return Err("拖入的文件内容为空".into());
    }
    let ext = if mime.contains("jpeg") {
        "jpg"
    } else if mime.contains("webp") {
        "webp"
    } else if mime.contains("gif") {
        "gif"
    } else {
        "png"
    };
    let dir = std::env::var("LOCALAPPDATA")
        .map(|b| {
            std::path::Path::new(&b)
                .join("com.aiimageviewer.app")
                .join("drops")
        })
        .map_err(|_| "无法定位应用数据目录".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {}", e))?;
    let key = fnv1a(format!("{}|{}|{}", a.name, bytes.len(), mime).as_bytes());
    let file = dir.join(format!("{:016x}-{}.{}", key, sanitize_name(&a.name), ext));
    std::fs::write(&file, &bytes).map_err(|e| format!("写入失败: {}", e))?;
    // 拖入 = 用户明确意图，授权所在目录（批量/识别立刻可用）
    grant_root(Some(&app), &dir.to_string_lossy());
    Ok(json!({ "path": file.to_string_lossy(), "size": bytes.len() }))
}

/// 文件名清洗：只保留安全字符，防路径注入。
fn sanitize_name(name: &str) -> String {
    let stem = name.rsplit_once('.').map(|(s, _)| s).unwrap_or(name);
    let ok: String = stem
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-')
        .take(40)
        .collect();
    if ok.is_empty() { "drop".into() } else { ok }
}

/// 【EXIF 归一化】接收前端 canvas 转正后的图，写到固定名临时文件。
/// 覆盖式写入（同名），配合前端缓存 —— 同一张图只归一化一次。
#[tauri::command]
fn write_temp_image(app: tauri::AppHandle, data_url: String) -> Result<Value, String> {
    let (mime, bytes) = split_data_url(&data_url)?;
    if bytes.is_empty() {
        return Err("内容为空".into());
    }
    let ext = if mime.contains("jpeg") { "jpg" } else { "png" };
    let dir = std::env::var("LOCALAPPDATA")
        .map(|b| {
            std::path::Path::new(&b)
                .join("com.aiimageviewer.app")
                .join("drops")
        })
        .map_err(|_| "无法定位应用数据目录".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {}", e))?;
    let file = dir.join(format!("exif-normalized.{}", ext));
    std::fs::write(&file, &bytes).map_err(|e| format!("写入失败: {}", e))?;
    grant_root(Some(&app), &dir.to_string_lossy());
    Ok(json!({ "path": file.to_string_lossy(), "size": bytes.len() }))
}

/* ==================================================================== */
/* IOPaint 一键自动安装：嵌入式 Python 运行时 + CPU 版 torch + IOPaint   */
/* 全程通过 iopaint-setup-progress 事件向前端汇报进度；状态可轮询。      */
/* ==================================================================== */

static SETUP_STATE: std::sync::Mutex<Value> = std::sync::Mutex::new(Value::Null);

fn setup_state_set(v: Value) {
    *SETUP_STATE.lock().unwrap() = v;
}

fn setup_runtime_root() -> Result<std::path::PathBuf, String> {
    std::env::var("LOCALAPPDATA")
        .map(|b| {
            std::path::Path::new(&b)
                .join("com.aiimageviewer.app")
                .join("iopaint-runtime")
        })
        .map_err(|_| "无法定位应用数据目录".to_string())
}

#[derive(Clone, serde::Serialize)]
struct SetupProgress {
    step: i32,
    message: String,
}

fn emit_setup(app: &tauri::AppHandle, step: i32, message: &str) {
    let _ = app.emit(
        "iopaint-setup-progress",
        SetupProgress { step, message: message.to_string() },
    );
    setup_state_set(json!({ "state": "running", "step": step, "message": message }));
}

async fn setup_download(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    app: &tauri::AppHandle,
    step: i32,
    label: &str,
) -> Result<u64, String> {
    let mut resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("下载失败 {}: {}", url, e))?;
    if !resp.status().is_success() {
        return Err(format!("下载失败 {}: HTTP {}", url, resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(dest).map_err(|e| e.to_string())?;
    use std::io::Write;
    let mut got: u64 = 0;
    let mut last_emit = -5.0f64;
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        got += chunk.len() as u64;
        if total > 0 {
            let pct = (got as f64 / total as f64) * 100.0;
            if pct - last_emit >= 10.0 {
                last_emit = pct;
                emit_setup(
                    app,
                    step,
                    &format!("{} {:.0}%（{}/{}MB）", label, pct, got / 1048576, total / 1048576),
                );
            }
        }
    }
    file.flush().ok();
    Ok(got)
}

/// 多源下载：按顺序尝试 mirrors 列表，第一个成功即返回（国内镜像优先，官方源兜底）。
async fn setup_download_multi(
    client: &reqwest::Client,
    urls: &[&str],
    dest: &Path,
    app: &tauri::AppHandle,
    step: i32,
    label: &str,
) -> Result<u64, String> {
    let mut last_err = String::new();
    for url in urls {
        match setup_download(client, url, dest, app, step, label).await {
            Ok(n) => return Ok(n),
            Err(e) => {
                last_err = e;
                let _ = std::fs::remove_file(dest);
            }
        }
    }
    Err(format!("所有下载源均失败：{}", last_err))
}

fn unzip_all(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut arch = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    for i in 0..arch.len() {
        let mut f = arch.by_index(i).map_err(|e| e.to_string())?;
        let out = dest.join(f.mangled_name());
        if f.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut w = std::fs::File::create(&out).map_err(|e| e.to_string())?;
        std::io::copy(&mut f, &mut w).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn trim_err(s: &str) -> String {
    s.chars().take(400).collect()
}

async fn run_iopaint_setup(app: tauri::AppHandle) -> Result<String, String> {
    let root = setup_runtime_root()?;
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60 * 30))
        .build()
        .map_err(|e| e.to_string())?;

    let py_dir = root.join("python");
    let py_exe = py_dir.join("python.exe");
    let iopaint_exe = py_dir.join("Scripts").join("iopaint.exe");

    // 重复安装保护：已装过直接返回命令
    if iopaint_exe.exists() {
        return Ok(format!(
            "\"{}\" start --model=lama --device=cpu --port=8080 --host=127.0.0.1",
            iopaint_exe.display()
        ));
    }

    // 步骤 1：下载嵌入式 Python（11MB，官方 python.org）
    emit_setup(&app, 1, "下载嵌入式 Python（11MB）…");
    let zip_path = root.join("python-embed.zip");
    if !zip_path.exists() {
        setup_download_multi(
            &client,
            &[
                // 国内镜像优先（华为云同步 python 官方包），官方源兜底
                "https://mirrors.huaweicloud.com/python/3.10.11/python-3.10.11-embed-amd64.zip",
                "https://www.python.org/ftp/python/3.10.11/python-3.10.11-embed-amd64.zip",
            ],
            &zip_path,
            &app,
            1,
            "下载 Python",
        )
        .await?;
    }
    std::fs::create_dir_all(&py_dir).map_err(|e| e.to_string())?;
    unzip_all(&zip_path, &py_dir).map_err(|e| format!("解压 Python 失败: {}", e))?;

    // 步骤 2：启用 site-packages 并安装 pip
    emit_setup(&app, 2, "初始化 pip…");
    let pth = py_dir.join("python310._pth");
    std::fs::write(&pth, "python310.zip\n.\nLib/site-packages\nimport site\n")
        .map_err(|e| e.to_string())?;
    let getpip = root.join("get-pip.py");
    if !getpip.exists() {
        setup_download_multi(
            &client,
            &[
                "https://mirrors.aliyun.com/pypi/get-pip.py",
                "https://bootstrap.pypa.io/get-pip.py",
            ],
            &getpip,
            &app,
            2,
            "下载 get-pip",
        )
        .await?;
    }
    let out = tokio::process::Command::new(&py_exe)
        .arg(&getpip)
        .arg("-i")
        .arg("https://pypi.tuna.tsinghua.edu.cn/simple")
        .arg("--no-warn-script-location")
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!("pip 初始化失败: {}", trim_err(&String::from_utf8_lossy(&out.stderr))));
    }

    // 步骤 3：先装 CPU 版 PyTorch —— 若不指定，pip 会拉 2GB+ 的 CUDA 版
    emit_setup(&app, 3, "安装 PyTorch CPU 版（约 200MB，需几分钟）…");
    let out = tokio::process::Command::new(&py_exe)
        .args([
            "-m",
            "pip",
            "install",
            "torch",
            "--index-url",
            // 阿里云镜像了 pytorch 官方 CPU wheels；官方源作回退由 pip 额外源承担
            "https://mirrors.aliyun.com/pytorch-wheels/cpu/",
            "--extra-index-url",
            "https://download.pytorch.org/whl/cpu",
            "--no-warn-script-location",
        ])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!(
            "PyTorch 安装失败: {}",
            trim_err(&String::from_utf8_lossy(&out.stderr))
        ));
    }

    // 步骤 4：安装 IOPaint
    emit_setup(&app, 4, "安装 IOPaint（约 100MB）…");
    let out = tokio::process::Command::new(&py_exe)
        .args([
            "-m",
            "pip",
            "install",
            "iopaint",
            "-i",
            "https://pypi.tuna.tsinghua.edu.cn/simple",
            "--no-warn-script-location",
        ])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!(
            "IOPaint 安装失败: {}",
            trim_err(&String::from_utf8_lossy(&out.stderr))
        ));
    }
    if !iopaint_exe.exists() {
        return Err("安装流程结束但未找到 iopaint.exe".into());
    }

    // 步骤 5：生成启动命令
    emit_setup(&app, 5, "写入配置…");
    Ok(format!(
        "\"{}\" start --model=lama --device=cpu --port=8080 --host=127.0.0.1",
        iopaint_exe.display()
    ))
}

#[tauri::command]
fn iopaint_setup_status() -> Value {
    SETUP_STATE.lock().unwrap().clone()
}

#[tauri::command]
async fn iopaint_auto_setup(app: tauri::AppHandle) -> Result<Value, String> {
    {
        let st = SETUP_STATE.lock().unwrap();
        if st.get("state") == Some(&json!("running")) {
            return Ok(json!({ "started": false, "message": "安装正在进行中" }));
        }
    }
    setup_state_set(json!({ "state": "running", "step": 0, "message": "准备下载…" }));
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        match run_iopaint_setup(app2.clone()).await {
            Ok(cmd) => {
                setup_state_set(json!({ "state": "done", "message": "安装完成", "cmd": cmd }));
                let _ = app2.emit(
                    "iopaint-setup-progress",
                    SetupProgress { step: 99, message: "安装完成".into() },
                );
                // 把安装好的 iopaint 写回设置，之后 ensure_server 直接用它
                if let Ok(store) = app2.store(STORE_FILE) {
                    if let Some(mut v) = store.get(SETTINGS_KEY) {
                        if let Some(obj) = v.as_object_mut() {
                            obj.insert("iopaint_cmd".into(), json!(cmd));
                        }
                        store.set(SETTINGS_KEY, v);
                        let _ = store.save();
                    }
                }
            }
            Err(e) => {
                setup_state_set(json!({ "state": "error", "message": e.clone() }));
                let _ = app2.emit(
                    "iopaint-setup-progress",
                    SetupProgress { step: -1, message: format!("安装失败：{}", e) },
                );
            }
        }
    });
    Ok(json!({ "started": true }))
}

/// 【诊断通道】把去水印链路实际使用的 mask/image 落盘，
/// 文件名带选区数值 —— 用户点一次「AI 去掉」，排查者即可直接看到
/// 遮罩盖在了哪里，无需猜坐标换算。
#[tauri::command]
fn write_debug_png(args: String) -> Result<Value, String> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        tag: String,
        rect_json: String,
        data_url: String,
    }
    let a: Args = serde_json::from_str(&args).map_err(|e| e.to_string())?;
    // meta 通道：data_url 不是 data URL 时按 JSON 文本落盘（坐标系数值诊断）
    if !a.data_url.starts_with("data:") {
        let dir = std::env::var("LOCALAPPDATA")
            .map(|b| {
                std::path::Path::new(&b)
                    .join("com.aiimageviewer.app")
                    .join("debug")
            })
            .map_err(|_| "无法定位目录".to_string())?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let file = dir.join(format!("{}_meta.json", a.tag));
        std::fs::write(&file, &a.data_url).map_err(|e| e.to_string())?;
        return Ok(json!({ "path": file.to_string_lossy() }));
    }
    let (mime, bytes) = split_data_url(&a.data_url)?;
    let ext = if mime.contains("jpeg") { "jpg" } else { "png" };
    let dir = std::env::var("LOCALAPPDATA")
        .map(|b| {
            std::path::Path::new(&b)
                .join("com.aiimageviewer.app")
                .join("debug")
        })
        .map_err(|_| "无法定位目录".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // 文件名带上时间戳与选区，多次点击互不覆盖且一眼可读
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let safe_rect = a.rect_json.replace(|c: char| !c.is_alphanumeric() && c != '_' && c != '-', "_");
    let file = dir.join(format!("{}_{}_{}.{}", a.tag, stamp, safe_rect, ext));
    std::fs::write(&file, &bytes).map_err(|e| e.to_string())?;
    Ok(json!({ "path": file.to_string_lossy() }))
}

#[tauri::command]
async fn thumbnail_data(args: String) -> Result<Value, String> {
    let a: ThumbArgs = serde_json::from_str(&args).map_err(|e| e.to_string())?;
    let path = a.path.clone();
    let size = a.size;
    let (url, cached, ms, err) = tauri::async_runtime::spawn_blocking(move || {
        thumbnail_impl(&path, size)
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(json!({
        "ok": url.is_some(),
        "dataUrl": url,
        "cached": cached,
        "elapsedMs": ms,
        "err": err,
    }))
}

fn run_selftest(img: &str) -> Value {
    let mut out = Map::new();
    out.insert("img".into(), json!(img));

    // 授权测试图所在目录 + 临时产出目录（等价于用户真实操作的授权路径）
    let img_path = Path::new(img);
    if let Some(parent) = img_path.parent() {
        grant_root(None, &parent.to_string_lossy());
    }
    let probe_dir = std::env::temp_dir().join("aiiv-selftest").join("aiiv-processed");
    let _ = std::fs::create_dir_all(&probe_dir);
    grant_root(None, &probe_dir.to_string_lossy());

    // ① file_info（含 EXIF 解析 + ACL 放行验证）
    let fi = file_info(img.to_string());
    let fi_ok = fi.get("error").is_none() && fi.get("bytes").and_then(|v| v.as_u64()).unwrap_or(0) > 0;
    out.insert("file_info_ok".into(), json!(fi_ok));
    out.insert("file_info_exif".into(), fi.get("exif").cloned().unwrap_or(Value::Null));

    // ② list_images（ACL 放行后可枚举）
    let dir = img_path.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    match list_images(dir.clone()) {
        Ok(v) => {
            out.insert("list_images_ok".into(), json!(true));
            out.insert("list_images_count".into(), json!(v.len()));
        }
        Err(e) => {
            out.insert("list_images_ok".into(), json!(false));
            out.insert("list_images_err".into(), json!(e));
        }
    }

    // ③ write_processed（真实落盘，1×1 PNG；先清上次自检残留，防「同名跳过」）
    let probe = probe_dir.join("selftest.png");
    let _ = std::fs::remove_file(&probe);
    let tiny = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    let wp_args = WriteProcessedArgs {
        path: probe.to_string_lossy().to_string(),
        data_url: tiny.to_string(),
    };
    let r = write_processed_impl(&wp_args);
    let saved = r.get("saved").and_then(|v| v.as_bool()).unwrap_or(false);
    out.insert(
        "write_processed_ok".into(),
        json!(saved && probe.exists() && probe.metadata().map(|m| m.len() > 0).unwrap_or(false)),
    );

    // ④ thumbnail（性能基线：首次生成 vs 缓存命中）
    {
        let (u1, _c1, ms1, e1) = thumbnail_impl(img, 320);
        out.insert("thumb_gen_ok".into(), json!(u1.is_some()));
        out.insert("thumb_gen_ms".into(), json!(ms1));
        if let Some(e) = e1 {
            out.insert("thumb_gen_err".into(), json!(e));
        }
        let (_, c2, ms2, _) = thumbnail_impl(img, 320);
        out.insert("thumb_cache_hit".into(), json!(c2));
        out.insert("thumb_cache_ms".into(), json!(ms2));
    }

    // ⑤ analyze（真实识别请求：用用户 store 里的真实配置，端到端验证识别链路）
    //    自检进程没有 tauri AppHandle，但 call_vision_api 不依赖它 —— 直接 await。
    {
        // tauri-plugin-store 的 config dir 在 Windows 上是 Roaming（%APPDATA%），
        // 不是 LOCALAPPDATA —— 第一次写成了 LOCALAPPDATA，自检静默读不到。
        let store = std::env::var("APPDATA").ok().and_then(|base| {
            let p = std::path::Path::new(&base)
                .join("com.aiimageviewer.app")
                .join("settings.json");
            std::fs::read_to_string(p).ok()
        });
        if let Some(raw) = store {
            // store 的结构是 { "settings": {...} }（tauri-plugin-store 包一层）
            let settings_json = std::fs::read_to_string(
                std::env::var("APPDATA")
                    .map(|b| {
                        std::path::Path::new(&b)
                            .join("com.aiimageviewer.app")
                            .join("settings.json")
                    })
                    .unwrap_or_default(),
            )
            .ok()
            .and_then(|s| {
                serde_json::from_str::<serde_json::Value>(&s)
                    .ok()
                    .and_then(|v| v.get("settings").cloned())
                    .map(|s| s.to_string())
            });
            if let Some(sj) = settings_json {
                // 用一个 2×2 红色 PNG 做真实识别
                let tiny = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP8z8DwnwEKmBhQAABbKAMFjFePNgAAAABJRU5ErkJggg==";
                match tauri::async_runtime::block_on(call_vision_api(
                    tiny.to_string(),
                    sj.clone(),
                    "一句话描述这张图".into(),
                    60,
                )) {
                    Ok(text) => {
                        out.insert("analyze_ok".into(), json!(true));
                        out.insert("analyze_reply".into(), json!(text.chars().take(80).collect::<String>()));
                    }
                    Err(e) => {
                        out.insert("analyze_ok".into(), json!(false));
                        out.insert("analyze_err".into(), json!(e.chars().take(200).collect::<String>()));
                    }
                }
            } else {
                out.insert("analyze_ok".into(), json!(false));
                out.insert("analyze_err".into(), json!("store 里读不到 settings"));
            }
        }
    }

    let all_ok = out.get("file_info_ok").and_then(|v| v.as_bool()).unwrap_or(false)
        && out.get("list_images_ok").and_then(|v| v.as_bool()).unwrap_or(false)
        && out.get("write_processed_ok").and_then(|v| v.as_bool()).unwrap_or(false)
        && out.get("thumb_gen_ok").and_then(|v| v.as_bool()).unwrap_or(false)
        && out.get("thumb_cache_hit").and_then(|v| v.as_bool()).unwrap_or(false);
    out.insert("ok".into(), json!(all_ok));
    Value::Object(out)
}

/// 启动参数里的图片路径（文件关联双击打开）。
/// 【2026-10-04】之前 set_file_assoc 关联了 exe，但 main() 从不读参数 ——
/// 双击图片等于白关联（窗口照常开，图片不加载）。现在补上。
static LAUNCH_PATH: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

#[tauri::command]
fn get_launch_path() -> Option<String> {
    LAUNCH_PATH.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

fn main() {
    // 诊断用：windows_subsystem=windows 下 panic 不可见，落到文件里才能排查
    // 【2026-10-03】日志路径改为 exe 同目录，不再写死 build（安装版用户没有那个目录）
    let log_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let run_log = log_dir.join("aiiv-run.log");
    let panic_log = log_dir.join("aiiv-panic.log");
    let dlog = move |s: &str| {
        eprintln!("[aiiv] {}", s);
        let _ = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&run_log)
            .map(|mut f| std::io::Write::write_all(&mut f, format!("[aiiv] {}\n", s).as_bytes()));
    };
    dlog("main 进入");
    std::panic::set_hook(Box::new(move |info| {
        let _ = std::fs::write(&panic_log, format!("PANIC: {}\n", info));
    }));
    dlog("panic hook 已装");
    // 【GPU 兼容模式 = 默认开启】
    // 2026-10-04 截图实锤：本机 WebView2（当日自动更新的 154.0.4258.53）GPU 进程
    // 初始化 FATAL（Crashpad: "GPU process isn't usable"），WebView 整体黑屏，
    // 界面上所有按钮/识别都不存在 —— 用户视角就是「全部功能不可用」。
    // 默认追加 --disable-gpu 用软件渲染换取可用性；确实需要硬件加速的用户
    // 设 AIIV_ENABLE_GPU=1 可回到 GPU 路径。
    let enable_gpu = std::env::var("AIIV_ENABLE_GPU").as_deref() == Ok("1");
    if !enable_gpu {
        let extra = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS")
            .unwrap_or_default();
        let merged = if extra.is_empty() {
            "--in-process-gpu".to_string()
        } else {
            format!("{} --in-process-gpu", extra)
        };
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", merged);
        dlog("GPU 兼容模式（默认）：已追加 --in-process-gpu（GPU 并入浏览器进程，绕开 GPU 进程启动崩溃）");
    } else {
        dlog("AIIV_ENABLE_GPU=1：保持硬件加速");
    }
    dlog(&format!(
        "env WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = {:?}",
        std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").as_deref().unwrap_or("")
    ));
    // 捕获启动参数：文件关联双击图片时 Windows 会把路径作为 argv[1] 传进来
    {
        let p = std::env::args().nth(1);
        if let Some(p) = p {
            if std::path::Path::new(&p).exists() {
                dlog(&format!("启动参数图片: {}", p));
                *LAUNCH_PATH.lock().unwrap_or_else(|e| e.into_inner()) = Some(p);
            } else {
                dlog(&format!("启动参数忽略（文件不存在）: {}", p));
            }
        }
    }
    // 无头自检通道：设了 AIIV_SELFTEST_OUT 就跑一组真实命令、落结果、退出。
    // 这是「E2E 验证先于重构」共识的落地 —— 不依赖 CDP / WebView / 任何 UI。
    if let Ok(out_path) = std::env::var("AIIV_SELFTEST_OUT") {
        let img = std::env::var("AIIV_SELFTEST_IMG").unwrap_or_default();
        let result = run_selftest(&img);
        let _ = std::fs::write(
            &out_path,
            serde_json::to_string_pretty(&result).unwrap_or_else(|_| "{}".into()),
        );
        std::process::exit(0);
    }
    // 上次登记的缓存清理：必须在 WebView2 创建之前删，否则文件全被锁
    {
        let base = std::env::var("LOCALAPPDATA").unwrap_or_default();
        if !base.is_empty() {
            let dir = std::path::Path::new(&base).join("com.aiimageviewer.app");
            let flag = dir.join("cache-clear.flag");
            if flag.exists() {
                let webview = dir.join("EBWebView");
                let mut n = 0usize;
                for f in walk_files(&webview) {
                    if std::fs::remove_file(&f).is_ok() {
                        n += 1;
                    }
                }
                // 删掉残留空目录
                let mut dirs: Vec<std::path::PathBuf> = walk_dirs(&webview);
                dirs.sort_by_key(|p| std::cmp::Reverse(p.components().count()));
                for d in dirs {
                    let _ = std::fs::remove_dir(&d);
                }
                let _ = std::fs::remove_file(&flag);
                dlog(&format!("缓存清理完成（删除 {} 个文件）", n));
            }
        }
    }
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_store::Builder::new().build())
        // 应用退出时把自动拉起的 IOPaint 一并关掉 —— 服务不残留。
        // 例外：设置里开了「IOPaint 常驻」则放行（用户显式要求后台常驻）。
        // （新版 tauri 2.x 的回调签名是 (window, event) 两个参数）
        //
        // 【为什么两个事件都处理】
        // 只挂 Destroyed 的话，进程被系统回收 / 应用崩溃时不会触发，
        // IOPaint 就会残留。CloseRequested（点关闭按钮）先于 Destroyed 触发，
        // 在这里先杀一次，Destroyed 再兜一次 —— 双保险，成本极低。
        .on_window_event(|_window, event| {
            let should_stop = matches!(
                event,
                tauri::WindowEvent::Destroyed | tauri::WindowEvent::CloseRequested { .. }
            );
            if should_stop {
                // 「IOPaint 常驻」开着则放行：用户显式要求服务后台存活
                use tauri::Manager;
                let app = _window.app_handle();
                let keep_running = app
                    .store(STORE_FILE)
                    .ok()
                    .and_then(|s| s.get(SETTINGS_KEY))
                    .and_then(|v| v.get("iopaint_keep_running").and_then(|b| b.as_bool()))
                    .unwrap_or(false);
                if keep_running {
                    return;
                }
                kill_iopaint_tree();
            }
        })
        .invoke_handler(tauri::generate_handler![
            default_settings,
            load_settings,
            save_settings,
            open_image,
            open_folder,
            list_images,
            analyze_path,
            analyze_image,
            chat_image_path,
            chat_image,
            trash_image,
            edit_image,
            save_image,
            write_processed,
            settings_path,
            generate_image,
            probe_image_models,
            iopaint_inpaint,
            iopaint_ensure_server,
            fetch_models,
            save_text,
            file_info,
            grant_dir,
            general_state,
            set_file_assoc,
            set_autostart,
            request_clear_cache,
            iopaint_probe,
            thumbnail_data,
            save_drop,
            get_launch_path,
            write_debug_png,
            write_temp_image,
            iopaint_auto_setup,
            iopaint_setup_status
        ]);
    dlog("builder 组装完成，准备 run");
    builder
        .setup(move |_app| {
            // setup 在窗口创建之后调用：走到这里 = Win32 窗口已建、
            // WebView2 环境初始化已发起。若 run.log 停在「准备 run」
            // 且没有本行，说明卡在窗口/WebView2 创建环节（环境级问题，
            // 2026-10-03 实测为 WebView2 GPU FATAL 所致）。
            dlog("setup：窗口已创建");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
