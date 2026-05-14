use crate::AppState;
use super::config::{provider_display_name, read_full_api_config, apply_auth_headers, normalize_base_url, filter_keys_by_tag};
use super::http_util::send_with_retry;
use tauri::State;

fn resolve_provider(provider: Option<String>) -> String {
    provider.unwrap_or_else(|| "comfly".to_string())
}

fn resolve_first_key(state: &State<'_, AppState>, provider: &str) -> Result<String, String> {
    resolve_first_key_with_tag(state, provider, None)
}

fn resolve_first_key_with_tag(
    state: &State<'_, AppState>,
    provider: &str,
    key_tag: Option<&str>,
) -> Result<String, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let full = read_full_api_config(&db, provider)?;
    let filtered = filter_keys_by_tag(full.keys, key_tag);
    match filtered.first() {
        Some(first) => Ok(first.key.clone()),
        None => {
            let tag_label = key_tag.map(|t| match t {
                "gemini_premium" => "Gemini 优质",
                _ => "普通默认",
            }).unwrap_or("");
            if tag_label.is_empty() {
                Err(format!(
                    "Provider '{}' 的 API Key 未配置，请在设置中填写",
                    provider_display_name(provider)
                ))
            } else {
                Err(format!(
                    "Provider '{}' 的「{}」槽位未配置 API Key，请在设置中填写",
                    provider_display_name(provider), tag_label
                ))
            }
        }
    }
}

fn resolve_base_url(state: &State<'_, AppState>, provider: &str) -> Result<String, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let full = read_full_api_config(&db, provider)?;
    Ok(full.base_url)
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
    let client = state.http_client();
    let resp = send_with_retry(
        || apply_auth_headers(client.get(&url), &p, &api_key),
        "gateway:list_models",
        &url,
    )
    .await?;

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
    key_tag: Option<String>,
) -> Result<serde_json::Value, String> {
    let p = resolve_provider(provider);
    let api_key = resolve_first_key_with_tag(&state, &p, key_tag.as_deref())?;
    let base_url = resolve_base_url(&state, &p)?;

    let path = endpoint
        .unwrap_or_else(|| format!("/v1/tasks/{}", task_id))
        .replace("{task_id}", &task_id);
    let url = format!(
        "{}{}",
        base_url.trim_end_matches('/'),
        path
    );
    let client = state.http_client();
    let resp = send_with_retry(
        || apply_auth_headers(client.get(&url), &p, &api_key),
        "gateway:poll_task",
        &url,
    )
    .await?;

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
///
/// `api_key` / `base_url` 用于让设置面板传"当前表单值"，无需先保存即可测试；
/// 缺省时回退到数据库已保存的配置。
#[tauri::command]
pub async fn validate_connection(
    state: State<'_, AppState>,
    provider: Option<String>,
    api_key: Option<String>,
    base_url: Option<String>,
    key_tag: Option<String>,
) -> Result<bool, String> {
    let p = resolve_provider(provider);

    let key = match api_key.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        Some(k) => k,
        None => resolve_first_key_with_tag(&state, &p, key_tag.as_deref())?,
    };

    if key.is_empty() {
        return Err(format!(
            "Provider '{}' 的 API Key 未配置，请在设置中填写",
            provider_display_name(&p)
        ));
    }

    let key_len = key.len();
    let key_preview = if key_len > 8 {
        format!("{}...{}", &key[..4], &key[key_len-4..])
    } else {
        "****".to_string()
    };
    let resolved_base = match base_url.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        Some(u) => normalize_base_url(&u),
        None => resolve_base_url(&state, &p)?,
    };
    let base = resolved_base.trim_end_matches('/');

    if base.is_empty() {
        return Err("API 地址未配置，请在设置中填写 Base URL".to_string());
    }
    if !base.starts_with("http://") && !base.starts_with("https://") {
        return Err(format!("API 地址格式不正确（缺少 http:// 或 https://）: {}", base));
    }

    tracing::info!("validate_connection [{}]: base_url={}, key_len={}, key_preview={}", p, base, key_len, key_preview);

    let client = state.http_client();

    // Try /v1/models first
    let models_url = format!("{}/v1/models", base);
    let models_status = match send_with_retry(
        || apply_auth_headers(client.get(&models_url), &p, &key),
        "gateway:validate_models",
        &models_url,
    )
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

    let chat_resp = send_with_retry(
        || apply_auth_headers(
            client.post(&chat_url)
                .header("Content-Type", "application/json")
                .json(&chat_body),
            &p,
            &key,
        ),
        "gateway:validate_chat",
        &chat_url,
    )
    .await
    .map_err(|e| {
        tracing::error!("validate_connection [{}]: connect failed: {}", p, e);
        e
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
