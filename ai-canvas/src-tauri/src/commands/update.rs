//! 自动更新 + 版本切换的 Tauri 命令。
//!
//! 三种行为:
//! 1. `check_for_update`  — 走 tauri.conf.json 配的默认端点,问"有没有更高版本"。
//!                          用于启动时静默轮询。
//! 2. `install_latest_update` — 紧接着 1,如果有就下载、验签、安装、重启。
//! 3. `switch_to_version` — 用 UpdaterBuilder 自建一个临时 updater,端点
//!                          指到 /api/update/manifest/{id}; 服务端不管目标版本
//!                          高低、只校验"启用中",于是可以装"指定版本"。
//!
//! 三个命令都走 tauri-plugin-updater 的 minisign 验签流程,任何被篡改的包
//! 会在 `download_and_install` 里被拒绝(非纸面承诺,是 updater crate 写死的)。
//!
//! "停用版本不可切换"在服务端 /api/update/manifest/{id} 已做:is_active=0 直接 40311。
//! 客户端无需重复校验。

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

/// 启动时 / "检查更新"按钮调用。
/// 返回 None = 已是最新,Some = 有新版本,前端弹 UpdateDialog。
#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<Option<UpdateAvailable>, String> {
    let updater = app
        .updater()
        .map_err(|e| format!("updater init failed: {}", e))?;

    match updater.check().await {
        Ok(Some(update)) => {
            let (force, _id) = parse_update_meta(update.body.as_deref().unwrap_or(""));
            Ok(Some(UpdateAvailable {
                version: update.version.clone(),
                current_version: update.current_version.clone(),
                notes: clean_notes(update.body.as_deref().unwrap_or("")),
                force_update: force,
            }))
        }
        Ok(None) => Ok(None),
        Err(e) => Err(format!("check_for_update failed: {}", e)),
    }
}

/// 紧跟 check_for_update 的"立即更新"按钮。
/// 下载 + 验签 + 安装 + 重启。任一步失败回 Err,不会半安装挂在那。
#[tauri::command]
pub async fn install_latest_update(app: AppHandle) -> Result<(), String> {
    let updater = app
        .updater()
        .map_err(|e| format!("updater init failed: {}", e))?;

    let update = updater
        .check()
        .await
        .map_err(|e| format!("check failed: {}", e))?
        .ok_or_else(|| "已是最新版本".to_string())?;

    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| format!("download_and_install failed: {}", e))?;

    // Windows 上 installMode=passive 装完后 Tauri 会自动退出当前进程,无需手动 restart。
    // macOS / Linux 需要显式重启。下面这行在 Windows 已退出后无害。
    // Tauri 2 中 AppHandle::restart() 返回 ! (diverging),后面这个 Ok 死码,
    // 但保留它让函数签名 Result<(), String> 在不同 Tauri 小版本间都兼容。
    app.restart();
    #[allow(unreachable_code)]
    Ok(())
}

/// 切换到指定 release id 的版本。版本必须在服务端 is_active=1,否则
/// /api/update/manifest/{id} 直接 40311,这里会拿到错误。
///
/// 注意:即使目标版本"号"小于当前版本(降级),也允许执行。
/// 我们的服务端不做版本号高低校验 —— 这是"自由切换"的要点。
#[tauri::command]
pub async fn switch_to_version(
    app: AppHandle,
    server_base_url: String,
    version_id: i64,
) -> Result<(), String> {
    let base = server_base_url.trim_end_matches('/');
    let manifest_url = format!("{}/api/update/manifest/{}", base, version_id);
    let url = url::Url::parse(&manifest_url)
        .map_err(|e| format!("manifest url invalid: {} ({})", manifest_url, e))?;

    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| format!("updater endpoints invalid: {}", e))?
        // 版本切换允许"装一个比当前更老的"
        .version_comparator(|_current, _new| true)
        .build()
        .map_err(|e| format!("updater build failed: {}", e))?;

    let update = updater
        .check()
        .await
        .map_err(|e| format!("manifest fetch failed: {}", e))?
        .ok_or_else(|| {
            // version_comparator 永远返回 true,只有"服务端没返回 manifest"会到这。
            "服务端未返回目标版本信息(可能已被停用)".to_string()
        })?;

    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| format!("download_and_install failed: {}", e))?;

    app.restart();
    #[allow(unreachable_code)]
    Ok(())
}

/// 当前客户端运行的 target / arch / version。前端要构造 list 端点 URL 时拿这个。
#[tauri::command]
pub fn get_runtime_info(app: AppHandle) -> RuntimeInfo {
    let pkg = app.package_info();
    RuntimeInfo {
        target: target_str().to_string(),
        arch: arch_str().to_string(),
        version: pkg.version.to_string(),
    }
}

// ── helpers ──────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct UpdateAvailable {
    pub version: String,
    pub current_version: String,
    pub notes: String,
    /// 客户端版本低于服务端 min_version 时为 true,前端不能让用户 skip。
    pub force_update: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct RuntimeInfo {
    pub target: String,
    pub arch: String,
    pub version: String,
}

fn target_str() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

fn arch_str() -> &'static str {
    // std::env::consts::ARCH = "x86_64" / "aarch64" / ...
    std::env::consts::ARCH
}

/// 服务端在 notes 尾巴塞了 `<!--UPDATE_META:{"forceUpdate":true,"id":42}-->`。
/// 解析出来得到 (force, id),失败回 (false, None)。
fn parse_update_meta(notes: &str) -> (bool, Option<i64>) {
    let prefix = "<!--UPDATE_META:";
    let Some(start) = notes.rfind(prefix) else {
        return (false, None);
    };
    let rest = &notes[start + prefix.len()..];
    let Some(end) = rest.find("-->") else {
        return (false, None);
    };
    let json = &rest[..end];
    let v: serde_json::Value = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(_) => return (false, None),
    };
    let force = v.get("forceUpdate").and_then(|x| x.as_bool()).unwrap_or(false);
    let id = v.get("id").and_then(|x| x.as_i64());
    (force, id)
}

/// 去掉 notes 尾巴的 `<!--UPDATE_META:{...}-->` 注释,只给前端 UI 干净的文本。
fn clean_notes(notes: &str) -> String {
    let prefix = "<!--UPDATE_META:";
    if let Some(start) = notes.rfind(prefix) {
        return notes[..start].trim_end().to_string();
    }
    notes.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_meta_basic() {
        let notes = "Fix X\n<!--UPDATE_META:{\"forceUpdate\":true,\"id\":42}-->";
        let (force, id) = parse_update_meta(notes);
        assert!(force);
        assert_eq!(id, Some(42));
        assert_eq!(clean_notes(notes), "Fix X");
    }

    #[test]
    fn parse_meta_missing() {
        assert_eq!(parse_update_meta("just notes"), (false, None));
        assert_eq!(clean_notes("just notes"), "just notes");
    }

    #[test]
    fn parse_meta_malformed_falls_back() {
        let notes = "<!--UPDATE_META:not json-->";
        assert_eq!(parse_update_meta(notes), (false, None));
    }
}
