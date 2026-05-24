//! Rust → JiJing server 远程上传。把本地媒体一次性 multipart 送到
//! `{base_url}/v1/files/upload` 拿 HTTP URL,之后这个 URL 直接塞进
//! `/v1/images/generations` 等接口的 body,**不再走 base64 inline**。
//!
//! ## 跟 [`upload_local`](super::upload_local) 的区别
//!
//! - [`upload_local`](super::upload_local):**前端 → Rust 本地分块写盘**,
//!   规避 WebView2 IPC 3MB 上限,终点是 ai-canvas data_dir 下的 temp 文件
//!   / media/images/ 持久化。
//! - 本模块 (`upload_remote`):**Rust → JiJing 服务端**,规避上游 API body
//!   过大 / `inline_local_files` 64MB 累计,终点是 `https://api.../uploads/...`。
//!
//! ## 缓存策略
//!
//! sqlite `uploaded_files (sha256, server_origin)` 主键 ——
//! 同 server 同文件第二次直接命中,不发 HTTP。详见
//! `db/migrations.rs::migrate_v8`。
//!
//! ## 并发限制
//!
//! 全局 `Semaphore(4)` 限并发 —— 6 张图同时点生成时只让 4 个并行上传,
//! 防止打爆服务端 + 用户本地网络。

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;
use tokio::sync::Semaphore;

use crate::AppState;
use super::config::{apply_auth_headers, read_full_api_config};
use super::http_util::root_cause_chain;
use super::util::run_blocking;

/// 单文件上限 100MB —— 与 nginx `client_max_body_size` / Spring
/// `max-file-size` 对齐。客户端预校验早失败比让 nginx 413 更友好。
pub const REMOTE_UPLOAD_MAX_BYTES: u64 = 100 * 1024 * 1024;

/// 全局并发限制。6 张图点生成时只让 4 个并行,
/// 避免在弱网下同时打开 6 条 multipart 连接 stall 全部 timeout。
static UPLOAD_SEMAPHORE: OnceLock<Semaphore> = OnceLock::new();
const UPLOAD_CONCURRENCY: usize = 4;

fn upload_semaphore() -> &'static Semaphore {
    UPLOAD_SEMAPHORE.get_or_init(|| Semaphore::new(UPLOAD_CONCURRENCY))
}

/// 返给前端的上传结果。
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UploadResult {
    /// 可直接 GET 的 HTTP(S) URL, 用于回填到 `/v1/images/generations` 等
    pub url: String,
    /// sha256 hex, 跟服务端对账用
    pub sha256: String,
    /// MIME type
    #[serde(rename = "contentType")]
    pub content_type: String,
    /// 原始字节数
    pub size: u64,
    /// 是否命中本地或服务端缓存
    pub cached: bool,
}

/// 服务端 `/v1/files/upload` 返回结构 —— 跟 `FileUploadResponse.java` 对齐。
#[derive(Debug, Deserialize)]
struct ServerFileUploadResponse {
    url: String,
    sha256: String,
    #[serde(rename = "contentType")]
    content_type: String,
    size: u64,
    #[serde(default)]
    cached: bool,
}

/// 服务端 `R<T>` 信封 —— code=200 才算成功, code 字段非 200 时 message 是
/// 面向用户的可读文案。详见 `R.java`。
///
/// Option 字段缺失时 serde 自动当 None, 不需要 `#[serde(default)]`
/// (后者会要求 T: Default)。
#[derive(Debug, Deserialize)]
struct ServerEnvelope<T> {
    code: i32,
    message: Option<String>,
    data: Option<T>,
}

