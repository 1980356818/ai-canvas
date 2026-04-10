use crate::AppState;
use super::config::read_api_config;
use base64::Engine as _;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use chrono::Local;

const BASE64_ENGINE: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

#[derive(Serialize)]
pub struct AiProxyResponse {
    pub body: String,
    pub status: u16,
}

/// Generic HTTP proxy for AI API calls.
/// API keys live in the `settings` table — the frontend never sees them.
#[tauri::command]
pub async fn ai_proxy(
    state: State<'_, AppState>,
    provider: String,
    endpoint: String,
    body: serde_json::Value,
) -> Result<AiProxyResponse, String> {
    let config = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        read_api_config(&db, &provider)?
    };
    let (api_key, base_url) = (config.api_key, config.base_url);

    let url = format!("{}{}", base_url.trim_end_matches('/'), endpoint);
    let client = &state.http_client;

    let mut request = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&body);

    request = match provider.as_str() {
        "anthropic" => request
            .header("x-api-key", &api_key)
            .header("anthropic-version", "2023-06-01"),
        _ => request.header("Authorization", format!("Bearer {}", api_key)),
    };

    let resp = request
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    let status = resp.status().as_u16();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;

    Ok(AiProxyResponse { body, status })
}

// ── Streaming AI Proxy ──────────────────────────────────────

#[derive(Clone, Serialize)]
struct StreamEvent {
    stream_id: String,
    event: String,
    data: String,
}

#[tauri::command]
pub async fn ai_proxy_stream(
    app: AppHandle,
    state: State<'_, AppState>,
    provider: String,
    endpoint: String,
    body: serde_json::Value,
    stream_id: String,
) -> Result<(), String> {
    let config = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        read_api_config(&db, &provider)?
    };

    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut streams = state.active_streams.lock().map_err(|e| e.to_string())?;
        streams.insert(stream_id.clone(), cancelled.clone());
    }

    let url = format!("{}{}", config.base_url.trim_end_matches('/'), endpoint);
    let client = state.stream_client.clone();
    let sid = stream_id.clone();

    tauri::async_runtime::spawn(async move {
        let result = do_stream(&app, &client, &url, &config.api_key, &provider, &body, &sid, &cancelled).await;
        if let Err(e) = &result {
            let _ = app.emit("ai-stream", StreamEvent {
                stream_id: sid.clone(),
                event: "error".into(),
                data: e.clone(),
            });
        }

        let _ = app.emit("ai-stream", StreamEvent {
            stream_id: sid.clone(),
            event: "done".into(),
            data: String::new(),
        });

        if let Ok(mut streams) = app.state::<AppState>().active_streams.lock() {
            streams.remove(&sid);
        }
    });

    Ok(())
}

