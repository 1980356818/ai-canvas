use serde::Deserialize;

/// 前端日志写入命令。WebView 渲染进程出错（unhandledrejection、global error、
/// ErrorBoundary 兜底等）时调这里，把消息写到 Rust 的 tracing 管道里，
/// 落到 `<data_dir>/logs/app.log.YYYY-MM-DD`。
///
/// 渲染进程崩了主进程不会跟着死，所以这条记录是 post-mortem 唯一线索。
#[derive(Deserialize)]
pub struct JsLogPayload {
    pub level: String,
    pub source: String,
    pub message: String,
    #[serde(default)]
    pub stack: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub line: Option<u32>,
    #[serde(default)]
    pub column: Option<u32>,
    #[serde(default)]
    pub extra: Option<serde_json::Value>,
}

#[tauri::command]
pub fn js_log(payload: JsLogPayload) -> Result<(), String> {
    let JsLogPayload {
        level,
        source,
        message,
        stack,
        url,
        line,
        column,
        extra,
    } = payload;

    let location = match (url.as_deref(), line, column) {
        (Some(u), Some(l), Some(c)) => format!(" at {}:{}:{}", u, l, c),
        (Some(u), Some(l), None) => format!(" at {}:{}", u, l),
        (Some(u), _, _) => format!(" at {}", u),
        _ => String::new(),
    };

    let stack_str = stack
        .map(|s| format!("\nstack: {}", s))
        .unwrap_or_default();
    let extra_str = extra
        .map(|v| format!(" extra={}", v))
        .unwrap_or_default();

    let line_msg = format!(
        "[js:{}]{} {}{}{}",
        source, location, message, extra_str, stack_str
    );

    match level.as_str() {
        "error" => tracing::error!("{}", line_msg),
        "warn" => tracing::warn!("{}", line_msg),
        "info" => tracing::info!("{}", line_msg),
        _ => tracing::debug!("{}", line_msg),
    }

    Ok(())
}
