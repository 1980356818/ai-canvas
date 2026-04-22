use crate::AppState;
use super::config::read_api_config;
use base64::Engine as _;
use serde::Serialize;
use std::error::Error as StdError;
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

    let resp = match request.send().await {
        Ok(r) => r,
        Err(e) => {
            let is_connect = e.is_connect();
            let is_timeout = e.is_timeout();
            let is_request = e.is_request();
            let source = StdError::source(&e).map(|s| s.to_string()).unwrap_or_default();
            tracing::error!(
                "[ai_proxy] 请求发送失败: url={}, connect={}, timeout={}, request={}, source={}",
                url, is_connect, is_timeout, is_request, source
            );
            return Err(format!(
                "请求失败: {} (connect={}, timeout={}, detail={})",
                e, is_connect, is_timeout, source
            ));
        }
    };

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
    pub width: Option<u32>,
    pub height: Option<u32>,
}

fn detect_image_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 10 {
        return None;
    }

    // PNG
    if bytes.len() >= 24 && bytes[0..8] == [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] {
        let w = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
        let h = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
        return Some((w, h));
    }

    // GIF
    if bytes.len() >= 10 && (bytes[0..6] == *b"GIF87a" || bytes[0..6] == *b"GIF89a") {
        let w = u16::from_le_bytes([bytes[6], bytes[7]]) as u32;
        let h = u16::from_le_bytes([bytes[8], bytes[9]]) as u32;
        return Some((w, h));
    }

    // BMP
    if bytes.len() >= 26 && bytes[0..2] == *b"BM" {
        let w = u32::from_le_bytes([bytes[18], bytes[19], bytes[20], bytes[21]]);
        let h_signed = i32::from_le_bytes([bytes[22], bytes[23], bytes[24], bytes[25]]);
        return Some((w, h_signed.unsigned_abs()));
    }

    // JPEG — scan for SOF0..SOF3 markers
    if bytes[0..2] == [0xFF, 0xD8] {
        let mut i = 2;
        while i + 9 < bytes.len() {
            if bytes[i] != 0xFF {
                i += 1;
                continue;
            }
            let marker = bytes[i + 1];
            if marker == 0x00 || marker == 0xFF {
                i += 1;
                continue;
            }
            if (0xC0..=0xC3).contains(&marker) {
                let h = u16::from_be_bytes([bytes[i + 5], bytes[i + 6]]) as u32;
                let w = u16::from_be_bytes([bytes[i + 7], bytes[i + 8]]) as u32;
                return Some((w, h));
            }
            if i + 3 >= bytes.len() {
                break;
            }
            let seg_len = u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]) as usize;
            i += 2 + seg_len;
        }
    }

    // WebP
    if bytes.len() >= 30 && bytes[0..4] == *b"RIFF" && bytes[8..12] == *b"WEBP" {
        if bytes.len() >= 30 && bytes[12..16] == *b"VP8 " {
            let w = (u16::from_le_bytes([bytes[26], bytes[27]]) & 0x3FFF) as u32;
            let h = (u16::from_le_bytes([bytes[28], bytes[29]]) & 0x3FFF) as u32;
            return Some((w, h));
        }
        if bytes.len() >= 25 && bytes[12..16] == *b"VP8L" {
            let bits = u32::from_le_bytes([bytes[21], bytes[22], bytes[23], bytes[24]]);
            let w = (bits & 0x3FFF) + 1;
            let h = ((bits >> 14) & 0x3FFF) + 1;
            return Some((w, h));
        }
        if bytes.len() >= 30 && bytes[12..16] == *b"VP8X" {
            let w = (bytes[24] as u32) | ((bytes[25] as u32) << 8) | ((bytes[26] as u32) << 16);
            let h = (bytes[27] as u32) | ((bytes[28] as u32) << 8) | ((bytes[29] as u32) << 16);
            return Some((w + 1, h + 1));
        }
    }

    None
}