async fn do_stream(
    app: &AppHandle,
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
    provider: &str,
    body: &serde_json::Value,
    stream_id: &str,
    cancelled: &Arc<AtomicBool>,
) -> Result<(), String> {
    let mut request = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("Accept-Encoding", "identity")
        .json(body);

    request = match provider {
        "anthropic" => request
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01"),
        _ => request.header("Authorization", format!("Bearer {}", api_key)),
    };

    let resp = request.send().await.map_err(|e| format!("请求失败: {}", e))?;

    let status = resp.status().as_u16();
    let version = format!("{:?}", resp.version());
    let content_type = resp.headers().get("content-type").map(|v| v.to_str().unwrap_or("?").to_string()).unwrap_or_default();
    let content_encoding = resp.headers().get("content-encoding").map(|v| v.to_str().unwrap_or("?").to_string()).unwrap_or_default();
    let transfer_encoding = resp.headers().get("transfer-encoding").map(|v| v.to_str().unwrap_or("?").to_string()).unwrap_or_default();

    tracing::info!(
        "[stream] status={} version={} content-type={} content-encoding={} transfer-encoding={}",
        status, version, content_type, content_encoding, transfer_encoding
    );

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("API 错误 (HTTP {}): {}", status, body));
    }

    let mut buffer = String::new();

    let mut stream = resp;
    loop {
        if cancelled.load(Ordering::Relaxed) {
            return Ok(());
        }

        let chunk = match stream.chunk().await {
            Ok(Some(c)) => c,
            Ok(None) => break,
            Err(e) => {
                tracing::error!("[stream] chunk error: {} (status={} version={} ce={} te={})", e, status, version, content_encoding, transfer_encoding);
                return Err(format!("读取流失败: {}", e));
            }
        };

        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(newline_pos) = buffer.find('\n') {
            let line = buffer[..newline_pos].trim_end_matches('\r').to_string();
            buffer = buffer[newline_pos + 1..].to_string();

            if line.is_empty() || line.starts_with(':') {
                continue;
            }

            if let Some(data) = line.strip_prefix("data: ") {
                if data.trim() == "[DONE]" {
                    return Ok(());
                }
                let _ = app.emit("ai-stream", StreamEvent {
                    stream_id: stream_id.to_string(),
                    event: "chunk".into(),
                    data: data.to_string(),
                });
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn ai_proxy_stream_abort(
    state: State<'_, AppState>,
    stream_id: String,
) -> Result<(), String> {
    let streams = state.active_streams.lock().map_err(|e| e.to_string())?;
    if let Some(cancelled) = streams.get(&stream_id) {
        cancelled.store(true, Ordering::Relaxed);
    }
    Ok(())
}

// ── Media Operations ────────────────────────────────────────

#[derive(Serialize)]
pub struct SaveMediaResult {
    pub local_path: String,
}

/// Save media from a remote URL, base64 data-URL, or local path into
/// `app_data_dir/media/images/{uuid}.{ext}`.  When `image_auto_save_path` is set,
/// a copy is also written to that user-chosen directory.
/// Returns a **relative** path like `media/images/{uuid}.{ext}`.
#[tauri::command]
pub async fn save_media(
    app: AppHandle,
    state: State<'_, AppState>,
    source: String,
    filename: Option<String>,
    title: Option<String>,
) -> Result<SaveMediaResult, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let media_dir = app_data_dir.join("media/images");
    std::fs::create_dir_all(&media_dir)
        .map_err(|e| format!("创建媒体目录失败: {}", e))?;

    let ext = detect_extension(&source, &filename);
    let file_id = uuid::Uuid::new_v4().to_string();
    let dest = media_dir.join(format!("{}.{}", file_id, ext));

    let bytes = if source.starts_with("data:") {
        let b64 = source
            .splitn(2, ',')
            .nth(1)
            .ok_or("Invalid data-URL format")?;
        BASE64_ENGINE
            .decode(b64)
            .map_err(|e| format!("Base64 解码失败: {}", e))?
    } else if source.starts_with("http://") || source.starts_with("https://") {
        let client = &state.http_client;
        let resp = client
            .get(&source)
            .send()
            .await
            .map_err(|e| format!("下载失败: {}", e))?;
        if !resp.status().is_success() {
            return Err(format!("下载失败, HTTP {}", resp.status()));
        }
        resp.bytes()
            .await
            .map_err(|e| format!("读取数据失败: {}", e))?
            .to_vec()
    } else {
        std::fs::read(&source).map_err(|e| format!("读取文件失败: {}", e))?
    };

    std::fs::write(&dest, &bytes).map_err(|e| format!("写入文件失败: {}", e))?;

    let auto_save_dir = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.query_row(
            "SELECT value FROM settings WHERE key = 'image_auto_save_path'",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .filter(|s| !s.trim().is_empty())
    };

    if let Some(dir) = auto_save_dir {
        let friendly_name = build_friendly_filename(&title, &file_id, &ext);
        let user_dest = std::path::Path::new(&dir).join(&friendly_name);
        if let Err(e) = std::fs::create_dir_all(&dir) {
            tracing::warn!("创建自动保存目录失败: {}", e);
        } else if let Err(e) = std::fs::copy(&dest, &user_dest) {
            tracing::warn!("复制图片到自动保存目录失败: {}", e);
        } else {
            tracing::info!("图片已自动保存: {:?}", user_dest);
        }
    }

    let relative_path = format!("media/images/{}.{}", file_id, ext);
    Ok(SaveMediaResult {
        local_path: relative_path,
    })
}

/// Return the absolute path of `app_data_dir` so the frontend can
/// construct asset-protocol URLs via `convertFileSrc()`.
#[tauri::command]
pub async fn get_media_base_path(app: AppHandle) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

/// Copy an image from internal storage to the user's export directory.
/// If `image_export_path` is not configured, returns an error prompting the user to set it.
#[tauri::command]
pub async fn export_image(
    app: AppHandle,
    state: State<'_, AppState>,
    source_path: String,
    export_name: String,
) -> Result<String, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let abs_source = app_data_dir.join(&source_path);

    if !abs_source.exists() {
        return Err(format!("源文件不存在: {}", source_path));
    }

    let export_dir = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.query_row(
            "SELECT value FROM settings WHERE key = 'image_export_path'",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .filter(|s| !s.trim().is_empty())
    };

    let dir = export_dir.ok_or("请先在设置中配置「图片下载保存路径」")?;

    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("创建导出目录失败: {}", e))?;

    let dest = std::path::Path::new(&dir).join(&export_name);
    std::fs::copy(&abs_source, &dest)
        .map_err(|e| format!("导出图片失败: {}", e))?;

    tracing::info!("图片已导出: {:?}", dest);
    Ok(dest.to_string_lossy().to_string())
}

