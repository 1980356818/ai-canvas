use crate::AppState;
use super::config::{read_api_config, read_full_api_config};
use std::error::Error as StdError;
use tauri::State;

fn resolve_provider(provider: Option<String>) -> String {
    provider.unwrap_or_else(|| "comfly".to_string())
}

fn resolve_first_key(state: &State<'_, AppState>, provider: &str) -> Result<String, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let full = read_full_api_config(&db, provider)?;
    if let Some(first) = full.keys.first() {
        return Ok(first.key.clone());
    }
    let config = read_api_config(&db, provider)?;
    Ok(config.api_key)
}

fn resolve_base_url(state: &State<'_, AppState>, provider: &str) -> Result<String, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let full = read_full_api_config(&db, provider)?;
    Ok(full.base_url)
}

fn format_reqwest_error(e: &reqwest::Error) -> String {
    let mut parts = Vec::new();
    if e.is_connect() { parts.push("connection"); }
    if e.is_timeout() { parts.push("timeout"); }

    let mut cause_chain = String::new();
    let mut current: Option<&dyn StdError> = Some(e);
    while let Some(c) = current {
        let msg = c.to_string();
        if !cause_chain.contains(&msg) {
            if !cause_chain.is_empty() { cause_chain.push_str(" → "); }
            cause_chain.push_str(&msg);
        }
        current = c.source();
    }

    if parts.is_empty() {
        cause_chain
    } else {
        format!("[{}] {}", parts.join("+"), cause_chain)
    }
}

/// Fetch available models from the gateway's /v1/models endpoint.
#[tauri::command]
pub async fn list_models(
    state: State<'_, AppState>,
    provider: Option<String>,
) -> Result<serde_json::Value, String> {
    let p = resolve_provider(provider);
    let api_key = resolve_first_key(&state, &p)?;
    let base_url = resolve_base_url(&state, &p)?;

    let url = format!("{}/v1/models", base_url.trim_end_matches('/'));
    let resp = state
        .http_client()
        .get(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .send()
        .await
        .map_err(|e| format!("请求模型列表失败: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("获取模型列表失败 (HTTP {}): {}", status, body));
    }

    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("解析模型列表失败: {}", e))
}

/// Poll a task's current status and result.
/// Uses the active key (the task was likely started with it).
#[tauri::command]
pub async fn poll_task(
    state: State<'_, AppState>,
    task_id: String,
    endpoint: Option<String>,
    provider: Option<String>,
) -> Result<serde_json::Value, String> {
    let p = resolve_provider(provider);
    let api_key = resolve_first_key(&state, &p)?;
    let base_url = resolve_base_url(&state, &p)?;

    let path = endpoint
        .unwrap_or_else(|| format!("/v1/tasks/{}", task_id))
        .replace("{task_id}", &task_id);
    let url = format!(
        "{}{}",
        base_url.trim_end_matches('/'),
        path
    );
    let resp = state
        .http_client()
        .get(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .send()
        .await
        .map_err(|e| format!("查询任务状态失败: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("查询任务失败 (HTTP {}): {}", status, body));
    }

    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("解析任务状态失败: {}", e))
}

/// Validate the API connection by trying /v1/models first, then always falling
/// back to /v1/chat/completions. Many third-party providers return 401/403/404
/// on /v1/models even with a valid key, so we must always attempt the fallback.
#[tauri::command]
pub async fn validate_connection(
    state: State<'_, AppState>,
    provider: Option<String>,
) -> Result<bool, String> {
    let p = resolve_provider(provider);
    let key = resolve_first_key(&state, &p)?;

    if key.is_empty() {
        return Err("API Key 未配置，请在设置中填写".to_string());
    }

    let key_len = key.len();
    let key_preview = if key_len > 8 {
        format!("{}...{}", &key[..4], &key[key_len-4..])
    } else {
        "****".to_string()
    };
    let base_url = resolve_base_url(&state, &p)?;
    let base = base_url.trim_end_matches('/');

    if base.is_empty() {
        return Err("API 地址未配置，请在设置中填写 Base URL".to_string());
    }
    if !base.starts_with("http://") && !base.starts_with("https://") {
        return Err(format!("API 地址格式不正确（缺少 http:// 或 https://）: {}", base));
    }

    tracing::info!("validate_connection [{}]: base_url={}, key_len={}, key_preview={}", p, base, key_len, key_preview);

    // Try /v1/models first
    let models_url = format!("{}/v1/models", base);
    let models_status = match state
        .http_client()
        .get(&models_url)
        .header("Authorization", format!("Bearer {}", key))
        .send()
        .await
    {
        Ok(resp) => {
            let st = resp.status().as_u16();
            tracing::info!("validate_connection [{}]: /v1/models -> {}", p, st);
            if resp.status().is_success() {
                return Ok(true);
            }
            st
        }
        Err(e) => {
            tracing::warn!("validate_connection [{}]: /v1/models failed: {}", p, e);
            0
        }
    };

    // /v1/models failed — always try /v1/chat/completions as fallback
    let chat_url = format!("{}/v1/chat/completions", base);
    let chat_body = serde_json::json!({
        "model": "gpt-4o-mini",
        "messages": [{"role": "user", "content": "hi"}],
        "max_tokens": 1,
    });

    let chat_resp = state
        .http_client()
        .post(&chat_url)
        .header("Authorization", format!("Bearer {}", key))
        .header("Content-Type", "application/json")
        .json(&chat_body)
        .send()
        .await
        .map_err(|e| {
            let detail = format_reqwest_error(&e);
            tracing::error!("validate_connection [{}]: connect failed: {}", p, detail);
            format!("连接失败: url={}, {}", chat_url, detail)
        })?;

    let chat_status = chat_resp.status().as_u16();
    let chat_body_text = chat_resp.text().await.unwrap_or_default();
    tracing::info!("validate_connection [{}]: /v1/chat/completions -> {} body={}", p, chat_status, &chat_body_text[..chat_body_text.len().min(200)]);

    // 200 = success; 400/404 likely means model not found but auth passed
    if chat_status == 200 || chat_status == 400 || chat_status == 404 {
        return Ok(true);
    }

    tracing::warn!("validate_connection [{}]: both failed, models={}, chat={}", p, models_status, chat_status);
    match chat_status {
        401 => Err("API Key 无效或已过期，请检查 Key 是否正确或是否已到期".to_string()),
        402 => Err("账户余额不足，请充值后重试".to_string()),
        403 => Err("API Key 缺少所需权限，请联系服务商确认".to_string()),
        429 => Err("请求过于频繁，请稍后再试".to_string()),
        _ => Err(format!("服务器返回错误 (HTTP {})，请检查服务器地址是否正确", chat_status)),
    }
}
