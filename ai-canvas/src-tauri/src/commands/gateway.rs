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

/// Validate the API connection by making a lightweight request to /v1/models.
/// Returns true on success; returns an error string on failure.
#[tauri::command]
pub async fn validate_connection(
    state: State<'_, AppState>,
) -> Result<bool, String> {
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
        .map_err(|e| format!("连接失败: {}", e))?;

    if resp.status().is_success() {
        Ok(true)
    } else {
        let status = resp.status().as_u16();
        Err(match status {
            401 => "API Key 无效或已过期".to_string(),
            403 => "API Key 缺少所需权限".to_string(),
            _ => format!("服务器返回错误 (HTTP {})", status),
        })
    }
}