/// Save media from a remote URL, base64 data-URL, or local path into
/// `app_data_dir/media/images/{uuid}.{ext}`.  When `image_auto_save_path` is set,
/// a copy is also written to that user-chosen directory, organized by project subfolder.
/// Returns a **relative** path like `media/images/{uuid}.{ext}`.
#[tauri::command]
pub async fn save_media(
    app: AppHandle,
    state: State<'_, AppState>,
    source: String,
    filename: Option<String>,
    title: Option<String>,
    project_id: Option<String>,
) -> Result<SaveMediaResult, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let media_dir = app_data_dir.join("media/images");
    std::fs::create_dir_all(&media_dir)
        .map_err(|e| format!("创建媒体目录失败: {}", e))?;

    let mut ext = detect_extension(&source, &filename);
    let file_id = uuid::Uuid::new_v4().to_string();

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
        let max_retries = 3u32;
        let mut last_err = String::new();
        let mut downloaded = None;

        for attempt in 0..max_retries {
            if attempt > 0 {
                let delay = std::time::Duration::from_millis(500 * 2u64.pow(attempt - 1));
                tracing::info!("[save_media] 重试下载 #{}, 等待 {:?}", attempt + 1, delay);
                std::thread::sleep(delay);
            }

            match client
                .get(&source)
                .header("User-Agent", "AI-Canvas/1.0")
                .send()
                .await
            {
                Ok(resp) => {
                    if !resp.status().is_success() {
                        last_err = format!("HTTP {}", resp.status());
                        tracing::warn!("[save_media] 下载返回非成功状态: {}", last_err);
                        continue;
                    }
                    if let Some(ct_ext) = ext_from_content_type(resp.headers()) {
                        tracing::info!("[save_media] Content-Type 检测到扩展名: {}", ct_ext);
                        ext = ct_ext;
                    }
                    match resp.bytes().await {
                        Ok(b) => {
                            tracing::info!("[save_media] 下载成功, {} 字节", b.len());
                            downloaded = Some(b.to_vec());
                            break;
                        }
                        Err(e) => {
                            last_err = format!("读取响应体失败: {}", e);
                            tracing::warn!("[save_media] {}", last_err);
                        }
                    }
                }
                Err(e) => {
                    last_err = format!("{}", e);
                    tracing::warn!("[save_media] 下载请求失败 (attempt {}): {}", attempt + 1, last_err);
                }
            }
        }

        downloaded.ok_or_else(|| format!("下载失败 (重试{}次): {}", max_retries, last_err))?
    } else {
        std::fs::read(&source).map_err(|e| format!("读取文件失败: {}", e))?
    };

    let dest = media_dir.join(format!("{}.{}", file_id, ext));

    std::fs::write(&dest, &bytes).map_err(|e| format!("写入文件失败: {}", e))?;

    let (auto_save_dir, project_folder_name) = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let dir = db
            .query_row(
                "SELECT value FROM settings WHERE key = 'file_auto_save_path'",
                [],
                |row| row.get::<_, String>(0),
            )
            .ok()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| {
                db.query_row(
                    "SELECT value FROM settings WHERE key = 'image_auto_save_path'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .ok()
                .filter(|s| !s.trim().is_empty())
            });

        let folder = if let (Some(_), Some(pid)) = (&dir, &project_id) {
            db.query_row(
                "SELECT title FROM projects WHERE id = ?1",
                rusqlite::params![pid],
                |row| row.get::<_, String>(0),
            )
            .ok()
            .map(|t| build_project_folder_name(&t, pid))
        } else {
            None
        };

        (dir, folder)
    };

    if let Some(dir) = auto_save_dir {
        let target_dir = if let Some(ref folder) = project_folder_name {
            std::path::Path::new(&dir).join(folder)
        } else {
            std::path::PathBuf::from(&dir)
        };

        let friendly_name = build_friendly_filename(&title, &file_id, &ext);
        let user_dest = target_dir.join(&friendly_name);

        if let Err(e) = std::fs::create_dir_all(&target_dir) {
            tracing::warn!("创建自动保存目录失败: {}", e);
        } else if let Err(e) = std::fs::copy(&dest, &user_dest) {
            tracing::warn!("复制文件到自动保存目录失败: {}", e);
        } else {
            tracing::info!("文件已自动保存: {:?}", user_dest);
        }
    }

    let dims = detect_image_dimensions(&bytes);

    let relative_path = format!("media/images/{}.{}", file_id, ext);
    Ok(SaveMediaResult {
        local_path: relative_path,
        width: dims.map(|(w, _)| w),
        height: dims.map(|(_, h)| h),
    })
}

/// Return the absolute path of `app_data_dir` so the frontend can
/// construct asset-protocol URLs via `convertFileSrc()`.
#[tauri::command]
pub async fn get_media_base_path(app: AppHandle) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

