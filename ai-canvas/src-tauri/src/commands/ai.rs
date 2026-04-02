use crate::AppState;
use super::config::read_api_config;
use base64::Engine as _;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

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
    let client = state.http_client.clone();
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
        .json(body);

    request = match provider {
        "anthropic" => request
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01"),
        _ => request.header("Authorization", format!("Bearer {}", api_key)),
    };

    let resp = request.send().await.map_err(|e| format!("请求失败: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
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
            Err(e) => return Err(format!("读取流失败: {}", e)),
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
/// `app_data_dir/media/images/{uuid}.{ext}`.  Returns the persisted path.
#[tauri::command]
pub async fn save_media(
    app: AppHandle,
    state: State<'_, AppState>,
    source: String,
    filename: Option<String>,
) -> Result<SaveMediaResult, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let media_dir = app_data_dir.join("media/images");

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

    Ok(SaveMediaResult {
        local_path: dest.to_string_lossy().to_string(),
    })
}

/// Read a local file and return its content as a base64 data-URL.
#[tauri::command]
pub async fn read_media_base64(path: String) -> Result<String, String> {
    let bytes =
        std::fs::read(&path).map_err(|e| format!("读取文件失败 '{}': {}", path, e))?;

    let mime = match path
        .rsplit('.')
        .next()
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