/// 把任意"本地媒体路径"上传到 JiJing server 并返 HTTP URL。
/// 这是 ai-canvas 把媒体送上游 API 的**唯一**入口,前端通过 `platform/media.ts`
/// 间接调用,所有 chat / 生图 / 生视频 / 编辑器引用图都走它。
///
/// `path` 接受多种形态 (跟前端 `getBase64ForApi` 历史兼容):
/// - `local://media/<rel>` Tauri 占位符
/// - `media/<rel>` 相对存储路径
/// - 绝对路径 (Windows / Unix)
///
/// 安全约束:解析后的绝对路径必须落在 `data_dir` 子树内,
/// 防止前端把任意磁盘文件传上去。
///
/// 失败语义:
/// - `path` 越权 / 文件不存在 / 不可读 — `Err` 立刻返
/// - 文件 > 100MB — `Err` 客户端早失败, 不浪费上传带宽
/// - 服务端 4xx — `Err` 带 message 透传给前端用户
/// - 网络错误 / 服务端 5xx — `Err`, 前端可重试(本 command 自身不做指数退避,
///   交给前端按 UX 控制)
#[tauri::command]
pub async fn upload_to_server(
    state: State<'_, AppState>,
    path: String,
    provider: Option<String>,
) -> Result<UploadResult, String> {
    let provider = provider.unwrap_or_else(|| "jijing".to_string());

    let data_dir = state.data_dir.clone();
    let abs_path = resolve_input_path(&path, &data_dir)?;

    let size = tokio::fs::metadata(&abs_path)
        .await
        .map_err(|e| format!("读取文件元信息失败: {}", e))?
        .len();
    if size == 0 {
        return Err("文件为空, 无法上传".to_string());
    }
    if size > REMOTE_UPLOAD_MAX_BYTES {
        return Err(format!(
            "文件 {} MB 超过 {} MB 上限, 请压缩后再上传",
            size / (1024 * 1024),
            REMOTE_UPLOAD_MAX_BYTES / (1024 * 1024)
        ));
    }

    let content_type = super::ai::mime_from_path(&abs_path).to_string();

    // 流式 sha256 — 64KB chunk, 500MB 视频也只占 64KB 内存
    let sha_path = abs_path.clone();
    let sha256 = run_blocking(move || compute_sha256_streaming(&sha_path)).await?;

    // 读 JiJing config + 计算 server_origin
    let (base_url, api_key) = {
        let db = state.db.lock().map_err(|e| format!("db lock: {}", e))?;
        let config = read_full_api_config(&db, &provider)?;
        let key = config
            .keys
            .iter()
            .find(|k| k.id == config.active_key_id)
            .or_else(|| config.keys.first())
            .ok_or_else(|| format!("provider {} 未配置 API Key", provider))?
            .key
            .clone();
        (config.base_url, key)
    };
    if base_url.is_empty() {
        return Err(format!("provider {} 未配置 base_url", provider));
    }
    let server_origin = base_url.clone();

    // 命中本地缓存
    if let Some(cached) = lookup_cache(&state, &sha256, &server_origin)? {
        touch_last_used(&state, &sha256, &server_origin)?;
        tracing::info!(
            "[upload_remote] cache_hit sha256={} server={} url={}",
            sha256, server_origin, cached.remote_url
        );
        return Ok(UploadResult {
            url: cached.remote_url,
            sha256,
            content_type: cached.content_type,
            size,
            cached: true,
        });
    }

    // 真上传 —— 并发限制
    let _permit = upload_semaphore()
        .acquire()
        .await
        .map_err(|e| format!("upload semaphore: {}", e))?;

    let started = std::time::Instant::now();
    let resp = do_multipart_upload(
        &state,
        &provider,
        &base_url,
        &api_key,
        &abs_path,
        &sha256,
        &content_type,
    )
    .await?;

    // 落本地缓存 (服务端 cached 字段是它自己的去重命中, 本地缓存独立判断)
    insert_cache(
        &state,
        &sha256,
        &server_origin,
        &resp.url,
        &resp.content_type,
        size,
        abs_path.to_string_lossy().as_ref(),
    )?;

    tracing::info!(
        "[upload_remote] uploaded sha256={} size={} server={} url={} duration_ms={} server_cached={}",
        sha256,
        size,
        server_origin,
        resp.url,
        started.elapsed().as_millis(),
        resp.cached
    );

    Ok(UploadResult {
        url: resp.url,
        sha256,
        content_type: resp.content_type,
        size: resp.size.max(size),
        // 服务端 cached=true 也是首次本地, 客户端 cached 字段以"是否走了实际 HTTP"为准
        cached: false,
    })
}

/// 把 `local://media/x`, `media/x`, 绝对路径都归一为 data_dir 下的绝对路径,
/// 并校验不越权 (canonicalize 后必须落在 data_dir 子树)。
fn resolve_input_path(input: &str, data_dir: &Path) -> Result<PathBuf, String> {
    let rel = input.strip_prefix("local://").unwrap_or(input);
    if rel.is_empty() {
        return Err("空路径".to_string());
    }

    // 绝对路径 (Windows C:\... 或 Unix /...) — 直接 canonicalize 比对 data_dir 子树
    let raw = if Path::new(rel).is_absolute() {
        PathBuf::from(rel)
    } else {
        for seg in rel.split(['/', '\\']) {
            if seg == ".." {
                return Err(format!("路径包含 .. 段, 拒绝: {}", input));
            }
        }
        data_dir.join(rel.replace('\\', "/"))
    };

    if !raw.is_file() {
        return Err(format!("文件不存在: {}", input));
    }

    let canonical = raw
        .canonicalize()
        .map_err(|e| format!("路径解析失败 {:?}: {}", raw, e))?;
    let dir_canonical = data_dir
        .canonicalize()
        .map_err(|e| format!("data_dir 解析失败: {}", e))?;
    if !canonical.starts_with(&dir_canonical) {
        return Err(format!("路径越权 (必须在 data_dir 内): {}", input));
    }

    Ok(canonical)
}