/// Open the system file explorer and highlight the given file.
#[tauri::command]
pub async fn open_in_explorer(app: AppHandle, path: String) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let abs_path = if path.starts_with("media/") {
        app_data_dir.join(&path)
    } else {
        std::path::PathBuf::from(&path)
    };

    if !abs_path.exists() {
        return Err(format!("文件不存在: {}", abs_path.display()));
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .args(["/select,", &abs_path.to_string_lossy()])
            .spawn()
            .map_err(|e| format!("打开资源管理器失败: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &abs_path.to_string_lossy()])
            .spawn()
            .map_err(|e| format!("打开 Finder 失败: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        let parent = abs_path.parent().unwrap_or(&abs_path);
        std::process::Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|e| format!("打开文件管理器失败: {}", e))?;
    }

    Ok(())
}

/// Read a local file and return its content as a base64 data-URL.
/// Accepts both relative paths (e.g. `media/images/uuid.png`) which are
/// resolved against `app_data_dir`, and absolute paths.
#[tauri::command]
pub async fn read_media_base64(app: AppHandle, path: String) -> Result<String, String> {
    let abs_path = if path.starts_with("media/") {
        let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        app_data_dir.join(&path)
    } else {
        std::path::PathBuf::from(&path)
    };

    let bytes =
        std::fs::read(&abs_path).map_err(|e| format!("读取文件失败 '{}': {}", abs_path.display(), e))?;

    let mime = match abs_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    };

    let b64 = BASE64_ENGINE.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, b64))
}

// ── Helpers ─────────────────────────────────────────────────

fn build_friendly_filename(title: &Option<String>, fallback_id: &str, ext: &str) -> String {
    let timestamp = Local::now().format("%Y%m%d_%H%M%S");
    let base = title
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(|s| sanitize_filename(s))
        .unwrap_or_else(|| fallback_id[..8.min(fallback_id.len())].to_string());
    format!("{}_{}.{}", base, timestamp, ext)
}

fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == ' ' || c > '\x7f' { c } else { '_' })
        .collect::<String>()
        .trim()
        .to_string()
}

fn detect_extension(source: &str, filename: &Option<String>) -> String {
    if let Some(name) = filename {
        if let Some(ext) = name.rsplit('.').next() {
            return ext.to_lowercase();
        }
    }
    if source.starts_with("data:image/png") {
        return "png".into();
    }
    if source.starts_with("data:image/jpeg") || source.starts_with("data:image/jpg") {
        return "jpg".into();
    }
    if source.starts_with("data:image/gif") {
        return "gif".into();
    }
    if source.starts_with("data:image/webp") {
        return "webp".into();
    }
    if let Some(path_part) = source.split('?').next() {
        if let Some(ext) = path_part.rsplit('.').next() {
            let ext = ext.to_lowercase();
            if matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg") {
                return ext;
            }
        }
    }
    "png".into()
}
