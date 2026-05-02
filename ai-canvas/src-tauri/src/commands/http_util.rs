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
