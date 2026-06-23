//! 通用上行 HTTP 命令 —— 前端**唯一**直连任意远程域名的合规入口。
//!
//! ## 跟其他上行 command 的区别
//!
//! - [`super::ai`](super::ai)::`ai_proxy` / `ai_proxy_stream`: AI provider 绑定,
//!   endpoint 必须相对于 provider base_url, 自动注入 key rotation + auth header。
//!   适合所有 AI 模型 API 调用 (chat / images / videos / models 列表 / 任务轮询)。
//!
//! - [`super::upload_remote`](super::upload_remote)::`upload_to_server` /
//!   `upload_bytes_to_server`: 媒体文件上传专用, multipart + sha256 缓存 +
//!   in-flight 单飞 + 双 semaphore 治理。**不要**用本 command 上传文件,
//!   除非你愿意放弃缓存和并发治理。
//!
//! - **本模块** ([`http_request`]): JSON / text 上行的通用兜底, **不绑定** provider,
//!   接受任意完整 URL + 任意 method + 任意 headers + 任意 body。用于平台账号 API
//!   (`http://101.37.80.236/api/auth/*`)、版本列表 (`/api/update/list/*`) 等
//!   非 AI 调用,以及未来任何需要"前端把 HTTP 请求发到远程域名"的场景。
//!
//! ## 为什么 WebView 不直接 fetch
//!
//! 历史教训 (2026-05-30 CORS 事件):
//!   `media.ts::uploadViaFetch` 在 Tauri **dev** 模式下用浏览器原生 `fetch`
//!   调 `https://api.jjowo.com/v1/files/upload`。WebView origin 是
//!   `http://127.0.0.1:1620` (vite), 服务端 CORS allowlist 不包含这个 origin
//!   → preflight 失败, 上传全挂。生产用 `tauri://localhost` 凑巧匹配, 所以 prod
//!   不复现, dev 一跑就炸。
//!
//! 根治: 一切上行走 Rust HTTP 客户端, WebView 永远不发跨域请求。CORS / cookie /
//!   referer / 代理链等浏览器层的复杂性, 在 Tauri 桌面端**不应该存在**。
//!
//! ## 安全约束
//!
//! - 调用方必须提供完整 URL (含 scheme + host)。
//! - 拒绝 `file://` / `data:` / `javascript:` 等非 HTTP scheme。
//! - 响应体走 [`http_util::read_body_bounded_bytes`] 守门,
//!   防止上游恶意返回 GB 级 body 把进程 OOM。
//! - **不维护** cookie jar / session —— 调用方在 headers 里自己塞 Authorization。
//!   这是有意为之: 让 HTTP 调用变成无状态、可审计、可重放的纯函数。
//!
//! ## 返回值
//!
//! [`HttpResponse`] 包含 status / body / headers (lowercase-key)。前端拿到后
//! 自己 `JSON.parse(body)` 处理 —— 不在 Rust 侧解 JSON, 因为本 command 不知道
//! 调用方期望什么 schema。

use std::collections::HashMap;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::AppState;
use super::http_util::{read_body_bounded_bytes, send_with_retry};
use super::ipc_limits::HTTP_RESPONSE_BODY_READ_HARD_LIMIT_BYTES;

/// 前端可调用的 HTTP method。限定枚举防止误用 (`TRACE` / `CONNECT` 等)。
fn parse_method(s: &str) -> Result<reqwest::Method, String> {
    match s.to_ascii_uppercase().as_str() {
        "GET" => Ok(reqwest::Method::GET),
        "POST" => Ok(reqwest::Method::POST),
        "PUT" => Ok(reqwest::Method::PUT),
        "DELETE" => Ok(reqwest::Method::DELETE),
        "PATCH" => Ok(reqwest::Method::PATCH),
        "HEAD" => Ok(reqwest::Method::HEAD),
        other => Err(format!("不支持的 HTTP method: {}", other)),
    }
}

/// 校验 URL: 必须是 http / https, 不允许 file:// data: 等。
fn validate_url(url: &str) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        Ok(())
    } else {
        Err(format!(
            "URL 必须以 http:// 或 https:// 开头: {}",
            truncate_for_log(url, 200)
        ))
    }
}

fn truncate_for_log(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…", &s[..max])
    }
}

/// 前端塞 body 的形态: 字符串原样发, JSON 值自动序列化。
/// 二进制上传走 [`super::upload_remote::upload_bytes_to_server`], 不走本 command。
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum HttpRequestBody {
    Text(String),
    Json(serde_json::Value),
}

impl HttpRequestBody {
    fn into_bytes(self) -> Result<(Vec<u8>, Option<&'static str>), String> {
        match self {
            HttpRequestBody::Text(s) => Ok((s.into_bytes(), None)),
            HttpRequestBody::Json(v) => {
                let s = serde_json::to_string(&v)
                    .map_err(|e| format!("序列化 body 失败: {}", e))?;
                Ok((s.into_bytes(), Some("application/json")))
            }
        }
    }
}

/// HTTP 响应 —— body 走文本兜底 (lossy UTF-8), 前端拿到自己解 JSON。
#[derive(Debug, Serialize)]
pub struct HttpResponse {
    /// HTTP 状态码 (200/404/500/...)
    pub status: u16,
    /// 响应体文本 (UTF-8 lossy)
    pub body: String,
    /// 响应头, key 小写, value 多个时取第一个 (Set-Cookie 等极少数 multi-value
    /// 场景丢精度 —— 本 command 不为 cookie 服务, 这是设计取舍)。
    pub headers: HashMap<String, String>,
}

