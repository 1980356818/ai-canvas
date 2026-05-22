use crate::AppState;
use super::config::{provider_display_name, read_full_api_config, set_active_key, is_retryable_status, apply_auth_headers, resolve_key_tag, filter_keys_by_tag};
use super::http_util::{root_cause_chain, send_with_retry};
use super::ipc_limits::{
    IPC_RESPONSE_BODY_HARD_LIMIT_BYTES,
    IPC_STREAM_CHUNK_HARD_LIMIT_BYTES,
    STREAM_LINE_BUFFER_HARD_LIMIT_BYTES,
};
use base64::Engine as _;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager, State};
use chrono::Local;

const BASE64_ENGINE: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// 把同步阻塞闭包（典型 std::fs / rusqlite / base64 decode 等）扔到
/// tokio 的 blocking thread pool 上跑，避免占住主 runtime worker。
/// 所有 `async fn` 内调到 std::fs::* / std::fs::read_dir / std::process::Command
/// 等的位置都应该走这里，规范统一。
async fn run_blocking<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("blocking task join failed: {}", e))?
}

#[derive(Default)]
struct InlineLocalStats {
    files: usize,
    total_bytes: usize,
}

/// `inline_local_files` 的 async 包装：把整棵 JSON 树 move 到 blocking pool
/// 跑文件读取 + base64 编码，避免在 tokio worker 上同步 std::fs::read 大文件。
async fn inline_local_files_async(
    mut body: serde_json::Value,
    data_dir: std::path::PathBuf,
) -> Result<(serde_json::Value, InlineLocalStats), String> {
    run_blocking(move || {
        let mut stats = InlineLocalStats::default();
        inline_local_files(&mut body, &data_dir, &mut stats)?;
        Ok((body, stats))
    })
    .await
}