/// 流式计算 sha256, 64KB chunk —— 大视频 (500MB) 也只占 64KB 内存。
fn compute_sha256_streaming(path: &Path) -> Result<String, String> {
    use std::fs::File;
    use std::io::Read;

    let mut file = File::open(path).map_err(|e| format!("打开文件失败: {}", e))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("读取文件失败: {}", e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(digest.len() * 2);
    for b in digest.iter() {
        use std::fmt::Write;
        write!(&mut hex, "{:02x}", b).unwrap();
    }
    Ok(hex)
}

/// 缓存表行 ↔ struct, 内部表示。
#[derive(Debug)]
struct CacheRow {
    remote_url: String,
    content_type: String,
}

fn lookup_cache(
    state: &State<'_, AppState>,
    sha256: &str,
    server_origin: &str,
) -> Result<Option<CacheRow>, String> {
    let db = state.db.lock().map_err(|e| format!("db lock: {}", e))?;
    db.query_row(
        "SELECT remote_url, content_type FROM uploaded_files \
         WHERE sha256 = ?1 AND server_origin = ?2",
        rusqlite::params![sha256, server_origin],
        |row| Ok(CacheRow {
            remote_url: row.get(0)?,
            content_type: row.get(1)?,
        }),
    )
    .optional()
    .map_err(|e| format!("查询上传缓存失败: {}", e))
}

fn touch_last_used(
    state: &State<'_, AppState>,
    sha256: &str,
    server_origin: &str,
) -> Result<(), String> {
    let now = now_unix_secs();
    let db = state.db.lock().map_err(|e| format!("db lock: {}", e))?;
    db.execute(
        "UPDATE uploaded_files SET last_used_at = ?1 \
         WHERE sha256 = ?2 AND server_origin = ?3",
        rusqlite::params![now, sha256, server_origin],
    )
    .map_err(|e| format!("更新 last_used_at 失败: {}", e))?;
    Ok(())
}

fn insert_cache(
    state: &State<'_, AppState>,
    sha256: &str,
    server_origin: &str,
    remote_url: &str,
    content_type: &str,
    size_bytes: u64,
    local_path_hint: &str,
) -> Result<(), String> {
    let now = now_unix_secs();
    let db = state.db.lock().map_err(|e| format!("db lock: {}", e))?;
    db.execute(
        "INSERT OR REPLACE INTO uploaded_files \
         (sha256, server_origin, remote_url, content_type, size_bytes, \
          local_path_hint, uploaded_at, last_used_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        rusqlite::params![
            sha256,
            server_origin,
            remote_url,
            content_type,
            size_bytes as i64,
            local_path_hint,
            now,
        ],
    )
    .map_err(|e| format!("写入上传缓存失败: {}", e))?;
    Ok(())
}

