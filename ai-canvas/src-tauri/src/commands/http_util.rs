//! 统一的 HTTP 发送入口与错误工具。
//!
//! 项目中所有对外的 reqwest 调用都应当经过 [`send_with_retry`]，
//! 由它统一负责：
//! - 把 `reqwest::Error` 的整条 cause 链 flatten 成一行可读字符串
//!   （[`root_cause_chain`]）。
//! - 自动识别"连接池里复用了对端已 RST 的僵尸连接"这类瞬时连接错误，
//!   并按"指数退避"重试若干次（[`is_transient_connect_error`]）。
//!
//! 不要在外面再手写 `request.send().await + 自己处理错误 + 自己重试`。

use std::error::Error as StdError;
use std::time::Duration;

/// 最多额外重试次数（首次 + N 次重试 = N+1 次尝试）。
/// 选 2：足以覆盖反代偶发抖动 + 自身连接池失效，又不至于让长任务等太久。
const MAX_RETRIES: u32 = 2;

/// 退避序列：第一次重试等 100ms，第二次等 500ms。
const RETRY_BACKOFFS_MS: [u64; MAX_RETRIES as usize] = [100, 500];

/// 把任意 `Error` 的 source 链拼成一行（去重相邻重复段），方便日志检索。
pub fn root_cause_chain(err: &dyn StdError) -> String {
    let mut chain: Vec<String> = Vec::new();
    let mut current: Option<&dyn StdError> = Some(err);
    while let Some(e) = current {
        let msg = e.to_string();
        if chain.last() != Some(&msg) {
            chain.push(msg);
        }
        current = e.source();
    }
    chain.join(" → ")
}

/// 判断是否是值得"重试一次"的瞬时连接错误。
///
/// 典型来源：反代/边缘节点（cloudflare、nginx 等）在 ~30s 主动关闭 idle 连接，
/// 但 reqwest 连接池里还保留着这条死连接，下一次请求复用它就会立刻失败：
/// - rustls：`unexpected EOF during handshake`
/// - 操作系统层：`connection reset` / `broken pipe`
/// - HTTP 层：`connection closed before message completed`
/// - Windows：`os error 10054 / 10053`
pub fn is_transient_connect_error(msg: &str) -> bool {
    let lower = msg.to_ascii_lowercase();
    lower.contains("unexpected eof during handshake")
        || lower.contains("connection reset")
        || lower.contains("broken pipe")
        || lower.contains("connection closed before message completed")
        || lower.contains("os error 10054") // WSAECONNRESET
        || lower.contains("os error 10053") // WSAECONNABORTED
}

/// 项目内**唯一**的 HTTP 发送入口。
///
/// `build` 必须可重入：`RequestBuilder::send()` 会消费 self，
/// 每次尝试都需要重新构造一个新的 RequestBuilder。
///
/// 返回值是 `reqwest::Response`，由调用方负责后续的 `.text()` / `.json()` /
/// `.chunk()` 等流式读取（chunk 读取过程中的瞬时错误不在此处理）。
///
/// 错误格式统一为：`请求失败: url={url}, {root_cause_chain}`。
///
/// 重试策略：
/// - 命中 [`is_transient_connect_error`] 的错误才会重试，其它错误立刻返回；
/// - 总共最多 `MAX_RETRIES + 1` 次尝试，相邻尝试之间按 [`RETRY_BACKOFFS_MS`] 退避。
pub async fn send_with_retry<F>(
    build: F,
    log_tag: &str,
    url: &str,
) -> Result<reqwest::Response, String>
where
    F: Fn() -> reqwest::RequestBuilder,
{
    let mut last_err = String::new();
    for attempt in 0..=MAX_RETRIES {
        if attempt > 0 {
            let wait_ms = RETRY_BACKOFFS_MS[(attempt - 1) as usize];
            tokio::time::sleep(Duration::from_millis(wait_ms)).await;
        }

        match build().send().await {
            Ok(r) => {
                if attempt > 0 {
                    tracing::info!(
                        "[{}] request succeeded after retry attempt={}/{}: url={}",
                        log_tag, attempt + 1, MAX_RETRIES + 1, url
                    );
                }
                return Ok(r);
            }
            Err(e) => {
                let root = root_cause_chain(&e);
                if !is_transient_connect_error(&root) {
                    // 非瞬时错误（404/Auth/解析等）立即返回，不要浪费时间重试
                    return Err(format!("请求失败: url={}, {}", url, root));
                }
                if attempt < MAX_RETRIES {
                    tracing::warn!(
                        "[{}] transient connect error, will retry: attempt={}/{}, url={}, {}",
                        log_tag, attempt + 1, MAX_RETRIES + 1, url, root
                    );
                } else {
                    tracing::error!(
                        "[{}] transient connect error, all {} attempts exhausted: url={}, {}",
                        log_tag, MAX_RETRIES + 1, url, root
                    );
                }
                last_err = root;
            }
        }
    }
    Err(format!("请求失败: url={}, {}", url, last_err))
}

