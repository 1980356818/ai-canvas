use rusqlite::Connection;

pub struct ApiConfig {
    pub api_key: String,
    pub base_url: String,
}

pub fn read_api_config(db: &Connection, provider: &str) -> Result<ApiConfig, String> {
    let key_setting = format!("{}_api_key", provider);
    let url_setting = format!("{}_base_url", provider);

    let api_key: String = db
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            rusqlite::params![key_setting],
            |row| row.get(0),
        )
        .map_err(|_| {
            format!(
                "Provider '{}' 的 API Key 未配置，请在设置中填写",
                provider
            )
        })?;

    let raw_url = db
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            rusqlite::params![url_setting],
            |row| row.get::<_, String>(0),
        )
        .unwrap_or_else(|_| default_base_url(provider));

    let base_url = normalize_base_url(&raw_url);
    Ok(ApiConfig { api_key: api_key.trim().to_string(), base_url })
}

fn default_base_url(provider: &str) -> String {
    match provider {
        "openai" => "https://ai.comfly.chat".to_string(),
        "anthropic" => "https://api.anthropic.com".to_string(),
        _ => String::new(),
    }
}

fn normalize_base_url(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    let trimmed = trimmed.strip_suffix("/v1").unwrap_or(trimmed);
    trimmed.trim_end_matches('/').to_string()
}