fn now_unix_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 实际发 multipart POST。不走 `send_with_retry` —— 因为 `reqwest::multipart::Form`
/// 不能 clone, 每次发送会 consume 自己, 配 Fn 闭包不可重入。
/// 重试由前端 UX 控制 (用户点"重试"按钮时自然重发)。
async fn do_multipart_upload(
    state: &State<'_, AppState>,
    provider: &str,
    base_url: &str,
    api_key: &str,
    abs_path: &Path,
    sha256: &str,
    content_type: &str,
) -> Result<ServerFileUploadResponse, String> {
    let url = format!("{}/v1/files/upload", base_url.trim_end_matches('/'));
    let filename = abs_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("upload.bin")
        .to_string();

    // tokio::fs::read 走的是 spawn_blocking,大文件不会卡 runtime
    let bytes = tokio::fs::read(abs_path)
        .await
        .map_err(|e| format!("读取本地文件失败: {}", e))?;

    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(filename)
        .mime_str(content_type)
        .map_err(|e| format!("multipart mime 设置失败: {}", e))?;
    let form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("sha256", sha256.to_string())
        .text("purpose", "media-input");

    let builder = state.http_client().post(&url).multipart(form);
    let builder = apply_auth_headers(builder, provider, api_key);

    let resp = builder
        .send()
        .await
        .map_err(|e| format!("上传请求失败: url={} {}", url, root_cause_chain(&e)))?;

    let status = resp.status();
    let body_text = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {}", root_cause_chain(&e)))?;

    if !status.is_success() {
        // 尝试 parse R 包装拿 message, 不行就透传原文
        if let Ok(envelope) = serde_json::from_str::<ServerEnvelope<serde_json::Value>>(&body_text) {
            if let Some(msg) = envelope.message {
                return Err(format!("上传失败 HTTP {}: {}", status.as_u16(), msg));
            }
        }
        return Err(format!(
            "上传失败 HTTP {}: {}",
            status.as_u16(),
            truncate(&body_text, 500)
        ));
    }

    let envelope: ServerEnvelope<ServerFileUploadResponse> = serde_json::from_str(&body_text)
        .map_err(|e| format!("解析上传响应失败: {}, body={}", e, truncate(&body_text, 500)))?;
    if envelope.code != 200 {
        let msg = envelope.message.unwrap_or_else(|| format!("code={}", envelope.code));
        return Err(format!("上传失败: {}", msg));
    }
    let resp = envelope
        .data
        .ok_or_else(|| "上传响应缺少 data 字段".to_string())?;

    // 对账: 服务端回的 sha256 跟我们算的应当一致
    // 不一致说明 (a) 服务端 bug (b) 中间人篡改 (c) reqwest multipart 出问题
    // 三种都该立刻 fail 而不是把"错的 url"写进本地缓存
    if !resp.sha256.eq_ignore_ascii_case(sha256) {
        return Err(format!(
            "服务端 sha256 不匹配 (local={}, server={}), 上传被拒绝",
            sha256, resp.sha256
        ));
    }
    Ok(resp)
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…", &s[..max])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_test_data_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("create tempdir")
    }

    #[test]
    fn sha256_streaming_empty() {
        let dir = make_test_data_dir();
        let p = dir.path().join("empty.bin");
        std::fs::write(&p, b"").unwrap();
        let r = compute_sha256_streaming(&p).unwrap();
        // 空文件的 sha256 是著名常量
        assert_eq!(r, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    }

    #[test]
    fn sha256_streaming_small_payload() {
        let dir = make_test_data_dir();
        let p = dir.path().join("hello.bin");
        std::fs::write(&p, b"hello").unwrap();
        let r = compute_sha256_streaming(&p).unwrap();
        // sha256("hello") 著名值
        assert_eq!(r, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    }

    #[test]
    fn sha256_streaming_large_chunked_payload() {
        // 写 200KB 让流式读至少走 3 次 64KB chunk
        let dir = make_test_data_dir();
        let p = dir.path().join("big.bin");
        let payload: Vec<u8> = (0..200_000).map(|i| (i % 256) as u8).collect();
        std::fs::write(&p, &payload).unwrap();

        let streamed = compute_sha256_streaming(&p).unwrap();

        // 一次性算的版本应当等于流式
        let mut h = Sha256::new();
        h.update(&payload);
        let mut hex = String::new();
        for b in h.finalize().iter() {
            use std::fmt::Write;
            write!(&mut hex, "{:02x}", b).unwrap();
        }
        assert_eq!(streamed, hex);
    }

    #[test]
    fn resolve_input_path_rejects_traversal() {
        let dir = make_test_data_dir();
        let r = resolve_input_path("../../etc/passwd", dir.path());
        assert!(r.is_err());
        assert!(r.unwrap_err().contains(".."));
    }

    #[test]
    fn resolve_input_path_rejects_nonexistent() {
        let dir = make_test_data_dir();
        let r = resolve_input_path("media/nope.png", dir.path());
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("不存在"));
    }

    #[test]
    fn resolve_input_path_accepts_local_prefix() {
        let dir = make_test_data_dir();
        std::fs::create_dir_all(dir.path().join("media")).unwrap();
        let p = dir.path().join("media/1.png");
        std::fs::write(&p, b"x").unwrap();

        let r = resolve_input_path("local://media/1.png", dir.path()).unwrap();
        assert!(r.ends_with("1.png"));
    }

    #[test]
    fn resolve_input_path_accepts_relative() {
        let dir = make_test_data_dir();
        std::fs::create_dir_all(dir.path().join("media")).unwrap();
        let p = dir.path().join("media/x.jpg");
        std::fs::write(&p, b"x").unwrap();

        let r = resolve_input_path("media/x.jpg", dir.path()).unwrap();
        assert!(r.ends_with("x.jpg"));
    }
}