/// Copy an image or video from internal storage to the user's file save directory.
/// Saves to `file_auto_save_path/{project_folder}/export_name`.
#[tauri::command]
pub async fn export_file(
    app: AppHandle,
    state: State<'_, AppState>,
    source_path: String,
    export_name: String,
    project_id: Option<String>,
) -> Result<String, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let abs_source = app_data_dir.join(&source_path);

    if !abs_source.exists() {
        return Err(format!("源文件不存在: {}", source_path));
    }

    let (base_dir, project_folder_name) = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let dir = db
            .query_row(
                "SELECT value FROM settings WHERE key = 'file_export_path'",
                [],
                |row| row.get::<_, String>(0),
            )
            .ok()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| {
                db.query_row(
                    "SELECT value FROM settings WHERE key = 'file_auto_save_path'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .ok()
                .filter(|s| !s.trim().is_empty())
            })
            .or_else(|| {
                db.query_row(
                    "SELECT value FROM settings WHERE key IN ('image_export_path', 'image_auto_save_path') ORDER BY key ASC LIMIT 1",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .ok()
                .filter(|s| !s.trim().is_empty())
            });

        let folder = if let (Some(_), Some(pid)) = (&dir, &project_id) {
            db.query_row(
                "SELECT title FROM projects WHERE id = ?1",
                rusqlite::params![pid],
                |row| row.get::<_, String>(0),
            )
            .ok()
            .map(|t| build_project_folder_name(&t, pid))
        } else {
            None
        };

        (dir, folder)
    };

    let dir = base_dir.ok_or("请先在设置中配置「手动保存路径」或「文件自动保存路径」")?;

    let target_dir = if let Some(ref folder) = project_folder_name {
        std::path::Path::new(&dir).join(folder)
    } else {
        std::path::PathBuf::from(&dir)
    };

    std::fs::create_dir_all(&target_dir)
        .map_err(|e| format!("创建导出目录失败: {}", e))?;

    let dest = target_dir.join(&export_name);
    std::fs::copy(&abs_source, &dest)
        .map_err(|e| format!("导出文件失败: {}", e))?;

    tracing::info!("文件已导出: {:?}", dest);
    Ok(dest.to_string_lossy().to_string())
}

/// Open the system file explorer and highlight the given file.
/// When an auto-save path is configured, opens the user's project folder
/// instead of the internal app_data_dir.
#[tauri::command]
pub async fn open_in_explorer(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    project_id: Option<String>,
) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;

    let abs_path = if path.starts_with("media/") {
        let user_path = resolve_user_media_path(&state, &app_data_dir, &path, &project_id);
        user_path.unwrap_or_else(|| app_data_dir.join(&path))
    } else {
        std::path::PathBuf::from(&path)
    };

    if !abs_path.exists() {
        return Err(format!("文件不存在: {}", abs_path.display()));
    }

    reveal_path(&abs_path)
}

fn resolve_user_media_path(
    state: &AppState,
    app_data_dir: &std::path::Path,
    internal_path: &str,
    project_id: &Option<String>,
) -> Option<std::path::PathBuf> {
    let db = state.db.lock().ok()?;

    let internal_abs = app_data_dir.join(internal_path);
    let internal_stem = internal_abs
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    if internal_stem.is_empty() {
        return None;
    }
    let short_id = &internal_stem[..8.min(internal_stem.len())];

    let short_pid = project_id
        .as_ref()
        .map(|pid| &pid[..8.min(pid.len())]);

    let project_folder = project_id.as_ref().and_then(|pid| {
        db.query_row(
            "SELECT title FROM projects WHERE id = ?1",
            rusqlite::params![pid],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .map(|t| build_project_folder_name(&t, pid))
    });

    let setting_keys = [
        "file_export_path",
        "image_export_path",
        "file_auto_save_path",
        "image_auto_save_path",
    ];

    let mut candidate_dirs: Vec<String> = Vec::new();
    for key in &setting_keys {
        if let Ok(val) = db.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            rusqlite::params![key],
            |row| row.get::<_, String>(0),
        ) {
            let val = val.trim().to_string();
            if !val.is_empty() && !candidate_dirs.contains(&val) {
                candidate_dirs.push(val);
            }
        }
    }

    for base_dir in &candidate_dirs {
        let base = std::path::Path::new(base_dir);
        if !base.is_dir() {
            continue;
        }

        let search_dir = if let Some(ref folder) = project_folder {
            let proj_dir = base.join(folder);
            if proj_dir.exists() {
                proj_dir
            } else if let Some(sid) = short_pid {
                find_dir_containing(base, sid).unwrap_or_else(|| base.to_path_buf())
            } else {
                base.to_path_buf()
            }
        } else {
            base.to_path_buf()
        };

        if let Some(found) = find_file_by_id(&search_dir, short_id) {
            return Some(found);
        }
    }

    None
}

fn find_dir_containing(parent: &std::path::Path, substr: &str) -> Option<std::path::PathBuf> {
    std::fs::read_dir(parent).ok()?.flatten().find(|e| {
        e.file_type().map(|ft| ft.is_dir()).unwrap_or(false)
            && e.file_name().to_string_lossy().contains(substr)
    }).map(|e| e.path())
}

