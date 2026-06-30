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
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;
use tokio::sync::{broadcast, Semaphore};

use crate::AppState;
use super::config::{apply_auth_headers, read_full_api_config};
use super::http_util::root_cause_chain;
use super::jijing_serde::{deserialize_u64_str_or_num, ServerEnvelope};
use super::upload_presign::try_direct_upload;
use super::util::run_blocking;

// ─── 单文件上限按 MIME 分桶 ─────────────────────────────────────────────
//
// 与服务端 `com.jijing.common.storage.StorageProperties.resolveMaxFileSize`
// 对齐 —— 图 / 视频 / 音频各自独立上限, 视频 1GB 覆盖 4K 长片段。客户端预
// 校验早失败比让 nginx 413 更友好, 错误消息也更具体 ("视频 250MB 超过 1GB"
// 而不是 nginx 通用 413)。
//
// 兜底 `DEFAULT_UPLOAD_MAX_BYTES` 对应服务端 `maxFileSize`, 用于无法按 MIME
// 前缀识别的场景。改默认值时同步改服务端 yml 的
// `jijing.storage.{image,video,audio}-max-file-size`。

/// 图片上限 (image/*), 50MB —— 覆盖 4K PNG 无损。
pub const IMAGE_UPLOAD_MAX_BYTES: u64 = 50 * 1024 * 1024;
/// 视频上限 (video/*), 1GB —— 覆盖 4K 长片段。
pub const VIDEO_UPLOAD_MAX_BYTES: u64 = 1024 * 1024 * 1024;
/// 音频上限 (audio/*), 100MB。
pub const AUDIO_UPLOAD_MAX_BYTES: u64 = 100 * 1024 * 1024;
/// 兜底上限, 100MB —— 与服务端 `jijing.storage.max-file-size` 对齐。
pub const DEFAULT_UPLOAD_MAX_BYTES: u64 = 100 * 1024 * 1024;

/// 按 MIME 类型解析对应上限。未匹配前缀时返回 [`DEFAULT_UPLOAD_MAX_BYTES`]。
///
/// 跟服务端 `StorageProperties.resolveMaxFileSize` 行为一致 —— **保持两边同
/// 步**, 否则客户端放过去服务端再拒会产生 413 / 4xx 不一致体验。
pub fn resolve_upload_max_bytes(content_type: &str) -> u64 {
    let mime = content_type.to_ascii_lowercase();
    if mime.starts_with("image/") {
        IMAGE_UPLOAD_MAX_BYTES
    } else if mime.starts_with("video/") {
        VIDEO_UPLOAD_MAX_BYTES
    } else if mime.starts_with("audio/") {
        AUDIO_UPLOAD_MAX_BYTES
    } else {
        DEFAULT_UPLOAD_MAX_BYTES
    }
}

// ─── 并发控制:两个 semaphore 分桶 + in-flight 单飞 ─────────────────────────
//
// **主路径** (`prewarm=false`):用户点生成 / 编辑器送 ref 图等强相关操作走
// 这里, 4 路并发够覆盖典型多 ref 场景。
//
// **预热路径** (`prewarm=true`):用户拖入/粘贴图片后台静默上传, 优先级低,
// 不能挤占主路径配额, 单独 2 路。预热和主路径加起来 6 路 ≈ 服务端 nginx
// `limit_req zone=files_upload_ip burst=20` 完全够。
//
// **in-flight 单飞**:同 (sha256, server_origin) 已在上传 → 后来者 await
// 同一个 broadcast 拿结果, 不再发新 HTTP, 不抢 semaphore。这一层根治
// 单客户端的 race (同卡片 ref 复用 / 预热+主路径并发同图)。
// 服务端的 race 兜底 (UploadedFilePortAdapter.handleRaceDuplicate)
// 只剩对付多客户端场景。

static MAIN_SEMAPHORE: OnceLock<Semaphore> = OnceLock::new();
static PREWARM_SEMAPHORE: OnceLock<Semaphore> = OnceLock::new();
const MAIN_CONCURRENCY: usize = 4;
const PREWARM_CONCURRENCY: usize = 2;

fn main_semaphore() -> &'static Semaphore {
    MAIN_SEMAPHORE.get_or_init(|| Semaphore::new(MAIN_CONCURRENCY))
}

fn prewarm_semaphore() -> &'static Semaphore {
    PREWARM_SEMAPHORE.get_or_init(|| Semaphore::new(PREWARM_CONCURRENCY))
}

/// in-flight 单飞表:key = `{sha256}|{server_origin}`,
/// value = broadcast sender。leader 上传完调 send 把 Result 广播给所有
/// follower。leader 走完后从 map 移除。
///
/// 用 `std::sync::Mutex` 而非 `tokio::sync::Mutex` —— 临界区只是 HashMap
/// get/insert/remove, 不跨 await, 同步锁更轻。
type InFlightMap = HashMap<String, broadcast::Sender<Result<UploadResult, String>>>;
static IN_FLIGHT: OnceLock<Mutex<InFlightMap>> = OnceLock::new();

