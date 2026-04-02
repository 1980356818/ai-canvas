use crate::AppState;
use super::config::read_api_config;
use tauri::State;

/// Fetch available models from the gateway's /v1/models endpoint.
#[tauri::command]
pub async fn list_models(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let config = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        read_api_config(&db, "openai")?
    };

    let url = format!("{}/v1/models", config.base_url.trim_end_matches('/'));
    let resp = state
        .http_client
        .get(&url)
        .header("Authorization", format!("Bearer {}", config.api_key))
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

/// Poll a task's current status and result from /v1/tasks/{taskId}.
#[tauri::command]
pub async fn poll_task(
    state: State<'_, AppState>,
    task_id: i64,
) -> Result<serde_json::Value, String> {
    let config = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        read_api_config(&db, "openai")?
    };

    let url = format!(
        "{}/v1/tasks/{}",
        config.base_url.trim_end_matches('/'),
        task_id
    );
    let resp = state
        .http_client
        .get(&url)
        .header("Authorization", format!("Bearer {}", config.api_key))
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

/// Validate the API connection by trying /v1/models first, then falling back
/// to a minimal /v1/chat/completions call for providers that don't support /v1/models.
#[tauri::command]
pub async fn validate_connection(
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let config = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        read_api_config(&db, "openai")?
    };

    let base = config.base_url.trim_end_matches('/');

    let models_url = format!("{}/v1/models", base);
    let resp = state
        .http_client
        .get(&models_url)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .send()
        .await
        .map_err(|e| format!("连接失败: {}", e))?;

    let status = resp.status().as_u16();
    if resp.status().is_success() {
        return Ok(true);
    }

    if status == 401 {
        return Err("API Key 无效或已过期".to_string());
    }
    if status == 403 {
        return Err("API Key 缺少所需权限".to_string());
    }

    // /v1/models may not be supported; try a minimal chat completions call
    let chat_url = format!("{}/v1/chat/completions", base);
    let chat_body = serde_json::json!({
        "model": "gpt-4o-mini",
        "messages": [{"role": "user", "content": "hi"}],
        "max_tokens": 1,
    });

    let chat_resp = state
        .http_client
        .post(&chat_url)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .header("Content-Type", "application/json")
        .json(&chat_body)
        .send()
        .await
        .map_err(|e| format!("连接失败: {}", e))?;

    let chat_status = chat_resp.status().as_u16();
    if chat_resp.status().is_success() || chat_status == 200 {
        return Ok(true);
    }
    match chat_status {
        401 => Err("API Key 无效或已过期".to_string()),
        403 => Err("API Key 缺少所需权限".to_string()),
        _ => Err(format!("服务器返回错误 (HTTP {})", chat_status)),
    }
}
