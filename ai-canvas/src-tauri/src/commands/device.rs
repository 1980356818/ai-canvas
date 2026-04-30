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
