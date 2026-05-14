//! 备份相关的 Tauri 命令，给前端 UI 用。
//!
//! 实际备份/恢复逻辑在 `crate::backup`。这里只做胶水：
//! - 列备份
//! - 立即手动备份
//! - 安排"下次启动时恢复"（避免运行时替换数据库文件的复杂性）
//! - 获取/打开备份目录

use crate::{backup, AppState};
use std::fs;
use std::path::PathBuf;
use tauri::State;

#[tauri::command]
pub fn list_backups(state: State<'_, AppState>) -> Vec<backup::BackupInfo> {
    backup::list_backups(&state.backup_dir)
}

#[tauri::command]
pub fn get_backup_dir(state: State<'_, AppState>) -> String {
    state.backup_dir.to_string_lossy().to_string()
}

#[tauri::command]
pub fn create_backup_now(state: State<'_, AppState>) -> Result<String, String> {
    let conn = state.db.lock().map_err(|e| format!("db lock poisoned: {}", e))?;
    let path = backup::create_backup(&conn, &state.backup_dir, backup::DEFAULT_MAX_KEEP)?;
    Ok(path.to_string_lossy().to_string())
}

/// 安排一次恢复：把 `backup_path` 写入 `{data_dir}/.pending-restore` 标记文件，
/// 下次启动时 lib.rs 会在 db::init 之前读取并执行恢复。
///
/// 选择"重启再恢复"而非运行时热替换，是因为：
/// 1. 运行时替换需要让所有持有 db 连接的代码暂停，工程量大
/// 2. WAL 文件可能正在被写，热替换可能导致数据撕裂
/// 3. SQLite 在 Windows 上文件锁严，正在打开的 db 文件不能直接覆盖
#[tauri::command]
pub fn prepare_restore(
    state: State<'_, AppState>,
    backup_path: String,
) -> Result<(), String> {
    let p = PathBuf::from(&backup_path);
    if !p.exists() {
        return Err(format!("backup file does not exist: {}", backup_path));
    }
    // 必须在备份目录里，防止任意路径写入
    if !p.starts_with(&state.backup_dir) {
        return Err("backup_path must be inside backup_dir".to_string());
    }

    let marker = state.data_dir.join(".pending-restore");
    fs::write(&marker, backup_path.as_bytes())
        .map_err(|e| format!("write pending-restore marker failed: {}", e))?;
    Ok(())
}

/// 取消已安排的恢复（如果用户改主意了）。
#[tauri::command]
pub fn cancel_pending_restore(state: State<'_, AppState>) -> Result<(), String> {
    let marker = state.data_dir.join(".pending-restore");
    if marker.exists() {
        fs::remove_file(&marker)
            .map_err(|e| format!("remove pending-restore failed: {}", e))?;
    }
    Ok(())
}

/// 查询是否已有挂起的恢复。
#[tauri::command]
pub fn get_pending_restore(state: State<'_, AppState>) -> Option<String> {
    let marker = state.data_dir.join(".pending-restore");
    fs::read_to_string(&marker).ok()
}