/// 流式读完整 response body 到 `Vec<u8>`,边读边按 `max_bytes` 上限守门。
/// **绝对不要**直接 `resp.bytes().await` —— 那是 unbounded,上游返几 GB
/// 直接 OOM。本函数边收 chunk 边累计、超过即 abort,内存峰值受控。
///
/// 提前看 Content-Length 短路:上游声明就已超限,根本不 alloc buffer。
/// (Content-Length 可能撒谎,真实 size 还会再校验。)
///
/// `max_bytes` 不同场景不同:
///   - `ai_proxy` / `do_stream` 错误体 → `HTTP_RESPONSE_BODY_READ_HARD_LIMIT_BYTES`(32MB)
///   - `save_media` 远程下载 → `MEDIA_TRANSFER_TOTAL_HARD_LIMIT_BYTES`(500MB)
pub async fn read_body_bounded_bytes(
    mut resp: reqwest::Response,
    log_tag: &str,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    if let Some(len) = resp.content_length() {
        if (len as usize) > max_bytes {
            return Err(format!(
                "[{}] 上游声明 Content-Length {} bytes 超过 {} MB 上限,拒绝读取",
                log_tag,
                len,
                max_bytes / (1024 * 1024)
            ));
        }
    }

    let mut total: usize = 0;
    let mut buf: Vec<u8> = Vec::with_capacity(8 * 1024);
    loop {
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                total = total.saturating_add(chunk.len());
                if total > max_bytes {
                    return Err(format!(
                        "[{}] 上游响应体超过 {} MB 安全读取上限,已中断",
                        log_tag,
                        max_bytes / (1024 * 1024)
                    ));
                }
                buf.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(e) => {
                let root = root_cause_chain(&e);
                return Err(format!("[{}] 读取响应失败: {}", log_tag, root));
            }
        }
    }
    Ok(buf)
}

/// 文本 response body 的便捷包装 —— 用 `HTTP_RESPONSE_BODY_READ_HARD_LIMIT_BYTES`
/// 作为上限,UTF-8 非法字节走 lossy 兜底(provider 偶发返 latin-1 不该让整个请求 fail)。
///
/// 项目内**唯一**的"读 API response body"入口,代替 `resp.text().await`。
pub async fn read_body_bounded(
    resp: reqwest::Response,
    log_tag: &str,
) -> Result<String, String> {
    let bytes = read_body_bounded_bytes(
        resp,
        log_tag,
        super::ipc_limits::HTTP_RESPONSE_BODY_READ_HARD_LIMIT_BYTES,
    )
    .await?;

    match String::from_utf8(bytes) {
        Ok(s) => Ok(s),
        Err(e) => {
            let bytes = e.into_bytes();
            tracing::warn!(
                "[{}] response body contains non-UTF-8 bytes, falling back to lossy decode ({} bytes)",
                log_tag,
                bytes.len()
            );
            Ok(String::from_utf8_lossy(&bytes).into_owned())
        }
    }
}
