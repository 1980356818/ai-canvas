use rusqlite::Connection;
use serde::Deserialize;

pub struct ApiConfig {
    pub api_key: String,
    pub base_url: String,
}

#[derive(Deserialize, Clone, Debug)]
pub struct KeyEntry {
    pub id: String,
    pub name: String,
    pub key: String,
}

pub struct FullApiConfig {
    pub keys: Vec<KeyEntry>,
    #[allow(dead_code)]
    pub active_key_id: String,
    pub base_url: String,
    pub auto_rotate: bool,
}

fn get_setting(db: &Connection, key: &str) -> Option<String> {
    db.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        rusqlite::params![key],
        |row| row.get::<_, String>(0),
    )
    .ok()
}

fn set_setting(db: &Connection, key: &str, value: &str) -> Result<(), String> {
    db.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
        rusqlite::params![key, value],
    )
    .map_err(|e| format!("写入设置失败: {}", e))?;
    Ok(())
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

pub fn read_full_api_config(db: &Connection, provider: &str) -> Result<FullApiConfig, String> {
    let keys_json = get_setting(db, &format!("{}_api_keys", provider));
    let active_id = get_setting(db, &format!("{}_active_key_id", provider)).unwrap_or_default();
    let legacy_key = if provider == "comfly" {
        get_setting(db, "openai_api_key")
    } else {
        get_setting(db, &format!("{}_api_key", provider))
    };
    let raw_url = get_setting(db, &format!("{}_base_url", provider));
    let legacy_url = if provider == "comfly" {
        get_setting(db, "openai_base_url")
    } else {
        None
    };
    let auto_rotate_str = get_setting(db, &format!("{}_auto_rotate", provider));

    let mut keys: Vec<KeyEntry> = Vec::new();
    let mut resolved_active_id = active_id.clone();

    if let Some(json) = keys_json {
        if let Ok(parsed) = serde_json::from_str::<Vec<KeyEntry>>(&json) {
            keys = parsed.into_iter().filter(|k| !k.key.trim().is_empty()).collect();
        }
    }

    if keys.is_empty() {
        if let Some(lk) = legacy_key {
            let lk = lk.trim().to_string();
            if !lk.is_empty() {
                let entry = KeyEntry {
                    id: "legacy".to_string(),
                    name: "默认".to_string(),
                    key: lk,
                };
                resolved_active_id = entry.id.clone();
                keys.push(entry);
            }
        }
    }

    if resolved_active_id.is_empty() && !keys.is_empty() {
        resolved_active_id = keys[0].id.clone();
    }

    let base_url = normalize_base_url(
        &raw_url.or(legacy_url).unwrap_or_else(|| default_base_url(provider)),
    );

    let auto_rotate = auto_rotate_str.map_or(true, |v| v != "false");

    Ok(FullApiConfig {
        keys,
        active_key_id: resolved_active_id,
        base_url,
        auto_rotate,
    })
}

pub fn set_active_key(db: &Connection, provider: &str, key_id: &str, key_value: &str) -> Result<(), String> {
    set_setting(db, &format!("{}_active_key_id", provider), key_id)?;
    set_setting(db, &format!("{}_api_key", provider), key_value)?;
    if provider == "comfly" {
        set_setting(db, "openai_api_key", key_value)?;
    }
    Ok(())
}

/// Any non-success HTTP status triggers key rotation.
/// Different keys may belong to different gateway groups with different
/// model access, so virtually any server error could be key-specific.
pub fn is_retryable_status(status: u16) -> bool {
    status >= 400
}

fn default_base_url(provider: &str) -> String {
    match provider {
        "openai" | "comfly" => "https://ai.comfly.chat".to_string(),
        "jijing" => "https://ai.snoworangekeji.cn".to_string(),
        "anthropic" => "https://api.anthropic.com".to_string(),
        _ => String::new(),
    }
}

fn normalize_base_url(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    let trimmed = trimmed.strip_suffix("/v1").unwrap_or(trimmed);
    trimmed.trim_end_matches('/').to_string()
}