fn debug_request_id(body: &serde_json::Value) -> Option<String> {
    body.get("_debug_request_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

fn scrub_debug_fields(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(obj) => {
            obj.remove("_debug_request_id");
            for (_, v) in obj.iter_mut() {
                scrub_debug_fields(v);
            }
        }
        serde_json::Value::Array(arr) => {
            for item in arr.iter_mut() {
                scrub_debug_fields(item);
            }
        }
        _ => {}
    }
}

fn approx_json_bytes(value: &serde_json::Value) -> usize {
    match value {
        serde_json::Value::Null => 4,
        serde_json::Value::Bool(v) => v.to_string().len(),
        serde_json::Value::Number(v) => v.to_string().len(),
        serde_json::Value::String(v) => v.len() + 2,
        serde_json::Value::Array(arr) => {
            2 + arr.len().saturating_sub(1) + arr.iter().map(approx_json_bytes).sum::<usize>()
        }
        serde_json::Value::Object(obj) => {
            2 + obj.len().saturating_sub(1)
                + obj.iter().map(|(k, v)| k.len() + 3 + approx_json_bytes(v)).sum::<usize>()
        }
    }
}

// ── local:// inlining ───────────────────────────────────────
//
// Frontend sends image/audio/video references as `local://media/...` strings
// inside the JSON body to avoid shipping multi-megabyte base64 payloads
// across Tauri IPC (the IPC channel becomes unreliable above ~10MB on
// Windows/WebView2). Right before the HTTP request leaves the host, we walk
// the JSON tree and rewrite each `local://...` placeholder into a real
// `data:<mime>;base64,...` URL that the upstream AI service can consume
// unchanged.

/// Recursively rewrite every string value of the form `local://<relpath>` to
/// a base64 data URL by reading the file from `data_dir`.
fn inline_local_files(
    value: &mut serde_json::Value,
    data_dir: &Path,
    stats: &mut InlineLocalStats,
) -> Result<(), String> {
    match value {
        serde_json::Value::String(s) => {
            if let Some(rel) = s.strip_prefix("local://") {
                let abs = resolve_local_path(rel, data_dir)?;
                let bytes = std::fs::read(&abs)
                    .map_err(|e| format!("读取本地文件失败 '{}': {}", rel, e))?;
                let mime = mime_from_path(&abs);
                let b64 = BASE64_ENGINE.encode(&bytes);
                stats.files += 1;
                stats.total_bytes += bytes.len();
                tracing::debug!(
                    "[ai_proxy] inlined local file '{}' ({} bytes, mime={})",
                    rel, bytes.len(), mime
                );
                *s = format!("data:{};base64,{}", mime, b64);
            }
        }
        serde_json::Value::Array(arr) => {
            for item in arr.iter_mut() {
                inline_local_files(item, data_dir, stats)?;
            }
        }
        serde_json::Value::Object(obj) => {
            for (_k, v) in obj.iter_mut() {
                inline_local_files(v, data_dir, stats)?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// Validate and resolve a `local://` relative path against the app data dir.
///
/// Restrictions:
/// - Must start with `media/` (only the media subtree is exposed)
/// - No `..` traversal, no empty segments
/// - No drive letters / leading slashes (no absolute path injection)
/// - File must exist
/// - After `canonicalize()`, the resolved path must still live inside data_dir
fn resolve_local_path(rel: &str, data_dir: &Path) -> Result<PathBuf, String> {
    if !rel.starts_with("media/") {
        return Err(format!("local:// 路径必须以 media/ 开头: {}", rel));
    }
    if rel.contains(':') || rel.starts_with('/') || rel.starts_with('\\') {
        return Err(format!("local:// 路径不能是绝对路径: {}", rel));
    }
    for seg in rel.split('/') {
        if seg.is_empty() || seg == ".." {
            return Err(format!("local:// 路径包含非法段: {}", rel));
        }
    }

    // `Path::join` accepts forward slashes on every platform we ship
    // (Windows API understands '/' as a separator).
    let candidate = data_dir.join(rel);
    if !candidate.is_file() {
        return Err(format!("local:// 文件不存在: {}", rel));
    }

    let canonical = candidate
        .canonicalize()
        .map_err(|e| format!("路径解析失败 '{}': {}", rel, e))?;
    let dir_canonical = data_dir
        .canonicalize()
        .map_err(|e| format!("data_dir 解析失败: {}", e))?;
    if !canonical.starts_with(&dir_canonical) {
        return Err(format!("local:// 路径越权: {}", rel));
    }
    Ok(canonical)
}

fn mime_from_path(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
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
        "m4a" => "audio/mp4",
        "ogg" => "audio/ogg",
        "flac" => "audio/flac",
        _ => "application/octet-stream",
    }
}

fn build_auth_request(
    client: &reqwest::Client,
    url: &str,
    provider: &str,
    api_key: &str,
    body: &serde_json::Value,
) -> reqwest::RequestBuilder {
    let request = client
        .post(url)
        .header("Content-Type", "application/json")
        .json(body);
    apply_auth_headers(request, provider, api_key)
}

/// 单个 String value 在 dump 里超过这个长度就截断为 `"<truncated NNN bytes>"`。
/// base64 内联图通常几 MB 起，原样保存只会塞满磁盘而且诊断价值低（知道有图就够了）。
const DUMP_MAX_STRING_LEN: usize = 256;

/// dump 目录下最多保留这么多个最近文件，更早的自动清理，防止长期累积。
const DUMP_KEEP_RECENT: usize = 20;

// IPC 体积常量统一放在 `super::ipc_limits`，见该文件头部说明。
// 历史踩坑：曾用 SOFT(4MB)/HARD(8MB) 两层，SOFT 区间只 warn 不落盘
// 正好踩在 WebView2 3-4MB 雷区 → 渲染端随机崩溃半年。
// 现在统一只有一个 HARD 上限，超过必落盘。

/// 把超大 response body 落盘到 debug/oversize_response/ 并返回相对路径占位。
/// 失败时只 warn-log，不 propagate（出错也得让原请求收尾）。
fn spill_oversize_response(
    data_dir: &Path,
    tag: &str,
    request_id: &str,
    status: u16,
    body: &str,
) -> Option<PathBuf> {
    let dir = data_dir.join("debug").join("oversize_response");
    if std::fs::create_dir_all(&dir).is_err() {
        return None;
    }
    let ts = Local::now().format("%Y%m%d_%H%M%S_%3f");
    let path = dir.join(format!("{}_{}_{}.{}.body", tag, request_id, ts, status));
    match std::fs::write(&path, body) {
        Ok(_) => Some(path),
        Err(e) => {
            tracing::warn!("[oversize_response] write failed {:?}: {}", path, e);
            None
        }
    }
}

/// 递归把 outgoing JSON 里的「特长字符串」替换成长度摘要，再写盘。
/// 保持结构和短字段原样，便于人类对比 outgoing 跟 DTO 期望的字段是否对得上。
fn truncate_long_strings(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::String(s) if s.len() > DUMP_MAX_STRING_LEN => {
            serde_json::Value::String(format!(
                "<truncated {} bytes, head={:?}>",
                s.len(),
                &s[..DUMP_MAX_STRING_LEN.min(s.len())]
            ))
        }
        serde_json::Value::Array(arr) => {
            serde_json::Value::Array(arr.iter().map(truncate_long_strings).collect())
        }
        serde_json::Value::Object(obj) => {
            let mut out = serde_json::Map::with_capacity(obj.len());
            for (k, v) in obj {
                out.insert(k.clone(), truncate_long_strings(v));
            }
            serde_json::Value::Object(out)
        }
        other => other.clone(),
    }
}

/// 保留 dump_dir 里最近的 DUMP_KEEP_RECENT 个 `*_fail_*.json` 文件，其余删除。
fn prune_old_dumps(dump_dir: &Path) {
    let read = match std::fs::read_dir(dump_dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = read
        .filter_map(Result::ok)
        .filter_map(|e| {
            let name = e.file_name();
            let s = name.to_string_lossy();
            if !s.contains("_fail_") || !s.ends_with(".json") {
                return None;
            }
            let mtime = e.metadata().and_then(|m| m.modified()).ok()?;
            Some((mtime, e.path()))
        })
        .collect();
    if files.len() <= DUMP_KEEP_RECENT {
        return;
    }
    files.sort_by(|a, b| b.0.cmp(&a.0)); // 新→旧
    for (_, path) in files.into_iter().skip(DUMP_KEEP_RECENT) {
        let _ = std::fs::remove_file(path);
    }
}

/// 把失败请求 (status >= 400) 的 outgoing body + upstream response 一起落地到
/// `<data_dir>/debug/`，方便诊断网关层屏蔽掉的 deserialization 错误
/// （典型例子：极境 10002 "请求体格式错误" 只透出笼统 message，要靠对比
/// outgoing body 才能定位是哪个字段触发 Jackson 失败）。
///
/// 写盘前的两个安全阀：
/// - {@link truncate_long_strings} 把 base64 图等超长字段截断
/// - {@link prune_old_dumps} 保留最近若干个文件，避免无人清理时磁盘塞满
fn dump_failed_request(
    data_dir: &Path,
    tag: &str,
    url: &str,
    provider: &str,
    status: u16,
    outgoing: &serde_json::Value,
    response_body: &str,
) {
    let dump_dir = data_dir.join("debug");
    if std::fs::create_dir_all(&dump_dir).is_err() {
        return;
    }
    let ts = Local::now().format("%Y%m%d_%H%M%S_%3f");
    let out_path = dump_dir.join(format!("{}_fail_{}_{}.json", tag, ts, status));
    let outgoing_truncated = truncate_long_strings(outgoing);
    let resp_for_dump = if response_body.len() > DUMP_MAX_STRING_LEN * 16 {
        format!(
            "<truncated {} bytes, head={:?}>",
            response_body.len(),
            &response_body[..(DUMP_MAX_STRING_LEN * 16).min(response_body.len())]
        )
    } else {
        response_body.to_string()
    };
    let dump = serde_json::json!({
        "url": url,
        "status": status,
        "provider": provider,
        "outgoing_body_bytes": approx_json_bytes(outgoing),
        "response_body_bytes": response_body.len(),
        "outgoing_body": outgoing_truncated,
        "response_body": resp_for_dump,
    });
    if let Ok(s) = serde_json::to_string_pretty(&dump) {
        if std::fs::write(&out_path, s).is_ok() {
            tracing::warn!(
                "[{}] dumped failed request → {} (status={}, outgoing≈{} bytes, response≈{} bytes)",
                tag, out_path.display(), status, approx_json_bytes(outgoing), response_body.len()
            );
            prune_old_dumps(&dump_dir);
        }
    }
}

#[derive(Serialize)]
pub struct AiProxyResponse {
    pub body: String,
    pub status: u16,
    pub rotated_key_name: Option<String>,
    pub tried_count: u32,
}

/// Generic HTTP proxy for AI API calls with automatic key rotation.
#[tauri::command]
pub async fn ai_proxy(
    state: State<'_, AppState>,
    provider: String,
    endpoint: String,
    mut body: serde_json::Value,
) -> Result<AiProxyResponse, String> {
    let request_id = debug_request_id(&body).unwrap_or_else(|| "-".to_string());
    let total_start = Instant::now();
    let original_body_bytes = approx_json_bytes(&body);
    tracing::info!(
        "[ai_proxy:{}] start provider={}, endpoint={}, incoming_body≈{} bytes",
        request_id,
        provider,
        endpoint,
        original_body_bytes
    );

    scrub_debug_fields(&mut body);

    let inline_start = Instant::now();
    let (body, inline_stats) =
        inline_local_files_async(body, state.data_dir.clone()).await?;
    tracing::info!(
        "[ai_proxy:{}] local inline finished: files={}, source_bytes={}, elapsed_ms={}, outgoing_body≈{} bytes",
        request_id,
        inline_stats.files,
        inline_stats.total_bytes,
        inline_start.elapsed().as_millis(),
        approx_json_bytes(&body)
    );

    let full_config = {
        let db_start = Instant::now();
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let config = read_full_api_config(&db, &provider)?;
        tracing::debug!(
            "[ai_proxy:{}] read_full_api_config elapsed_ms={}",
            request_id,
            db_start.elapsed().as_millis()
        );
        config
    };

    if full_config.keys.is_empty() {
        return Err(format!(
            "Provider '{}' 的 API Key 未配置，请在设置中填写",
            provider_display_name(&provider)
        ));
    }

    if full_config.base_url.is_empty() {
        return Err(format!(
            "Provider '{}' 的 API 地址未配置，请在设置中填写 Base URL",
            provider_display_name(&provider)
        ));
    }

    // Comfly: 按 body.model 派生 key 槽位，只用匹配 tag 的 key（按用户设置的优先级顺序）
    let key_tag = resolve_key_tag(&provider, &body);
    let filtered_keys = filter_keys_by_tag(full_config.keys.clone(), key_tag.as_deref());
    if filtered_keys.is_empty() {
        let tag_label = key_tag.as_deref().map(|t| match t {
            "gemini_premium" => "Gemini 优质",
            _ => "普通默认",
        }).unwrap_or("");
        return Err(format!(
            "Provider '{}' 的「{}」槽位未配置 API Key，请在设置中填写",
            provider_display_name(&provider), tag_label
        ));
    }
    tracing::info!(
        "[ai_proxy:{}] key_tag={:?}, candidate_keys={}",
        request_id, key_tag, filtered_keys.len()
    );

    let url = format!("{}{}", full_config.base_url.trim_end_matches('/'), endpoint);
    let client = state.http_client();
    let keys = &filtered_keys;
    let can_rotate = full_config.auto_rotate && keys.len() > 1;

    let mut last_body = String::new();
    let mut last_status: u16 = 0;

    for (i, key_entry) in keys.iter().enumerate() {
        let key_preview = if key_entry.key.len() > 8 {
            format!("{}…{}", &key_entry.key[..4], &key_entry.key[key_entry.key.len()-4..])
        } else {
            "****".to_string()
        };
        tracing::info!(
            "[key_rotation] provider={}, trying key \"{}\" ({}) ({}/{})",
            provider, key_entry.name, key_preview, i + 1, keys.len()
        );

        let send_start = Instant::now();
        tracing::info!(
            "[ai_proxy:{}] upstream request sending: url={}, key_index={}/{}",
            request_id, url, i + 1, keys.len()
        );
        let log_tag = format!("ai_proxy:{}", request_id);
        let resp = send_with_retry(
            || build_auth_request(client, &url, &provider, &key_entry.key, &body),
            &log_tag,
            &url,
        )
        .await
        .inspect_err(|e| {
            tracing::error!(
                "[ai_proxy:{}] 请求发送失败: url={}, elapsed_ms={}, {}",
                request_id, url, send_start.elapsed().as_millis(), e
            );
        })?;
        tracing::info!(
            "[ai_proxy:{}] upstream headers received: status={}, elapsed_ms={}",
            request_id, resp.status().as_u16(), send_start.elapsed().as_millis()
        );

        let status = resp.status().as_u16();
        let text_start = Instant::now();
        let resp_body = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
        tracing::info!(
            "[ai_proxy:{}] upstream body read: status={}, body_bytes={}, read_elapsed_ms={}, request_elapsed_ms={}, total_elapsed_ms={}",
            request_id,
            status,
            resp_body.len(),
            text_start.elapsed().as_millis(),
            send_start.elapsed().as_millis(),
            total_start.elapsed().as_millis()
        );

        // ── IPC payload 守门 ──
        // 单一 HARD 上限，超过必落盘到 debug/oversize_response/，前端只收到
        // 简短 error 占位。绝对不允许 >IPC_RESPONSE_BODY_HARD_LIMIT_BYTES 的
        // 字符串通过 invoke 回传，会被 WebView2 杀掉渲染进程。
        let resp_body = if resp_body.len() > IPC_RESPONSE_BODY_HARD_LIMIT_BYTES {
            let original_len = resp_body.len();
            let data_dir = state.data_dir.clone();
            let req_id = request_id.clone();
            let body_for_spill = resp_body;
            // 落盘走 spawn_blocking：写一个 3MB+ 文件最坏几百毫秒，不能阻塞 runtime。
            let spilled = run_blocking(move || {
                Ok(spill_oversize_response(
                    &data_dir, "ai_proxy", &req_id, status, &body_for_spill,
                ))
            })
            .await
            .ok()
            .flatten();
            tracing::error!(
                "[ai_proxy:{}] OVERSIZED response body {} bytes (>{}) — spilled to {:?}, replacing with stub to protect IPC",
                request_id, original_len, IPC_RESPONSE_BODY_HARD_LIMIT_BYTES, spilled
            );
            let spilled_str = spilled.as_ref().map(|p| p.display().to_string()).unwrap_or_else(|| "<spill failed>".into());
            serde_json::json!({
                "error": {
                    "code": "response_too_large",
                    "message": format!(
                        "上游响应过大 ({} bytes，> {} MB 上限)，已落盘到 {}，请联系开发者诊断",
                        original_len,
                        IPC_RESPONSE_BODY_HARD_LIMIT_BYTES / (1024 * 1024),
                        spilled_str
                    ),
                    "spilled_path": spilled_str,
                }
            }).to_string()
        } else {
            resp_body
        };

        if status < 400 || !can_rotate || !is_retryable_status(status) {
            let rotated = if i > 0 {
                if let Ok(db) = state.db.lock() {
                    let _ = set_active_key(&db, &provider, &key_entry.id, &key_entry.key);
                }
                tracing::info!(
                    "[key_rotation] provider={}, active key changed to \"{}\"",
                    provider, key_entry.name
                );
                Some(key_entry.name.clone())
            } else {
                None
            };
            if status >= 400 {
                let data_dir = state.data_dir.clone();
                let url_clone = url.clone();
                let provider_clone = provider.clone();
                let body_clone = body.clone();
                let resp_body_clone = resp_body.clone();
                // dump 落盘可能写几 MB JSON：放进 spawn_blocking 避免阻塞 runtime
                let _ = run_blocking(move || {
                    dump_failed_request(
                        &data_dir, "ai_proxy", &url_clone, &provider_clone, status,
                        &body_clone, &resp_body_clone,
                    );
                    Ok(())
                })
                .await;
            }
            tracing::info!(
                "[ai_proxy:{}] finished total_elapsed_ms={}",
                request_id,
                total_start.elapsed().as_millis()
            );
            return Ok(AiProxyResponse {
                body: resp_body,
                status,
                rotated_key_name: rotated,
                tried_count: (i + 1) as u32,
            });
        }

        tracing::warn!(
            "[key_rotation] provider={}, key \"{}\" failed: HTTP {} — rotating",
            provider, key_entry.name, status
        );
        last_body = resp_body;
        last_status = status;
    }

    tracing::info!(
        "[ai_proxy:{}] finished after rotating all keys total_elapsed_ms={}",
        request_id,
        total_start.elapsed().as_millis()
    );
    Ok(AiProxyResponse {
        body: last_body,
        status: last_status,
        rotated_key_name: None,
        tried_count: keys.len() as u32,
    })
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
    mut body: serde_json::Value,
    stream_id: String,
) -> Result<(), String> {
    let request_id = debug_request_id(&body).unwrap_or_else(|| stream_id.chars().take(8).collect());
    scrub_debug_fields(&mut body);
    let (body, inline_stats) =
        inline_local_files_async(body, state.data_dir.clone()).await?;
    tracing::info!(
        "[ai_proxy_stream:{}] local inline finished: files={}, source_bytes={}, outgoing_body≈{} bytes",
        request_id,
        inline_stats.files,
        inline_stats.total_bytes,
        approx_json_bytes(&body)
    );

    let full_config = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        read_full_api_config(&db, &provider)?
    };

    if full_config.base_url.is_empty() {
        return Err(format!(
            "Provider '{}' 的 API 地址未配置，请在设置中填写 Base URL",
            provider_display_name(&provider)
        ));
    }

    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut streams = state.active_streams.lock().map_err(|e| e.to_string())?;
        streams.insert(stream_id.clone(), cancelled.clone());
    }

    let url = format!("{}{}", full_config.base_url.trim_end_matches('/'), endpoint);
    let client = state.stream_client().clone();
    let sid = stream_id.clone();

    // Comfly: 按 body.model 派生 key 槽位，只用匹配 tag 的 key
    let key_tag = resolve_key_tag(&provider, &body);
    let keys = filter_keys_by_tag(full_config.keys.clone(), key_tag.as_deref());
    let can_rotate = full_config.auto_rotate && keys.len() > 1;
    let provider_clone = provider.clone();
    let key_tag_label = key_tag.as_deref().map(|t| match t {
        "gemini_premium" => "Gemini 优质",
        _ => "普通默认",
    }).unwrap_or("");

    tauri::async_runtime::spawn(async move {
        let mut succeeded = false;

        if keys.is_empty() {
            let _ = app.emit("ai-stream", StreamEvent {
                stream_id: sid.clone(),
                event: "error".into(),
                data: if key_tag_label.is_empty() {
                    format!(
                        "Provider '{}' 的 API Key 未配置，请在设置中填写",
                        provider_display_name(&provider_clone)
                    )
                } else {
                    format!(
                        "Provider '{}' 的「{}」槽位未配置 API Key，请在设置中填写",
                        provider_display_name(&provider_clone), key_tag_label
                    )
                },
            });
        } else {
            for (i, key_entry) in keys.iter().enumerate() {
                tracing::info!(
                    "[key_rotation][stream] provider={}, trying key \"{}\" ({}/{})",
                    provider_clone, key_entry.name, i + 1, keys.len()
                );

                let result = do_stream(
                    &app, &client, &url, &key_entry.key, &provider_clone, &body, &sid, &cancelled,
                ).await;

                match result {
                    Ok(()) => {
                        if i > 0 {
                            if let Ok(db) = app.state::<AppState>().db.lock() {
                                let _ = set_active_key(&db, &provider_clone, &key_entry.id, &key_entry.key);
                            }
                            tracing::info!(
                                "[key_rotation][stream] provider={}, active key changed to \"{}\"",
                                provider_clone, key_entry.name
                            );
                            let _ = app.emit("ai-stream", StreamEvent {
                                stream_id: sid.clone(),
                                event: "key_switched".into(),
                                data: serde_json::json!({
                                    "key_name": key_entry.name,
                                    "tried_count": i + 1,
                                }).to_string(),
                            });
                        }
                        succeeded = true;
                        break;
                    }
                    Err(ref e) if can_rotate && is_stream_retryable(e) => {
                        tracing::warn!(
                            "[key_rotation][stream] provider={}, key \"{}\" failed: {} — rotating",
                            provider_clone, key_entry.name, e
                        );
                        continue;
                    }
                    Err(e) => {
                        let _ = app.emit("ai-stream", StreamEvent {
                            stream_id: sid.clone(),
                            event: "error".into(),
                            data: e,
                        });
                        succeeded = true;
                        break;
                    }
                }
            }

            if !succeeded {
                let _ = app.emit("ai-stream", StreamEvent {
                    stream_id: sid.clone(),
                    event: "error".into(),
                    data: format!("所有 API Key 均不可用 (尝试了 {} 个)", keys.len()),
                });
            }
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

fn is_stream_retryable(err: &str) -> bool {
    if let Some(pos) = err.find("HTTP ") {
        if let Ok(code) = err[pos + 5..].split(|c: char| !c.is_ascii_digit()).next().unwrap_or("0").parse::<u16>() {
            return code >= 400;
        }
    }
    false
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
    let resp = send_with_retry(
        || apply_auth_headers(
            client
                .post(url)
                .header("Content-Type", "application/json")
                .header("Accept-Encoding", "identity")
                .json(body),
            provider,
            api_key,
        ),
        "stream",
        url,
    )
    .await?;

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
        let resp_body = resp.text().await.unwrap_or_default();
        if let Some(state) = app.try_state::<AppState>() {
            let data_dir = state.data_dir.clone();
            let url_clone = url.to_string();
            let provider_clone = provider.to_string();
            let body_clone = body.clone();
            let resp_body_clone = resp_body.clone();
            let _ = run_blocking(move || {
                dump_failed_request(
                    &data_dir, "stream", &url_clone, &provider_clone, status,
                    &body_clone, &resp_body_clone,
                );
                Ok(())
            })
            .await;
        }
        return Err(format!("API 错误 (HTTP {}): {}", status, resp_body));
    }

    // ── 流式行缓冲：用 Vec<u8> + drain 避免每次拿到 \n 都 to_string() 整段重分配 ──
    //
    // 旧版 `buffer = buffer[newline_pos+1..].to_string()` 每个换行都把剩余
    // 字符串重新分配一遍，对长行 / 高频换行流式是 O(n²)。新版用 Vec<u8> + drain，
    // drain 内部 ptr::copy 把剩余字节往前挪，不再分配。
    //
    // 同时加两道闸门：
    //   1) line buffer 单次堆积超过 STREAM_LINE_BUFFER_HARD_LIMIT_BYTES 直接放弃（上游异常）
    //   2) 单个 chunk emit 超过 IPC_STREAM_CHUNK_HARD_LIMIT_BYTES 视为 error 终止流
    //      （IPC 通道扛不住这种大小，硬塞过去就是渲染端白屏）
    let mut buffer: Vec<u8> = Vec::with_capacity(8 * 1024);

    let mut stream = resp;
    loop {
        if cancelled.load(Ordering::Relaxed) {
            return Ok(());
        }

        let chunk = match stream.chunk().await {
            Ok(Some(c)) => c,
            Ok(None) => break,
            Err(e) => {
                let msg = root_cause_chain(&e);
                // 部分上游服务器 (含 nginx/cloudflare 反代) 在响应结束时不发送 TLS close_notify，
                // 严格 TLS 实现会把这种半正常关闭报为错误。如果我们已经收到过完整的 [DONE] 之外的数据，
                // 把它当作正常结束更符合实际场景，避免误报失败。
                if msg.contains("close_notify")
                    || msg.contains("UnexpectedEof")
                    || msg.contains("connection closed before message completed")
                {
                    tracing::warn!(
                        "[stream] graceful-EOF style error treated as end-of-stream: {} (status={} version={} ce={} te={})",
                        msg, status, version, content_encoding, transfer_encoding
                    );
                    break;
                }
                tracing::error!("[stream] chunk error: {} (status={} version={} ce={} te={})", msg, status, version, content_encoding, transfer_encoding);
                return Err(format!("读取流失败: {}", msg));
            }
        };

        buffer.extend_from_slice(&chunk);

        // 没换行但 buffer 已经撑爆：上游异常输出，放弃流避免无限增长 → OOM
        if buffer.len() > STREAM_LINE_BUFFER_HARD_LIMIT_BYTES
            && !buffer.iter().any(|&b| b == b'\n')
        {
            tracing::error!(
                "[stream] line buffer exceeded {} bytes without newline — aborting stream",
                STREAM_LINE_BUFFER_HARD_LIMIT_BYTES
            );
            return Err(format!(
                "上游流式响应异常：单行超过 {}MB 仍未换行，已中断",
                STREAM_LINE_BUFFER_HARD_LIMIT_BYTES / (1024 * 1024)
            ));
        }

        loop {
            let newline_pos = match buffer.iter().position(|&b| b == b'\n') {
                Some(p) => p,
                None => break,
            };

            // 取出 [..newline_pos]（不含 \n 本身）作为一行；\n 本身也丢掉。
            // String::from_utf8_lossy 可以容忍坏字节，避免上游偶尔吐出半个 utf-8 字符就 panic。
            let raw_line: Vec<u8> = buffer.drain(..=newline_pos).take(newline_pos).collect();
            let line_cow = String::from_utf8_lossy(&raw_line);
            let line = line_cow.trim_end_matches('\r');

            if line.is_empty() || line.starts_with(':') {
                continue;
            }

            if let Some(data) = line.strip_prefix("data: ") {
                if data.trim() == "[DONE]" {
                    return Ok(());
                }

                // chunk 大小守门：IPC 单条 emit 太大会拖崩 WebView 渲染端。
                if data.len() > IPC_STREAM_CHUNK_HARD_LIMIT_BYTES {
                    tracing::error!(
                        "[stream] chunk data {} bytes > {} hard limit — aborting stream to protect IPC",
                        data.len(),
                        IPC_STREAM_CHUNK_HARD_LIMIT_BYTES
                    );
                    return Err(format!(
                        "上游单条 chunk {}MB 超过 IPC 安全上限，已中断流",
                        data.len() / (1024 * 1024)
                    ));
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
/// `{data_dir}/media/images/{uuid}.{ext}`, plus a friendly auto-save copy.
///
/// 自动保存副本目录：读 DB `settings.file_auto_save_path`（启动时已确保有默认值）。
/// 副本最终路径为 `<base>/<project_folder>/<friendly_filename>`；项目子目录
/// 命名 `<sanitized_title>_<project_id_short>`。
/// Returns a **relative** path like `media/images/{uuid}.{ext}`.
#[tauri::command]
pub async fn save_media(
    state: State<'_, AppState>,
    source: String,
    filename: Option<String>,
    title: Option<String>,
    project_id: Option<String>,
) -> Result<SaveMediaResult, String> {
    let data_dir = &state.data_dir;
    let total_start = Instant::now();
    let source_kind = if source.starts_with("data:") {
        "data-url"
    } else if source.starts_with("http://") || source.starts_with("https://") {
        "remote-url"
    } else {
        "local-file"
    };
    tracing::info!(
        "[save_media] start source_kind={}, source_len={}, project_id={:?}",
        source_kind,
        source.len(),
        project_id
    );
    let media_dir = data_dir.join("media/images");
    {
        let media_dir = media_dir.clone();
        run_blocking(move || {
            std::fs::create_dir_all(&media_dir)
                .map_err(|e| format!("创建媒体目录失败: {}", e))
        })
        .await?;
    }

    let mut ext = detect_extension(&source, &filename);
    let file_id = uuid::Uuid::new_v4().to_string();
    tracing::info!(
        "[save_media] media_dir ready, ext={}, file_id={}",
        ext, file_id
    );

    let bytes = if source.starts_with("data:") {
        let b64 = source
            .splitn(2, ',')
            .nth(1)
            .ok_or("Invalid data-URL format")?;
        tracing::info!(
            "[save_media] data-url branch: payload_base64_len={}",
            b64.len()
        );
        let decode_start = Instant::now();
        let decoded = BASE64_ENGINE
            .decode(b64)
            .map_err(|e| format!("Base64 解码失败: {}", e))?;
        tracing::info!(
            "[save_media] base64 decoded: bytes={}, elapsed_ms={}",
            decoded.len(),
            decode_start.elapsed().as_millis()
        );
        decoded
    } else if source.starts_with("http://") || source.starts_with("https://") {
        let client = state.http_client();
        let max_retries = 3u32;
        let mut last_err = String::new();
        let mut downloaded = None;

        for attempt in 0..max_retries {
            if attempt > 0 {
                let delay = std::time::Duration::from_millis(500 * 2u64.pow(attempt - 1));
                tracing::info!("[save_media] 重试下载 #{}, 等待 {:?}", attempt + 1, delay);
                tokio::time::sleep(delay).await;
            }

            let download_start = Instant::now();
            tracing::info!("[save_media] 下载开始 attempt={}/{}", attempt + 1, max_retries);
            match client
                .get(&source)
                .header("User-Agent", "AI-Canvas/1.0")
                .send()
                .await
            {
                Ok(resp) => {
                    tracing::info!(
                        "[save_media] 下载响应头: status={}, elapsed_ms={}",
                        resp.status(),
                        download_start.elapsed().as_millis()
                    );
                    if !resp.status().is_success() {
                        last_err = format!("HTTP {}", resp.status());
                        tracing::warn!("[save_media] 下载返回非成功状态: {}", last_err);
                        continue;
                    }
                    if let Some(ct_ext) = ext_from_content_type(resp.headers()) {
                        tracing::info!("[save_media] Content-Type 检测到扩展名: {}", ct_ext);
                        ext = ct_ext;
                    }
                    let bytes_start = Instant::now();
                    match resp.bytes().await {
                        Ok(b) => {
                            tracing::info!(
                                "[save_media] 下载成功, {} 字节, body_elapsed_ms={}, total_download_elapsed_ms={}",
                                b.len(),
                                bytes_start.elapsed().as_millis(),
                                download_start.elapsed().as_millis()
                            );
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
                    tracing::warn!("[save_media] 下载请求失败 (attempt {}): {}, elapsed_ms={}", attempt + 1, last_err, download_start.elapsed().as_millis());
                }
            }
        }

        downloaded.ok_or_else(|| format!("下载失败 (重试{}次): {}", max_retries, last_err))?
    } else {
        // 当 source 是 media/ 开头的相对路径时，解析到 data_dir 而不是当前工作目录。
        // 否则 std::fs::read 会以 CWD 为基准导致 "系统找不到指定的路径"。
        let abs = if source.starts_with("media/") || source.starts_with("media\\") {
            data_dir.join(&source)
        } else {
            std::path::PathBuf::from(&source)
        };
        tracing::info!("[save_media] local-file branch: abs_path={:?}", abs);
        let read_start = Instant::now();
        let data = run_blocking(move || {
            std::fs::read(&abs).map_err(|e| format!("读取文件失败: {}", e))
        })
        .await?;
        tracing::info!(
            "[save_media] local file read: bytes={}, elapsed_ms={}",
            data.len(),
            read_start.elapsed().as_millis()
        );
        data
    };

    let dest = media_dir.join(format!("{}.{}", file_id, ext));

    let write_start = Instant::now();
    {
        let dest = dest.clone();
        let bytes_ref = bytes.clone();
        run_blocking(move || {
            std::fs::write(&dest, &bytes_ref).map_err(|e| format!("写入文件失败: {}", e))
        })
        .await?;
    }
    tracing::info!(
        "[save_media] 写入内部媒体文件完成: bytes={}, elapsed_ms={}, path={:?}",
        bytes.len(),
        write_start.elapsed().as_millis(),
        dest
    );

    tracing::info!("[save_media] acquiring db lock (auto_save_base)…");
    let lock1_start = Instant::now();
    let auto_save_base = resolve_save_dir(&state);
    tracing::info!(
        "[save_media] auto_save_base resolved: {:?}, total_lock1_block_ms={}",
        auto_save_base,
        lock1_start.elapsed().as_millis()
    );
    let target_dir = if let Some(ref pid) = project_id {
        tracing::info!("[save_media] acquiring db lock (project title) for pid={}…", pid);
        let lock2_start = Instant::now();
        let folder = {
            let db = state.db.lock().map_err(|e| e.to_string())?;
            tracing::info!(
                "[save_media] db lock #2 acquired, elapsed_ms={}",
                lock2_start.elapsed().as_millis()
            );
            db.query_row(
                "SELECT title FROM projects WHERE id = ?1",
                rusqlite::params![pid],
                |row| row.get::<_, String>(0),
            )
            .ok()
            .map(|t| build_project_folder_name(&t, pid))
        };
        tracing::info!(
            "[save_media] project folder lookup done: folder={:?}, total_lock2_block_ms={}",
            folder,
            lock2_start.elapsed().as_millis()
        );
        match folder {
            Some(f) => auto_save_base.join(f),
            None => auto_save_base.clone(),
        }
    } else {
        auto_save_base.clone()
    };

    let friendly_name = build_friendly_filename(&title, &file_id, &ext);
    let user_dest = target_dir.join(&friendly_name);
    tracing::info!(
        "[save_media] auto-save plan: target_dir={:?}, friendly_name={:?}",
        target_dir, friendly_name
    );

    {
        let target_dir = target_dir.clone();
        let dest = dest.clone();
        let user_dest = user_dest.clone();
        // 失败仅 warn，不打断主路径；放进 spawn_blocking 避免在 runtime 上做 dir/copy IO
        let _ = run_blocking::<(), _>(move || {
            if let Err(e) = std::fs::create_dir_all(&target_dir) {
                tracing::warn!("创建自动保存目录失败: {}", e);
                return Ok(());
            }
            let copy_start = Instant::now();
            match std::fs::copy(&dest, &user_dest) {
                Err(e) => tracing::warn!("复制文件到自动保存目录失败: {}", e),
                Ok(_) => tracing::info!(
                    "文件已自动保存: {:?}, copy_elapsed_ms={}",
                    user_dest,
                    copy_start.elapsed().as_millis()
                ),
            }
            Ok(())
        })
        .await;
    }

    let dims_start = Instant::now();
    let dims = detect_image_dimensions(&bytes);
    tracing::info!(
        "[save_media] 尺寸检测完成: dims={:?}, elapsed_ms={}",
        dims,
        dims_start.elapsed().as_millis()
    );

    let relative_path = format!("media/images/{}.{}", file_id, ext);
    tracing::info!(
        "[save_media] finished total_elapsed_ms={}, local_path={}",
        total_start.elapsed().as_millis(),
        relative_path
    );
    Ok(SaveMediaResult {
        local_path: relative_path,
        width: dims.map(|(w, _)| w),
        height: dims.map(|(_, h)| h),
    })
}

/// Return the absolute data directory path so the frontend can
/// construct asset-protocol URLs via `convertFileSrc()`.
#[tauri::command]
pub async fn get_media_base_path(state: State<'_, AppState>) -> Result<String, String> {
    Ok(state.data_dir.to_string_lossy().to_string())
}

/// Copy an image or video from internal storage to the user's export directory.
///
/// 文件名由 `build_friendly_filename` 统一生成（与自动保存一致），
/// 始终包含 UUID 短码，确保 `find_file_by_id` 可定位。
///
/// 导出目录解析（优先级从高到低）：
/// 1. `settings.file_export_path`（用户手动导出路径）；
/// 2. `settings.file_auto_save_path`（启动时已确保有默认值）。
#[tauri::command]
pub async fn export_file(
    state: State<'_, AppState>,
    source_path: String,
    title: Option<String>,
    project_id: Option<String>,
) -> Result<String, String> {
    let data_dir = &state.data_dir;
    let abs_source = data_dir.join(&source_path);

    if !abs_source.exists() {
        return Err(format!("源文件不存在: {}", source_path));
    }

    let file_id = abs_source
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("export")
        .to_string();
    let ext = abs_source
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("png");

    let export_name = build_friendly_filename(&title, &file_id, ext);

    let base_dir = resolve_export_dir(&state);

    let target_dir = if let Some(ref pid) = project_id {
        let folder = {
            let db = state.db.lock().map_err(|e| e.to_string())?;
            db.query_row(
                "SELECT title FROM projects WHERE id = ?1",
                rusqlite::params![pid],
                |row| row.get::<_, String>(0),
            )
            .ok()
            .map(|t| build_project_folder_name(&t, pid))
        };
        match folder {
            Some(f) => base_dir.join(f),
            None => base_dir,
        }
    } else {
        base_dir
    };

    let dest = target_dir.join(&export_name);
    {
        let target_dir = target_dir.clone();
        let abs_source = abs_source.clone();
        let dest_clone = dest.clone();
        run_blocking(move || {
            std::fs::create_dir_all(&target_dir)
                .map_err(|e| format!("创建导出目录失败: {}", e))?;
            std::fs::copy(&abs_source, &dest_clone)
                .map_err(|e| format!("导出文件失败: {}", e))?;
            Ok(())
        })
        .await?;
    }

    tracing::info!("文件已导出: {:?}", dest);
    Ok(dest.to_string_lossy().to_string())
}

/// Open the system file explorer and highlight the given file.
/// 优先在用户配置的导出/自动保存目录中查找友好命名副本，否则回退到内部存储。
#[tauri::command]
pub async fn open_in_explorer(
    state: State<'_, AppState>,
    path: String,
    project_id: Option<String>,
) -> Result<(), String> {
    let data_dir = &state.data_dir;

    let abs_path = if path.starts_with("media/") {
        if let Some(user_path) = resolve_user_media_path(&state, data_dir, &path, &project_id) {
            user_path
        } else {
            // Friendly copy not found — try opening the auto-save project directory
            let save_dir = resolve_save_dir(&state);
            let proj_dir = project_id.as_ref().and_then(|pid| {
                let db = state.db.lock().ok()?;
                db.query_row(
                    "SELECT title FROM projects WHERE id = ?1",
                    rusqlite::params![pid],
                    |row| row.get::<_, String>(0),
                )
                .ok()
                .map(|t| save_dir.join(build_project_folder_name(&t, pid)))
            });
            if let Some(ref dir) = proj_dir {
                if dir.is_dir() {
                    return reveal_path(dir);
                }
            }
            // Last resort: internal storage
            data_dir.join(&path)
        }
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
    data_dir: &std::path::Path,
    internal_path: &str,
    project_id: &Option<String>,
) -> Option<std::path::PathBuf> {
    let internal_abs = data_dir.join(internal_path);
    let internal_stem = internal_abs
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    if internal_stem.is_empty() {
        return None;
    }
    let short_id = &internal_stem[..8.min(internal_stem.len())];
    let internal_ext = internal_abs
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("");

    let short_pid = project_id
        .as_ref()
        .map(|pid| &pid[..8.min(pid.len())]);

    let project_folder = project_id.as_ref().and_then(|pid| {
        let db = state.db.lock().ok()?;
        db.query_row(
            "SELECT title FROM projects WHERE id = ?1",
            rusqlite::params![pid],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .map(|t| build_project_folder_name(&t, pid))
    });

    let candidate_dirs = candidate_save_dirs(state);

    let search_dirs: Vec<std::path::PathBuf> = candidate_dirs
        .iter()
        .filter(|base| base.is_dir())
        .map(|base| {
            if let Some(ref folder) = project_folder {
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
            }
        })
        .collect();

    // Phase 1: match by UUID short-id substring in filename
    for dir in &search_dirs {
        if let Some(found) = find_file_by_id(dir, short_id) {
            return Some(found);
        }
    }

    // Phase 2: fallback for old files without UUID in name — match by file size + extension
    let internal_size = std::fs::metadata(&internal_abs).ok().map(|m| m.len()).unwrap_or(0);
    if internal_size > 0 {
        for dir in &search_dirs {
            if let Some(found) = find_file_by_size(dir, internal_size, internal_ext) {
                return Some(found);
            }
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

fn find_file_by_size(dir: &std::path::Path, target_size: u64, target_ext: &str) -> Option<std::path::PathBuf> {
    if !dir.is_dir() {
        return None;
    }
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if !target_ext.is_empty() {
            let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
            if !ext.eq_ignore_ascii_case(target_ext) {
                continue;
            }
        }
        if let Ok(meta) = path.metadata() {
            if meta.len() == target_size {
                return Some(path);
            }
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
/// resolved against data_dir, and absolute paths.
#[tauri::command]
pub async fn read_media_base64(state: State<'_, AppState>, path: String) -> Result<String, String> {
    let abs_path = if path.starts_with("media/") {
        state.data_dir.join(&path)
    } else {
        std::path::PathBuf::from(&path)
    };

    let bytes = {
        let abs_path = abs_path.clone();
        run_blocking(move || {
            std::fs::read(&abs_path)
                .map_err(|e| format!("读取文件失败 '{}': {}", abs_path.display(), e))
        })
        .await?
    };

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

fn build_friendly_filename(title: &Option<String>, file_id: &str, ext: &str) -> String {
    let timestamp = Local::now().format("%Y%m%d_%H%M%S");
    let short_id = &file_id[..8.min(file_id.len())];
    match title
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(sanitize_filename)
        .filter(|s| !s.is_empty())
    {
        Some(name) => format!("{}_{}_{}.{}", name, short_id, timestamp, ext),
        None => format!("{}_{}.{}", short_id, timestamp, ext),
    }
}

/// 最长字符数（按 Unicode `char` 计）。Windows MAX_PATH 是 260 字节，
/// 项目子目录 + 友好文件名 + 时间戳 + 扩展名 + 多字节字符（中文 3 字节 UTF-8）
/// 加起来很容易顶到上限，统一截到 40 char 留余量。
const FRIENDLY_NAME_MAX_CHARS: usize = 40;

fn sanitize_filename(name: &str) -> String {
    let mapped: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' || c == ' ' || c > '\x7f' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = mapped.trim();
    if trimmed.chars().count() <= FRIENDLY_NAME_MAX_CHARS {
        trimmed.to_string()
    } else {
        trimmed
            .chars()
            .take(FRIENDLY_NAME_MAX_CHARS)
            .collect::<String>()
            .trim_end()
            .to_string()
    }
}

/// 读取 `settings` 表中的字符串值，去除两端空白后空字符串视作"未配置"返回 None。
/// 所有"用户没设路径就回退"的逻辑都通过这一个函数判断，避免散落的语义偏差。
pub(crate) fn read_nonempty_setting(
    db: &rusqlite::Connection,
    key: &str,
) -> Option<String> {
    db.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        rusqlite::params![key],
        |row| row.get::<_, String>(0),
    )
    .ok()
    .map(|v| v.trim().to_string())
    .filter(|v| !v.is_empty())
}

/// 自动保存目录（生成图片/视频后自动写入的位置）。
/// 唯一数据源：DB `file_auto_save_path`（启动时已确保有值）。
pub(crate) fn resolve_save_dir(state: &AppState) -> std::path::PathBuf {
    state
        .db
        .lock()
        .ok()
        .and_then(|db| read_nonempty_setting(&db, "file_auto_save_path"))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| state.data_dir.join("文件自动保存"))
}

/// 导出目录（用户手动"下载/导出"时的目标位置）。
/// 优先 `file_export_path`，没设则回退到自动保存目录。
pub(crate) fn resolve_export_dir(state: &AppState) -> std::path::PathBuf {
    state
        .db
        .lock()
        .ok()
        .and_then(|db| {
            read_nonempty_setting(&db, "file_export_path")
                .or_else(|| read_nonempty_setting(&db, "file_auto_save_path"))
        })
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| state.data_dir.join("文件自动保存"))
}

/// 所有可能存有用户友好副本的候选目录（用于"在文件夹中打开"搜索）。
pub(crate) fn candidate_save_dirs(state: &AppState) -> Vec<std::path::PathBuf> {
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(db) = state.db.lock() {
        if let Some(v) = read_nonempty_setting(&db, "file_export_path") {
            dirs.push(std::path::PathBuf::from(v));
        }
        if let Some(v) = read_nonempty_setting(&db, "file_auto_save_path") {
            let p = std::path::PathBuf::from(v);
            if !dirs.contains(&p) {
                dirs.push(p);
            }
        }
    }
    // 旧版兼容
    let legacy = state.data_dir.join("auto-save");
    if legacy.is_dir() && !dirs.contains(&legacy) {
        dirs.push(legacy);
    }
    dirs
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
