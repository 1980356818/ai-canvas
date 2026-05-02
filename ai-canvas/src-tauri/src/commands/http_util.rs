//! 统一的 HTTP 发送入口与错误工具。
//!
//! 项目中所有对外的 reqwest 调用都应当经过 [`send_with_retry`]，
//! 由它统一负责：
//! - 把 `reqwest::Error` 的整条 cause 链 flatten 成一行可读字符串
//!   （[`root_cause_chain`]）。
//! - 自动识别"连接池里复用了对端已 RST 的僵尸连接"这类瞬时连接错误，
//!   并立即用全新连接重试一次（[`is_transient_connect_error`]）。
//!
//! 不要在外面再手写 `request.send().await + 自己处理错误 + 自己重试`。

use std::error::Error as StdError;

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
/// 重试时需要重新构造一个新的 RequestBuilder。
///
/// 返回值是 `reqwest::Response`，由调用方负责后续的 `.text()` / `.json()` /
/// `.chunk()` 等流式读取（chunk 读取过程中的瞬时错误不在此处理）。
///
/// 错误格式统一为：`请求失败: url={url}, {root_cause_chain}`。
pub async fn send_with_retry<F>(
    build: F,
    log_tag: &str,
    url: &str,
) -> Result<reqwest::Response, String>
where
    F: Fn() -> reqwest::RequestBuilder,
{
    match build().send().await {
        Ok(r) => Ok(r),
        Err(e) => {
            let root = root_cause_chain(&e);
            if is_transient_connect_error(&root) {
                tracing::warn!(
                    "[{}] transient connect error, retrying once: url={}, {}",
                    log_tag, url, root
                );
                build().send().await.map_err(|e2| {
                    let root2 = root_cause_chain(&e2);
                    format!("请求失败: url={}, {}", url, root2)
                })
            } else {
                Err(format!("请求失败: url={}, {}", url, root))
            }
        }
    }
}