fn find_file_by_id(dir: &std::path::Path, short_id: &str) -> Option<std::path::PathBuf> {
    if !dir.is_dir() {
        return None;
    }
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        if entry.file_name().to_string_lossy().contains(short_id) {
            return Some(entry.path());
        }
    }
    None
}

fn reveal_path(abs_path: &std::path::Path) -> Result<(), String> {
    let is_dir = abs_path.is_dir();

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let win_path = abs_path.to_string_lossy().replace('/', "\\");
        tracing::info!("open_in_explorer: {}", win_path);
        if is_dir {
            std::process::Command::new("explorer")
                .raw_arg(format!("\"{}\"", win_path))
                .spawn()
                .map_err(|e| format!("打开资源管理器失败: {}", e))?;
        } else {
            std::process::Command::new("explorer")
                .raw_arg(format!("/select,\"{}\"", win_path))
                .spawn()
                .map_err(|e| format!("打开资源管理器失败: {}", e))?;
        }
    }

    #[cfg(target_os = "macos")]
    {
        if is_dir {
            std::process::Command::new("open")
                .arg(&abs_path.to_string_lossy().as_ref())
                .spawn()
                .map_err(|e| format!("打开 Finder 失败: {}", e))?;
        } else {
            std::process::Command::new("open")
                .args(["-R", &abs_path.to_string_lossy()])
                .spawn()
                .map_err(|e| format!("打开 Finder 失败: {}", e))?;
        }
    }

    #[cfg(target_os = "linux")]
    {
        let target = if is_dir { abs_path } else { abs_path.parent().unwrap_or(abs_path) };
        std::process::Command::new("xdg-open")
            .arg(target)
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
        "heic" => "image/heic",
        "heif" => "image/heif",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "avi" => "video/x-msvideo",
        "mkv" => "video/x-matroska",
        "wav" => "audio/wav",
        "mp3" => "audio/mpeg",
        _ => "application/octet-stream",
    };

    let b64 = BASE64_ENGINE.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, b64))
}

// ── Helpers ─────────────────────────────────────────────────

/// Build a project subfolder name: `{sanitized_title}_{short_uuid}`.
/// The short UUID suffix guarantees uniqueness even when titles are identical.
fn build_project_folder_name(title: &str, project_id: &str) -> String {
    let safe_title = sanitize_filename(title);
    let short_id = &project_id[..8.min(project_id.len())];
    if safe_title.is_empty() {
        short_id.to_string()
    } else {
        format!("{}_{}", safe_title, short_id)
    }
}

pub fn build_project_folder_name_pub(title: &str, project_id: &str) -> String {
    build_project_folder_name(title, project_id)
}

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

fn ext_from_content_type(headers: &reqwest::header::HeaderMap) -> Option<String> {
    let ct = headers.get("content-type")?.to_str().ok()?;
    let mime = ct.split(';').next().unwrap_or(ct).trim();
    match mime {
        "video/mp4" => Some("mp4".into()),
        "video/webm" => Some("webm".into()),
        "video/quicktime" => Some("mov".into()),
        "image/png" => Some("png".into()),
        "image/jpeg" => Some("jpg".into()),
        "image/gif" => Some("gif".into()),
        "image/webp" => Some("webp".into()),
        "image/svg+xml" => Some("svg".into()),
        "image/heic" | "image/heic-sequence" => Some("heic".into()),
        "image/heif" | "image/heif-sequence" => Some("heif".into()),
        _ if mime.starts_with("video/") => Some("mp4".into()),
        _ => None,
    }
}

fn detect_extension(source: &str, filename: &Option<String>) -> String {
    if let Some(name) = filename {
        if let Some(ext) = name.rsplit('.').next() {
            return ext.to_lowercase();
        }
    }
    if source.starts_with("data:image/png") { return "png".into(); }
    if source.starts_with("data:image/jpeg") || source.starts_with("data:image/jpg") { return "jpg".into(); }
    if source.starts_with("data:image/gif") { return "gif".into(); }
    if source.starts_with("data:image/webp") { return "webp".into(); }
    if source.starts_with("data:image/heic") { return "heic".into(); }
    if source.starts_with("data:image/heif") { return "heif".into(); }
    if source.starts_with("data:video/mp4") { return "mp4".into(); }
    if source.starts_with("data:video/webm") { return "webm".into(); }
    if source.starts_with("data:video/quicktime") { return "mov".into(); }
    if let Some(path_part) = source.split('?').next() {
        if let Some(ext) = path_part.rsplit('.').next() {
            let ext = ext.to_lowercase();
            if matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "mp4" | "webm" | "mov") {
                return ext;
            }
        }
    }
    "png".into()
}
