use sha2::{Digest, Sha256};
use tauri::State;

use crate::AppState;

#[tauri::command]
pub fn get_machine_code(state: State<'_, AppState>) -> Result<String, String> {
    match platform_machine_id() {
        Ok(raw) => Ok(hash_machine_id(&raw)),
        Err(e) => {
            tracing::warn!("hardware ID unavailable ({}), using fallback file", e);
            let fallback = fallback_machine_id(&state.data_dir)?;
            Ok(hash_machine_id(&fallback))
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
    let output = std::process::Command::new("reg")
        .args([
            "query",
            r"HKLM\SOFTWARE\Microsoft\Cryptography",
            "/v",
            "MachineGuid",
        ])
        .output()
        .map_err(|e| format!("reg query failed: {}", e))?;

    if !output.status.success() {
        return Err("reg query returned non-zero".into());
    }

    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("MachineGuid") {
            if let Some(guid) = trimmed.split_whitespace().last() {
                if !guid.is_empty() {
                    return Ok(guid.to_string());
                }
            }
        }
    }
    Err("MachineGuid not found in registry output".into())
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

    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        if line.contains("IOPlatformUUID") {
            if let Some(start) = line.find('"') {
                let rest = &line[start + 1..];
                if let Some(end) = rest.find('"') {
                    let uuid_str = &rest[..end];
                    if let Some(start2) = uuid_str.rfind('"') {
                        return Ok(uuid_str[start2 + 1..].to_string());
                    }
                    if !uuid_str.is_empty() {
                        return Ok(uuid_str.to_string());
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
