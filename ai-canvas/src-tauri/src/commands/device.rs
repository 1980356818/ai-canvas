use sha2::{Digest, Sha256};
use tauri::State;

use crate::AppState;

const REGISTRY_CACHE_KEY: &str = "machine_code";

fn is_valid_code(s: &str) -> bool {
    s.len() == 32 && s.chars().all(|c| c.is_ascii_hexdigit())
}

#[cfg(target_os = "windows")]
fn read_registry_cache() -> Option<String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = hkcu.open_subkey(r"SOFTWARE\AICat").ok()?;
    let val: String = key.get_value(REGISTRY_CACHE_KEY).ok()?;
    let val = val.trim().to_string();
    if is_valid_code(&val) { Some(val) } else { None }
}

#[cfg(target_os = "windows")]
fn write_registry_cache(code: &str) {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_WRITE};
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    match hkcu.create_subkey_with_flags(r"SOFTWARE\AICat", KEY_WRITE) {
        Ok((key, _)) => {
            if let Err(e) = key.set_value(REGISTRY_CACHE_KEY, &code) {
                tracing::warn!("failed to write registry cache: {}", e);
            }
        }
        Err(e) => tracing::warn!("failed to create registry key: {}", e),
    }
}

#[cfg(not(target_os = "windows"))]
fn read_registry_cache() -> Option<String> { None }

#[cfg(not(target_os = "windows"))]
fn write_registry_cache(_code: &str) {}

#[tauri::command]
pub fn get_machine_code(state: State<'_, AppState>) -> Result<String, String> {
    // 三级缓存策略（任一命中即返回，保证同一台电脑永远返回同一个 code）:
    //   1. HKCU 注册表 (Windows) — 不受 data_dir 路径变化影响
    //   2. data_dir/machine_code 文件 — 原有逻辑
    //   3. 全新生成 → 同时写入上述两处

    if let Some(cached) = read_registry_cache() {
        tracing::debug!("machine_code from registry cache");
        ensure_file_cache(&state.data_dir, &cached);
        return Ok(cached);
    }

    let cache_path = state.data_dir.join("machine_code");
    if let Ok(cached) = std::fs::read_to_string(&cache_path) {
        let cached = cached.trim().to_string();
        if is_valid_code(&cached) {
            tracing::debug!("machine_code from file cache at {:?}", cache_path);
            write_registry_cache(&cached);
            return Ok(cached);
        }
    }

    tracing::info!("generating new machine_code (data_dir={:?})", state.data_dir);
    let raw = match platform_machine_id() {
        Ok(raw) => {
            tracing::info!("using platform hardware ID");
            raw
        }
        Err(e) => {
            tracing::warn!("hardware ID unavailable ({}), using fallback file", e);
            fallback_machine_id(&state.data_dir)?
        }
    };
    let code = hash_machine_id(&raw);

    write_registry_cache(&code);
    ensure_file_cache(&state.data_dir, &code);

    Ok(code)
}

fn ensure_file_cache(data_dir: &std::path::Path, code: &str) {
    let cache_path = data_dir.join("machine_code");
    match std::fs::read_to_string(&cache_path) {
        Ok(existing) if is_valid_code(existing.trim()) => {}
        _ => {
            if let Err(e) = std::fs::write(&cache_path, code) {
                tracing::warn!("failed to cache machine_code at {:?}: {}", cache_path, e);
            }
        }
    }
}

fn hash_machine_id(raw: &str) -> String {
    let salted = format!("ai-canvas:{}", raw);
    let digest = Sha256::digest(salted.as_bytes());
    let hex = format!("{:x}", digest);
    hex[..32].to_string()
}

fn fallback_machine_id(data_dir: &std::path::Path) -> Result<String, String> {
    let path = data_dir.join("machine_id");
    if let Ok(id) = std::fs::read_to_string(&path) {
        let id = id.trim().to_string();
        if !id.is_empty() {
            return Ok(id);
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    std::fs::write(&path, &id).map_err(|e| format!("failed to write machine_id: {}", e))?;
    Ok(id)
}

#[cfg(target_os = "windows")]
fn platform_machine_id() -> Result<String, String> {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;

    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let key = hklm
        .open_subkey(r"SOFTWARE\Microsoft\Cryptography")
        .map_err(|e| format!("failed to open registry key: {}", e))?;
    let guid: String = key
        .get_value("MachineGuid")
        .map_err(|e| format!("failed to read MachineGuid: {}", e))?;
    if guid.is_empty() {
        return Err("MachineGuid is empty".into());
    }
    Ok(guid)
}

#[cfg(target_os = "macos")]
fn platform_machine_id() -> Result<String, String> {
    let output = std::process::Command::new("ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .map_err(|e| format!("ioreg failed: {}", e))?;

    if !output.status.success() {
        return Err("ioreg returned non-zero".into());
    }

    // Line format: "IOPlatformUUID" = "XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        if line.contains("IOPlatformUUID") {
            if let Some(eq_pos) = line.find('=') {
                let after_eq = &line[eq_pos + 1..];
                if let Some(q1) = after_eq.find('"') {
                    let value_start = &after_eq[q1 + 1..];
                    if let Some(q2) = value_start.find('"') {
                        let uuid = &value_start[..q2];
                        if !uuid.is_empty() {
                            return Ok(uuid.to_string());
                        }
                    }
                }
            }
        }
    }
    Err("IOPlatformUUID not found in ioreg output".into())
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn platform_machine_id() -> Result<String, String> {
    if let Ok(id) = std::fs::read_to_string("/etc/machine-id") {
        let id = id.trim().to_string();
        if !id.is_empty() {
            return Ok(id);
        }
    }
    Err("no hardware ID source on this platform".into())
}