fn in_flight_map() -> &'static Mutex<InFlightMap> {
    IN_FLIGHT.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 单飞 key 拼接规范, 测试也用这条函数, 防止两边拼法不一致。
fn flight_key(sha256: &str, server_origin: &str) -> String {
    format!("{}|{}", sha256, server_origin)
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
///
/// `size` 是 Java `Long`, 必须套 `deserialize_u64_str_or_num` —— 服务端
/// Jackson 把所有 `Long` 序列化成字符串。详见 [`super::jijing_serde`]。
#[derive(Debug, Deserialize)]
pub(crate) struct ServerFileUploadResponse {
    pub(crate) url: String,
    pub(crate) sha256: String,
    #[serde(rename = "contentType")]
    pub(crate) content_type: String,
    #[serde(deserialize_with = "deserialize_u64_str_or_num")]
    pub(crate) size: u64,
    #[serde(default)]
    pub(crate) cached: bool,
}

/// 把任意"本地媒体路径"上传到 JiJing server 并返 HTTP URL。
/// 这是 ai-canvas 把媒体送上游 API 的**主路径**入口 (文件路径形态),
/// 前端通过 `platform/httpAdapter.ts::httpUploadBytes` 间接调用大部分场景,
/// 文件路径形态走本 command。
///
/// `path` 接受多种形态 (跟前端 `getBase64ForApi` 历史兼容):
/// - `local://media/<rel>` Tauri 占位符
/// - `media/<rel>` 相对存储路径
/// - 绝对路径 (Windows / Unix)
///
/// `prewarm`:`true` = 用户拖入/粘贴后台预热路径, 占 PREWARM_SEMAPHORE(2)
/// 不挤占主路径;`false` = 用户主动触发 (点生成 / 送 ref 图), 占
/// MAIN_SEMAPHORE(4)。两个路径**共享** in-flight 单飞表 — 预热和主路径
/// 撞同一 sha256 时, 后到的 follower await 先到的 broadcast, 只发一次 HTTP。
///
/// **Failure isolation (Patch B)**:follower 收到 leader 失败 broadcast 时
/// 不直接透传 Err,而是 fall through 进 retry loop 重新 claim 自己当新 leader
/// 跑一遍。这样预热的偶发网络抖动不会拖累用户主动触发的主路径。
/// retry 上限 [`MAX_UPLOAD_ATTEMPTS`] 防文件超大/鉴权失败等永久错误导致死循环。
///
/// 安全约束:解析后的绝对路径必须落在 `data_dir` 子树内。
#[tauri::command]
pub async fn upload_to_server(
    state: State<'_, AppState>,
    path: String,
    provider: Option<String>,
    prewarm: Option<bool>,
) -> Result<UploadResult, String> {
    let provider = provider.unwrap_or_else(|| "jijing".to_string());
    let prewarm = prewarm.unwrap_or(false);

    let data_dir = state.data_dir.clone();
    let abs_path = match resolve_input_path(&path, &data_dir) {
        Ok(p) => p,
        Err(err) => {
            if err.contains("文件不存在") {
                if let Some(cached) = lookup_cache_by_path_hint(&state, &path, &data_dir, &provider)? {
                    tracing::info!(
                        "[upload_to_server] file missing but cache hit via path_hint: path={}, url={}",
                        path, cached.url
                    );
                    return Ok(cached);
                }
            }
            return Err(err);
        }
    };

    let size = tokio::fs::metadata(&abs_path)
        .await
        .map_err(|e| format!("读取文件元信息失败: {}", e))?
        .len();
    if size == 0 {
        return Err("文件为空, 无法上传".to_string());
    }

    let content_type = super::ai::mime_from_path(&abs_path).to_string();

    // >10MB 的静态图片先压到 ~9.75MB 以内再进上传管线(文本/图片节点参考图直传
    // 上游会撞服务端 inliner 20MB cap / 上游拉不动国内 COS 大图)。best-effort:
    // 压不了(ffmpeg 缺失 / 解码失败)原样上传,绝不因压缩挡住上传。
    // 压缩产物按源 sha 落 media/compressed/ 缓存;后续 sha256 / uploaded_files
    // 缓存 / in-flight 单飞 / presign 全部基于压缩后的文件,预热与主路径自然命中
    // 同一份。卡片 data 与本地显示不受影响,只有送上游的字节被压。
    let (abs_path, size, content_type) = match super::image_shrink::shrink_image_for_upload(
        &data_dir, &abs_path, size, &content_type,
    )
    .await
    {
        Some((shrunk_path, shrunk_size)) => (shrunk_path, shrunk_size, "image/jpeg".to_string()),
        None => (abs_path, size, content_type),
    };

    enforce_upload_size_limit(size, &content_type)?;

    // 流式 sha256 — 64KB chunk, 500MB 视频也只占 64KB 内存
    let sha_path = abs_path.clone();
    let sha256 = run_blocking(move || compute_sha256_streaming(&sha_path)).await?;

    let filename = abs_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("upload.bin")
        .to_string();

    run_upload_pipeline(
        &state,
        &provider,
        UploadSource::Path(abs_path.clone()),
        &sha256,
        &content_type,
        &filename,
        size,
        prewarm,
    )
    .await
}

/// bytes 形态入口 —— 前端 WebView 拿到 `data:` / `blob:` / vite asset 之后,
/// 用 `fetch()` 解析成 Blob 再通过本 command 上传。
///
/// 跟 [`upload_to_server`] 共享:
/// - sha256 缓存 (uploaded_files 表) — 相同字节哈希直接命中已上传 URL
/// - in-flight 单飞 — 同一进程内并发上传同 sha256 只跑一次 HTTP
/// - 主/预热 semaphore — 控制全局并发
/// - retry loop + failure isolation — follower 自动接力当 leader 兜底
///
/// 与 path 版本的差别:
/// - sha256 用内存 in-memory 计算 (bytes 已经在内存里, 不需要流式读盘)
/// - 不做路径越权校验 (没有路径)
/// - 大小由调用方校验 + 服务端再次兜底
///
/// **IPC 大小约束**: 单次 invoke 受 IPC_PAYLOAD_HARD_LIMIT_BYTES 限制,
/// 前端 `httpUploadBytes` 在 bytes 大于阈值时会自动转走 `upload_media_chunk`
/// 分块路径再调 `upload_to_server`,避免在 IPC 层就报错。
#[tauri::command]
pub async fn upload_bytes_to_server(
    state: State<'_, AppState>,
    bytes: Vec<u8>,
    filename: String,
    content_type: String,
    provider: Option<String>,
    prewarm: Option<bool>,
) -> Result<UploadResult, String> {
    let provider = provider.unwrap_or_else(|| "jijing".to_string());
    let prewarm = prewarm.unwrap_or(false);

    let size = bytes.len() as u64;
    if size == 0 {
        return Err("空字节数据, 无法上传".to_string());
    }

    let content_type = if content_type.trim().is_empty() {
        "application/octet-stream".to_string()
    } else {
        content_type
    };
    enforce_upload_size_limit(size, &content_type)?;

    let bytes_arc = std::sync::Arc::new(bytes);
    let bytes_for_sha = bytes_arc.clone();
    let sha256 = run_blocking(move || compute_sha256_from_bytes(&bytes_for_sha)).await?;

    let safe_filename = if filename.trim().is_empty() {
        format!("upload.{}", extension_from_mime(&content_type))
    } else {
        // 防注入: 去掉路径分隔符, 只保留 basename
        std::path::Path::new(&filename)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("upload.bin")
            .to_string()
    };

    run_upload_pipeline(
        &state,
        &provider,
        UploadSource::Bytes(bytes_arc),
        &sha256,
        &content_type,
        &safe_filename,
        size,
        prewarm,
    )
    .await
}

/// 检查文件大小是否超过该 MIME 类型的上限,统一报错文案给两个入口共用。
fn enforce_upload_size_limit(size: u64, content_type: &str) -> Result<(), String> {
    let max_bytes = resolve_upload_max_bytes(content_type);
    if size > max_bytes {
        return Err(format!(
            "{} 文件 {}MB 超过 {}MB 上限, 请压缩或裁剪后再上传",
            content_type,
            size / (1024 * 1024),
            max_bytes / (1024 * 1024)
        ));
    }
    Ok(())
}

/// 上传源 —— path 走文件系统流式读, bytes 走内存直传。
/// 用 Arc<Vec<u8>> 而不是 Vec<u8>, 让 follower → leader 接力时不复制大块内存。
pub(crate) enum UploadSource {
    Path(PathBuf),
    Bytes(std::sync::Arc<Vec<u8>>),
}

impl UploadSource {
    fn clone_handle(&self) -> Self {
        match self {
            UploadSource::Path(p) => UploadSource::Path(p.clone()),
            UploadSource::Bytes(b) => UploadSource::Bytes(b.clone()),
        }
    }

    /// 读出待上传字节。multipart 与 presign 直传两条路径共用此入口,保证
    /// "读什么"完全一致。Path 走 `tokio::fs::read`(内部 spawn_blocking,大文件
    /// 不卡 runtime);Bytes 已在内存,clone 一份给调用方拥有。
    pub(crate) async fn read_bytes(&self) -> Result<Vec<u8>, String> {
        match self {
            UploadSource::Path(p) => tokio::fs::read(p)
                .await
                .map_err(|e| format!("读取本地文件失败: {}", e)),
            UploadSource::Bytes(arc) => Ok((**arc).clone()),
        }
    }
}

/// 共享 retry loop + cache lookup + in-flight 单飞调度。
/// 抽出来后 path 版和 bytes 版只差一个 [`UploadSource`] 入参,
/// 缓存/并发治理 100% 共用,不存在"两种实现一种漏 bug"的隐患。
#[allow(clippy::too_many_arguments)]
async fn run_upload_pipeline(
    state: &State<'_, AppState>,
    provider: &str,
    source: UploadSource,
    sha256: &str,
    content_type: &str,
    filename: &str,
    size: u64,
    prewarm: bool,
) -> Result<UploadResult, String> {
    let (base_url, api_key) = {
        let db = state.db.lock().map_err(|e| format!("db lock: {}", e))?;
        let config = read_full_api_config(&db, provider)?;
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
    let key = flight_key(sha256, &server_origin);

    // ── Failure isolation retry loop ───────────────────────────────────
    //
    // 每轮: lookup_cache → claim_or_follow → (leader 跑上传 | follower 等结果)
    //
    // Follower 收到 Ok(Err) 时,意味着当前 leader 失败但已 broadcast_and_release
    // (key 已从 IN_FLIGHT map 移除)。重入 loop 这次自己变成 leader 把上传跑一遍。
    // 实测语义:预热 leader 网络抖动 → 主路径 follower 自动接力当新 leader,
    // 用户感知零差异。
    //
    // 死循环防护:[`MAX_UPLOAD_ATTEMPTS`] = 2 (原始 + 一次降级重试)。
    // 永久错误 (文件超大/鉴权失败/服务端持续 5xx) 第二轮还会失败,直接报错给上层。
    let mut attempt = 0u32;
    loop {
        attempt += 1;

        // 1. 缓存命中 → 直接返, 不进 in-flight / 不抢 semaphore
        if let Some(cached) = lookup_cache(state, sha256, &server_origin)? {
            touch_last_used(state, sha256, &server_origin)?;
            tracing::info!(
                "[upload_remote] cache_hit prewarm={} sha256={} server={} url={} attempt={}",
                prewarm, sha256, server_origin, cached.remote_url, attempt
            );
            return Ok(UploadResult {
                url: cached.remote_url,
                sha256: sha256.to_string(),
                content_type: cached.content_type,
                size,
                cached: true,
            });
        }

        // 2. claim 单飞 — 已有 leader 在跑同 sha256 → 当 follower 等;否则自己 leader
        let role = claim_or_follow(&key);

        match role {
            FlightRole::Follower(mut rx) => {
                tracing::info!(
                    "[upload_remote] follower waiting prewarm={} key={} attempt={}",
                    prewarm, key, attempt
                );
                match rx.recv().await {
                    // leader 成功 → 直接复用结果
                    Ok(Ok(result)) => return Ok(result),

                    // leader 失败且还能重试 → fall through, 下一轮自己当 leader 兜底。
                    // 注意:leader 一定已经 broadcast_and_release 从 map 摘除了 key,
                    // 否则 broadcast 不会发出 (channel 还没 send)。所以下一轮 claim
                    // 必然成为新 Leader。
                    Ok(Err(leader_err)) if attempt < MAX_UPLOAD_ATTEMPTS => {
                        tracing::warn!(
                            "[upload_remote] follower fall_through_retry prewarm={} key={} leader_err={} attempt={}",
                            prewarm, key, leader_err, attempt
                        );
                        continue;
                    }

                    // 重试次数用完 → 把最后一次的 leader 错误透传
                    Ok(Err(leader_err)) => {
                        return Err(format!(
                            "上传失败 (follower 兜底重试已耗尽 {} 次): {}",
                            MAX_UPLOAD_ATTEMPTS, leader_err
                        ));
                    }

                    // broadcast channel 异常 (leader 直接 panic 没 release / channel 满)
                    Err(broadcast::error::RecvError::Closed) if attempt < MAX_UPLOAD_ATTEMPTS => {
                        tracing::warn!(
                            "[upload_remote] follower channel closed, retry as leader: key={} attempt={}",
                            key, attempt
                        );
                        continue;
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) if attempt < MAX_UPLOAD_ATTEMPTS => {
                        tracing::warn!(
                            "[upload_remote] follower channel lagged, retry as leader: key={} attempt={}",
                            key, attempt
                        );
                        continue;
                    }
                    Err(e) => {
                        return Err(format!("等待并发上传失败: {}", e));
                    }
                }
            }
            FlightRole::Leader => {
                // 3. leader 路径:占对应 semaphore → multipart → 写缓存 → 广播
                let result = perform_leader_upload(
                    state,
                    provider,
                    &base_url,
                    &api_key,
                    source.clone_handle(),
                    sha256,
                    content_type,
                    filename,
                    &server_origin,
                    size,
                    prewarm,
                )
                .await;

                // broadcast 给所有 follower (含成功和失败), 同步从 map 摘除 key
                broadcast_and_release(&key, &result);
                return result;
            }
        }
    }
}

/// Follower failure isolation 重试上限。
/// 1 次原始 + 1 次降级当 leader 兜底 = 2。
/// 永久错误 (文件超大/鉴权/上游持续 5xx) 第二轮仍会失败,直接报上层。
const MAX_UPLOAD_ATTEMPTS: u32 = 2;

/// in-flight 单飞角色:leader 实际跑上传, follower 等 leader 的广播。
enum FlightRole {
    Leader,
    Follower(broadcast::Receiver<Result<UploadResult, String>>),
}

/// 注册自己为 leader 或当 follower。这一段必须**同步**完成 (持 std Mutex),
/// 不能跨 await。
fn claim_or_follow(key: &str) -> FlightRole {
    let mut map = in_flight_map().lock().expect("in_flight_map poisoned");
    if let Some(sender) = map.get(key) {
        FlightRole::Follower(sender.subscribe())
    } else {
        // broadcast channel 容量 4 够用:follower 数量在我们场景下通常 ≤ 4
        // (6 张图同卡片极端情况 5 个 follower)。容量不够 send 会被丢, 但只
        // 影响晚到的 follower —— follower 会在 recv 时拿到 Lagged 错误,
        // 退化为重发本次上传, 自然兜底。
        let (tx, _rx) = broadcast::channel(4);
        map.insert(key.to_string(), tx);
        FlightRole::Leader
    }
}

/// leader 执行实际上传 (占 semaphore → multipart → 写本地缓存)。
#[allow(clippy::too_many_arguments)]
async fn perform_leader_upload(
    state: &State<'_, AppState>,
    provider: &str,
    base_url: &str,
    api_key: &str,
    source: UploadSource,
    sha256: &str,
    content_type: &str,
    filename: &str,
    server_origin: &str,
    size: u64,
    prewarm: bool,
) -> Result<UploadResult, String> {
    let sem = if prewarm { prewarm_semaphore() } else { main_semaphore() };
    let _permit = sem
        .acquire()
        .await
        .map_err(|e| format!("upload semaphore: {}", e))?;

    let started = std::time::Instant::now();
    let local_path_hint = match &source {
        UploadSource::Path(p) => p.to_string_lossy().into_owned(),
        UploadSource::Bytes(_) => format!("bytes:{}", sha256),
    };

    // 优先走 presign 直传 COS(字节不过服务器,解决高并发上传慢);服务端
    // type=local 不支持直传时返 Ok(None),无缝 fallback 回 multipart 中转。
    // PUT/confirm 真失败返 Err,交给上层 retry loop / 用户重试,不静默降级。
    let http = state.http_client();
    let resp = match try_direct_upload(
        http, provider, base_url, api_key, &source, sha256, content_type, filename, size,
    )
    .await
    {
        Ok(Some(r)) => r,
        Ok(None) => {
            tracing::info!("[upload_remote] presign 不可用, fallback multipart sha256={}", sha256);
            do_multipart_upload(
                state, provider, base_url, api_key, &source, sha256, content_type, filename,
            )
            .await?
        }
        Err(e) => return Err(e),
    };

    insert_cache(
        state, sha256, server_origin, &resp.url, &resp.content_type, size,
        &local_path_hint,
    )?;

    tracing::info!(
        "[upload_remote] uploaded prewarm={} sha256={} size={} server={} url={} duration_ms={} server_cached={}",
        prewarm, sha256, size, server_origin, resp.url,
        started.elapsed().as_millis(), resp.cached
    );

    Ok(UploadResult {
        url: resp.url,
        sha256: sha256.to_string(),
        content_type: resp.content_type,
        size: resp.size.max(size),
        cached: false,
    })
}

/// leader 完成后:把结果广播给所有 follower, 同时从 in-flight map 移除 key。
/// 即便 result 是 Err 也要广播 (否则 follower 永远 await),
/// 但 follower 收到 Err 后由它自己决定是否重试 (当前实现是直接透传错误)。
fn broadcast_and_release(key: &str, result: &Result<UploadResult, String>) {
    let mut map = in_flight_map().lock().expect("in_flight_map poisoned");
    if let Some(sender) = map.remove(key) {
        // 没 follower 时 send 返 Err(SendError) — 正常, 忽略。
        let _ = sender.send(result.clone());
    }
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

/// 在内存里算 bytes 的 sha256, 用于 `upload_bytes_to_server` 路径。
/// bytes 已经全在内存里, 不需要流式;`run_blocking` 把这个 CPU-bound 操作
/// 扔到 blocking pool, 避免几 MB sha256 占住 tokio worker。
fn compute_sha256_from_bytes(bytes: &[u8]) -> Result<String, String> {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(digest.len() * 2);
    for b in digest.iter() {
        use std::fmt::Write;
        write!(&mut hex, "{:02x}", b).unwrap();
    }
    Ok(hex)
}

/// 从 MIME 推测扩展名 —— bytes 形态 filename 为空时兜底。
/// 与前端 `media.ts::extFromMime` 行为对齐, 保持上下两端命名一致。
fn extension_from_mime(mime: &str) -> &'static str {
    let m = mime.to_ascii_lowercase();
    match m.as_str() {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "video/quicktime" => "mov",
        "audio/mpeg" => "mp3",
        "audio/wav" => "wav",
        _ => "bin",
    }
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

/// 本地文件已丢失时,用 `local_path_hint` 反查 `uploaded_files` 缓存。
///
/// 文件名含 UUID 全局唯一,用 `LIKE '%<filename>'` 匹配,无视路径前缀差异
/// (canonicalize `\\?\` 前缀 / data_dir 迁移等)。命中则直接返回已上传的
/// server URL,省去一次重新上传。
fn lookup_cache_by_path_hint(
    state: &State<'_, AppState>,
    input: &str,
    _data_dir: &std::path::Path,
    provider: &str,
) -> Result<Option<UploadResult>, String> {
    let rel = input.strip_prefix("local://").unwrap_or(input);
    let filename = std::path::Path::new(rel)
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or("");
    if filename.is_empty() {
        return Ok(None);
    }

    let (base_url, _) = {
        let db = state.db.lock().map_err(|e| format!("db lock: {}", e))?;
        let config = read_full_api_config(&db, provider)?;
        (config.base_url, ())
    };
    if base_url.is_empty() {
        return Ok(None);
    }

    let pattern = format!("%{}", filename);
    let db = state.db.lock().map_err(|e| format!("db lock: {}", e))?;
    let result = db.query_row(
        "SELECT remote_url, content_type, sha256, size_bytes FROM uploaded_files \
         WHERE local_path_hint LIKE ?1 AND server_origin = ?2 \
         ORDER BY last_used_at DESC LIMIT 1",
        rusqlite::params![pattern, base_url],
        |row| {
            Ok(UploadResult {
                url: row.get(0)?,
                sha256: row.get(2)?,
                content_type: row.get(1)?,
                size: row.get::<_, i64>(3)? as u64,
                cached: true,
            })
        },
    );
    match result {
        Ok(r) => {
            let now = now_unix_secs();
            let _ = db.execute(
                "UPDATE uploaded_files SET last_used_at = ?1 \
                 WHERE sha256 = ?2 AND server_origin = ?3",
                rusqlite::params![now, r.sha256, base_url],
            );
            Ok(Some(r))
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            // 也试一下不限 server_origin — 换过 provider 但文件还是同一份
            let fallback = db.query_row(
                "SELECT remote_url, content_type, sha256, size_bytes, server_origin \
                 FROM uploaded_files \
                 WHERE local_path_hint LIKE ?1 \
                 ORDER BY last_used_at DESC LIMIT 1",
                rusqlite::params![pattern],
                |row| {
                    Ok((
                        UploadResult {
                            url: row.get(0)?,
                            sha256: row.get(2)?,
                            content_type: row.get(1)?,
                            size: row.get::<_, i64>(3)? as u64,
                            cached: true,
                        },
                        row.get::<_, String>(4)?,
                    ))
                },
            );
            match fallback {
                Ok((r, origin)) => {
                    let now = now_unix_secs();
                    let _ = db.execute(
                        "UPDATE uploaded_files SET last_used_at = ?1 \
                         WHERE sha256 = ?2 AND server_origin = ?3",
                        rusqlite::params![now, r.sha256, origin],
                    );
                    Ok(Some(r))
                }
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                Err(e) => Err(format!("查询上传缓存失败: {}", e)),
            }
        }
        Err(e) => Err(format!("查询上传缓存失败: {}", e)),
    }
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
#[allow(clippy::too_many_arguments)]
async fn do_multipart_upload(
    state: &State<'_, AppState>,
    provider: &str,
    base_url: &str,
    api_key: &str,
    source: &UploadSource,
    sha256: &str,
    content_type: &str,
    filename: &str,
) -> Result<ServerFileUploadResponse, String> {
    let url = format!("{}/v1/files/upload", base_url.trim_end_matches('/'));
    let filename_owned = filename.to_string();

    // 跟 presign 直传共用 UploadSource::read_bytes —— 两条路径"读什么"完全一致。
    let bytes = source.read_bytes().await?;

    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(filename_owned)
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

/// 截断到 `max` 字节内,且落在 UTF-8 字符边界上(避免切断多字节字符 panic),
/// 末尾补省略号。日志/错误体里常含中文,必须按边界截。
pub(crate) fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
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

    /// path 流式 sha256 与 bytes 内存 sha256 必须一致 —— 这是
    /// "两条入口共享同一 sqlite 缓存 key" 的前提。任何一边算错都会
    /// 导致 cache miss + 重复上传, 等同于规范化失败。
    #[test]
    fn sha256_path_and_bytes_agree() {
        let dir = make_test_data_dir();
        let p = dir.path().join("payload.bin");
        let payload: Vec<u8> = (0..150_000).map(|i| (i % 256) as u8).collect();
        std::fs::write(&p, &payload).unwrap();

        let from_path = compute_sha256_streaming(&p).unwrap();
        let from_bytes = compute_sha256_from_bytes(&payload).unwrap();
        assert_eq!(from_path, from_bytes);
    }

    #[test]
    fn sha256_bytes_empty_matches_known_constant() {
        let r = compute_sha256_from_bytes(b"").unwrap();
        assert_eq!(r, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    }

    #[test]
    fn extension_from_mime_known_types() {
        assert_eq!(extension_from_mime("image/png"), "png");
        assert_eq!(extension_from_mime("Image/JPEG"), "jpg"); // 大小写不敏感
        assert_eq!(extension_from_mime("video/mp4"), "mp4");
        assert_eq!(extension_from_mime(""), "bin");
        assert_eq!(extension_from_mime("application/x-weird"), "bin");
    }

    #[test]
    fn enforce_upload_size_limit_image_ok() {
        // 10MB JPEG 在 50MB 限额内
        assert!(enforce_upload_size_limit(10 * 1024 * 1024, "image/jpeg").is_ok());
    }

    #[test]
    fn enforce_upload_size_limit_image_too_big() {
        // 60MB PNG 超 50MB
        let r = enforce_upload_size_limit(60 * 1024 * 1024, "image/png");
        assert!(r.is_err());
        let msg = r.unwrap_err();
        assert!(msg.contains("60MB") && msg.contains("50MB"));
    }

    #[test]
    fn enforce_upload_size_limit_video_uses_video_quota() {
        // 200MB 视频在 1GB 限额内通过 (若误用图片配额会失败)
        assert!(enforce_upload_size_limit(200 * 1024 * 1024, "video/mp4").is_ok());
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

    // ── in-flight 单飞 ──────────────────────────────────────────────────
    //
    // 这几个测试直接调 claim_or_follow / broadcast_and_release, 不打 HTTP。
    // IN_FLIGHT 是全局 static, 每个 test 用唯一 key (含 test 名 + sha 前缀)
    // 避免相互污染。

    fn unique_key(prefix: &str) -> String {
        format!(
            "{}-{}-{}",
            prefix,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        )
    }

    #[test]
    fn flight_key_format_stable() {
        assert_eq!(
            flight_key("abc", "https://api.example"),
            "abc|https://api.example"
        );
    }

    /// 端到端回归: 用一份**生产环境真实抓包的响应体**确认整条解析链路通。
    ///
    /// 通用 string-or-number / Option / 大整数 等 deserializer 行为已经在
    /// `jijing_serde::tests` 里覆盖, 这里只锁:
    /// - `ServerEnvelope<ServerFileUploadResponse>` 嵌套拼装能解
    /// - `#[serde(rename = "contentType")]` 没被改坏
    /// - `size` 字段确实套了 deserializer (没人手贱去掉)
    /// - 服务端额外的 `id` / `purpose` / `success` 顶级字段不破坏解析
    #[test]
    fn parses_real_production_upload_response() {
        let body = r#"{"code":200,"message":"操作成功","data":{"id":"file-2058649766147788801","url":"https://www.jjowo.com/uploads/media/input/1/20260525/c8c1fd40eb4843938736d24a803f54e8.mp4","sha256":"59c8411ae005d4f13877dce5365950f11b30e9a68085983ca86e8c8a029ad159","contentType":"video/mp4","size":"2050933","purpose":"media-input","cached":false},"success":true}"#;
        let env: ServerEnvelope<ServerFileUploadResponse> = serde_json::from_str(body).unwrap();
        assert_eq!(env.code, 200);
        let data = env.data.expect("data 存在");
        assert_eq!(data.size, 2_050_933);
        assert_eq!(data.content_type, "video/mp4");
        assert!(data.url.ends_with(".mp4"));
        assert!(!data.cached);
    }

    #[test]
    fn first_claim_is_leader_second_is_follower() {
        let k = unique_key("leader-follower");
        match claim_or_follow(&k) {
            FlightRole::Leader => {}
            FlightRole::Follower(_) => panic!("first call should be Leader"),
        }
        match claim_or_follow(&k) {
            FlightRole::Follower(_) => {}
            FlightRole::Leader => panic!("second call should be Follower"),
        }
        // 清理, 不影响后续测试
        let ok: Result<UploadResult, String> = Err("test cleanup".to_string());
        broadcast_and_release(&k, &ok);
        // 释放后又能成为新 leader
        match claim_or_follow(&k) {
            FlightRole::Leader => {}
            FlightRole::Follower(_) => panic!("after release first call should be Leader again"),
        }
        broadcast_and_release(&k, &ok);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn followers_receive_leader_broadcast() {
        let k = unique_key("broadcast-ok");

        // 先 claim 当 leader, 再 subscribe 几个 follower
        let _leader = claim_or_follow(&k);
        let mut rxs: Vec<_> = (0..3).map(|_| match claim_or_follow(&k) {
            FlightRole::Follower(rx) => rx,
            FlightRole::Leader => panic!("expected Follower"),
        }).collect();

        let result = Ok(UploadResult {
            url: "/uploads/x.png".to_string(),
            sha256: "deadbeef".to_string(),
            content_type: "image/png".to_string(),
            size: 42,
            cached: false,
        });
        broadcast_and_release(&k, &result);

        for rx in rxs.iter_mut() {
            let got = rx.recv().await.expect("follower should receive");
            assert_eq!(got.as_ref().unwrap().url, "/uploads/x.png");
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn followers_receive_leader_error_too() {
        let k = unique_key("broadcast-err");

        let _leader = claim_or_follow(&k);
        let mut rx = match claim_or_follow(&k) {
            FlightRole::Follower(r) => r,
            FlightRole::Leader => panic!("expected Follower"),
        };

        let err_result: Result<UploadResult, String> = Err("simulated network down".to_string());
        broadcast_and_release(&k, &err_result);

        let got = rx.recv().await.expect("follower should receive Err");
        assert!(got.is_err());
        assert!(got.unwrap_err().contains("network down"));
    }

    #[test]
    fn broadcast_release_removes_key_from_map() {
        let k = unique_key("release-cleanup");
        let _leader = claim_or_follow(&k);
        // 此时 key 应在 map 里
        assert!(in_flight_map().lock().unwrap().contains_key(&k));

        let r: Result<UploadResult, String> = Ok(UploadResult {
            url: "/x".into(), sha256: "x".into(),
            content_type: "image/png".into(), size: 1, cached: false,
        });
        broadcast_and_release(&k, &r);

        // 释放后 key 必须从 map 移除
        assert!(!in_flight_map().lock().unwrap().contains_key(&k));
    }

    /// **Patch B failure isolation 核心回归** —— follower 收到 leader Err 后
    /// 必须能重新 claim 成为新 leader, 而不是死等或返同样的 Err。
    ///
    /// 用 broadcast_and_release 释放 key 后再调 claim_or_follow 必须返 Leader,
    /// 这是 upload_to_server retry loop 的状态机基础。
    #[tokio::test(flavor = "multi_thread")]
    async fn follower_can_become_new_leader_after_previous_leader_failed() {
        let k = unique_key("isolation-retry");

        // A: 第一轮 — 注册为 Leader
        match claim_or_follow(&k) {
            FlightRole::Leader => {}
            _ => panic!("attempt 1 应当成为 Leader"),
        }

        // B: 同时进来当 Follower
        let mut rx = match claim_or_follow(&k) {
            FlightRole::Follower(r) => r,
            _ => panic!("attempt 2 应当成为 Follower"),
        };

        // A 上传失败, broadcast Err 并 release key
        let leader_err: Result<UploadResult, String> = Err("simulated network down".into());
        broadcast_and_release(&k, &leader_err);

        // B 收到 leader 的 Err
        let received = rx.recv().await.expect("follower 必须收到 broadcast");
        assert!(received.is_err());
        assert!(received.unwrap_err().contains("network down"));

        // 关键断言: 此时 key 已从 IN_FLIGHT 移除, B 再次 claim 必须成为新 Leader
        // (upload_to_server retry loop 内 continue 后会走到这一步)
        match claim_or_follow(&k) {
            FlightRole::Leader => {}
            FlightRole::Follower(_) => {
                panic!("follower 重试时必须能成为新 Leader, 否则永远拿不到上传结果");
            }
        }

        // 清理
        let cleanup: Result<UploadResult, String> = Err("test cleanup".into());
        broadcast_and_release(&k, &cleanup);
    }

    /// MAX_UPLOAD_ATTEMPTS 必须 ≥ 2,否则 failure isolation 形同虚设
    /// (follower 不会重新 claim,直接透传 leader 的 Err)。
    #[test]
    fn max_upload_attempts_allows_failover() {
        assert!(
            MAX_UPLOAD_ATTEMPTS >= 2,
            "MAX_UPLOAD_ATTEMPTS={} 必须 ≥ 2, 否则 follower 没有机会自己兜底当 leader",
            MAX_UPLOAD_ATTEMPTS
        );
    }
}