/// 通用上行 HTTP, 替代浏览器原生 `fetch`。
///
/// 前端约定:
/// - 调 AI provider API → 走 `ai_proxy` (会做 key rotation)
/// - 上传媒体 → 走 `upload_to_server` / `upload_bytes_to_server` (有缓存)
/// - 其他一切上行 → 走本 command (auth / update / 任意外部 REST)
///
/// **请勿**在前端继续保留 `fetch(absoluteUrl)`, 即便代码看起来"能跑通" ——
/// 浏览器 CORS / cookie / referer / mixed-content 这些坑全部在 dev/prod
/// 不同行为, 走 Rust 客户端是规范化的唯一答案。
#[tauri::command]
pub async fn http_request(
    state: State<'_, AppState>,
    url: String,
    method: Option<String>,
    body: Option<HttpRequestBody>,
    headers: Option<HashMap<String, String>>,
) -> Result<HttpResponse, String> {
    validate_url(&url)?;
    let method = parse_method(method.as_deref().unwrap_or("GET"))?;
    let log_tag = format!("http_request:{}", method);
    let started = Instant::now();

    let (body_bytes_opt, auto_ct) = match body {
        Some(b) => {
            let (bytes, ct) = b.into_bytes()?;
            (Some(bytes), ct)
        }
        None => (None, None),
    };

    let client = state.http_client();
    let custom_headers = headers.unwrap_or_default();

    // 大小写不敏感判断调用方是否自定义了 Content-Type, 避免我们再塞 application/json 覆盖。
    let caller_set_content_type = custom_headers
        .keys()
        .any(|k| k.eq_ignore_ascii_case("content-type"));

    let resp = send_with_retry(
        || {
            let mut builder = client.request(method.clone(), &url);
            // headers 先塞调用方的, Content-Type 自动兜底放在最后保留调用方优先级。
            for (k, v) in &custom_headers {
                builder = builder.header(k, v);
            }
            if let Some(ct) = auto_ct {
                if !caller_set_content_type {
                    builder = builder.header("Content-Type", ct);
                }
            }
            if let Some(bytes) = body_bytes_opt.as_ref() {
                builder = builder.body(bytes.clone());
            }
            builder
        },
        &log_tag,
        &url,
    )
    .await?;

    let status = resp.status().as_u16();
    let mut header_map: HashMap<String, String> = HashMap::new();
    for (k, v) in resp.headers().iter() {
        let key = k.as_str().to_ascii_lowercase();
        if let Ok(value) = v.to_str() {
            // 多值同 key 时 HashMap 自然取最后一个 —— 对本 command 的用户够用。
            header_map.insert(key, value.to_string());
        }
    }

    let body_bytes = read_body_bounded_bytes(
        resp,
        &log_tag,
        HTTP_RESPONSE_BODY_READ_HARD_LIMIT_BYTES,
    )
    .await?;
    let body = match String::from_utf8(body_bytes) {
        Ok(s) => s,
        Err(e) => String::from_utf8_lossy(&e.into_bytes()).into_owned(),
    };

    tracing::info!(
        "[{}] {} status={} body_bytes={} elapsed_ms={}",
        log_tag,
        truncate_for_log(&url, 200),
        status,
        body.len(),
        started.elapsed().as_millis()
    );

    Ok(HttpResponse {
        status,
        body,
        headers: header_map,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_url_accepts_http_and_https() {
        assert!(validate_url("http://example.com").is_ok());
        assert!(validate_url("https://api.example.com/v1/x").is_ok());
        assert!(validate_url("HTTPS://Example.com").is_ok()); // 大小写不敏感
    }

    #[test]
    fn validate_url_rejects_non_http_schemes() {
        for bad in [
            "file:///etc/passwd",
            "data:text/plain,hi",
            "javascript:alert(1)",
            "ftp://x",
            "/relative/path",
            "",
        ] {
            let r = validate_url(bad);
            assert!(r.is_err(), "应当拒绝: {}", bad);
        }
    }

    #[test]
    fn parse_method_known_verbs() {
        assert_eq!(parse_method("GET").unwrap(), reqwest::Method::GET);
        assert_eq!(parse_method("post").unwrap(), reqwest::Method::POST);
        assert_eq!(parse_method("Put").unwrap(), reqwest::Method::PUT);
        assert_eq!(parse_method("DELETE").unwrap(), reqwest::Method::DELETE);
        assert_eq!(parse_method("PATCH").unwrap(), reqwest::Method::PATCH);
        assert_eq!(parse_method("HEAD").unwrap(), reqwest::Method::HEAD);
    }

    #[test]
    fn parse_method_rejects_unknown() {
        assert!(parse_method("CONNECT").is_err());
        assert!(parse_method("TRACE").is_err());
        assert!(parse_method("").is_err());
    }

    #[test]
    fn body_text_keeps_caller_content_type() {
        let b = HttpRequestBody::Text("raw=1".to_string());
        let (bytes, auto_ct) = b.into_bytes().unwrap();
        assert_eq!(bytes, b"raw=1");
        assert!(auto_ct.is_none(), "text body 不应自动塞 Content-Type");
    }

    #[test]
    fn body_json_implies_application_json() {
        let b = HttpRequestBody::Json(serde_json::json!({"a": 1}));
        let (bytes, auto_ct) = b.into_bytes().unwrap();
        assert_eq!(auto_ct, Some("application/json"));
        let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(parsed["a"], 1);
    }

    #[test]
    fn url_log_truncation_keeps_under_limit() {
        let long = "https://example.com/".to_string() + &"x".repeat(500);
        let truncated = truncate_for_log(&long, 100);
        assert!(truncated.ends_with('…'));
        assert!(truncated.chars().count() <= 101); // 100 char + '…'
    }
}
