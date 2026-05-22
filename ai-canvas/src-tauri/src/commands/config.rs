use rusqlite::Connection;
use serde::Deserialize;

/// 把内部 provider id 映射成对外展示名（用于错误提示等用户可见文案）。
pub fn provider_display_name(provider: &str) -> &str {
    match provider {
        "jijing" => "极境",
        "comfly" => "Comfly",
        "openai" => "OpenAI",
        "anthropic" => "Anthropic",
        other => other,
    }
}

#[derive(Deserialize, Clone, Debug)]
pub struct KeyEntry {
    pub id: String,
    pub name: String,
    pub key: String,
    /// 槽位标签。Comfly 用 "default" / "gemini_premium" 把 key 分到不同上游通道。
    /// 其他 provider 字段缺省/为 None。
    #[serde(default)]
    pub tag: Option<String>,
}

/// 把模型名映射到 Comfly 的 key 槽位。
/// 规则与前端 comfly/models.ts::getComflyKeyTag 保持一致。
pub fn comfly_key_tag_for_model(model: Option<&str>) -> &'static str {
    let Some(m) = model else { return "default" };
    let m = m.to_ascii_lowercase();
    if m.starts_with("nano-banana")
        || m.starts_with("gemini-3.1-flash-image-preview")
        || m.starts_with("veo3.1")
        || m.starts_with("veo-3.1")
        || m.starts_with("gemini-3.1-pro")
        || m.starts_with("gemini-3.1-flash")
    {
        "gemini_premium"
    } else {
        "default"
    }
}

/// 根据 provider + 请求体派生 key 槽位 tag。非 comfly 返回 None。
pub fn resolve_key_tag(provider: &str, body: &serde_json::Value) -> Option<String> {
    if provider != "comfly" {
        return None;
    }
    let model = body.get("model").and_then(|v| v.as_str());
    Some(comfly_key_tag_for_model(model).to_string())
}

/// 按 tag 过滤 key 列表。tag 为 None 时不过滤。
/// 过滤后保持原顺序（即按用户在设置里调整的优先级）。
pub fn filter_keys_by_tag(keys: Vec<KeyEntry>, tag: Option<&str>) -> Vec<KeyEntry> {
    let Some(want) = tag else { return keys };
    keys
        .into_iter()
        .filter(|k| {
            // 没标 tag 的旧条目默认归 default
            let t = k.tag.as_deref().unwrap_or("default");
            t == want
        })
        .collect()
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
                    tag: None,
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
        &raw_url.or(legacy_url).unwrap_or_else(|| resolve_base_url(provider, db)),
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

/// Apply provider-appropriate auth headers to a request builder.
/// Anthropic uses `x-api-key`; all others use `Authorization: Bearer`.
pub fn apply_auth_headers(
    builder: reqwest::RequestBuilder,
    provider: &str,
    api_key: &str,
) -> reqwest::RequestBuilder {
    match provider {
        "anthropic" => builder
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01"),
        _ => builder.header("Authorization", format!("Bearer {}", api_key)),
    }
}

/// 取 provider 的默认 base URL。
///
/// 极境 (jijing) 双线路:「海外用户」开关 (settings 表 `jijing_overseas`) 为 "true" 时
/// 走香港线路 global.snoworangekeji.cn, 否则走国内 api.snoworangekeji.cn。
/// 真相源是前端的 src/providers/jijing/baseUrl.ts; 修改 URL 字面量必须三处同步:
///   - 本函数
///   - src/providers/jijing/baseUrl.ts (JIJING_API_CN / JIJING_API_GLOBAL)
///   - vite.config.ts (JIJING_API / JIJING_API_GLOBAL)
fn resolve_base_url(provider: &str, db: &Connection) -> String {
    match provider {
        "openai" | "comfly" => "https://ai.comfly.chat".to_string(),
        "jijing" => {
            let overseas = get_setting(db, "jijing_overseas").as_deref() == Some("true");
            if overseas {
                "https://global.snoworangekeji.cn".to_string()
            } else {
                "https://api.snoworangekeji.cn".to_string()
            }
        }
        "anthropic" => "https://api.anthropic.com".to_string(),
        _ => String::new(),
    }
}

pub fn normalize_base_url(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    let trimmed = trimmed.strip_suffix("/v1").unwrap_or(trimmed);
    trimmed.trim_end_matches('/').to_string()
}
