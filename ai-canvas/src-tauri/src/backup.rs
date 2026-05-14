//! 数据库备份与恢复模块。
//!
//! ## 设计目标
//!
//! 这个模块的存在是为了应对一类真实事故：**用户卸载并重装后项目全没了**。
//! 触发场景包括 macOS bundle identifier 历史变更（`com.ai-canvas.app` →
//! `com.ai-canvas.desktop`）、AppCleaner / CleanMyMac 之类的工具把
//! `Application Support` 一起清掉、用户为了"干净重装"自己删了数据目录等。
//!
//! ## 关键决策
//!
//! - **备份位置在 `~/Documents/AICat Data/backups/`**：故意放在用户文档目录，
//!   是因为 AppCleaner、Windows 卸载器都不会动 Documents。即使应用数据目录
//!   被清空，备份仍在。
//! - **用 `VACUUM INTO` 取一致性快照**：SQLite 在 WAL 模式下 main db 文件
//!   不一定包含最新写入，普通的 `fs::copy` 可能丢数据；`VACUUM INTO` 会等
//!   到事务边界并生成完整快照，不需要 checkpoint。
//! - **只备份 `data.db`，不备份 `media/`**：媒体文件太大，备份成本高；
//!   `data.db` 才是无可替代的（项目结构 + 卡片内容 + API Key + 设置）。
//!   媒体文件用户可以重新生成，但项目结构丢了就是真没了。
//! - **启动时和定时双触发**：启动时立即备份一份兜底，之后每 30 分钟再备份；
//!   保留最近 10 份，保证至少能回溯几天前的状态。

use chrono::Local;
use rusqlite::Connection;
use std::fs;
use std::path::{Path, PathBuf};

/// 备份目录名（在 Documents 下）。
pub const BACKUP_ROOT_NAME: &str = "AICat Data";

/// 备份文件名前缀。
const BACKUP_FILE_PREFIX: &str = "data-";
const BACKUP_FILE_EXT: &str = "db";

/// 保留的最大备份份数。超过会删除最早的。
pub const DEFAULT_MAX_KEEP: usize = 10;

/// 解析备份目录。优先取 Tauri 给的 document_dir，回退到 HOME/Documents。
/// 失败返回 None — 调用方应只 warn 不 panic，备份非关键路径。
pub fn resolve_backup_dir(document_dir: Option<&Path>) -> Option<PathBuf> {
    if let Some(dir) = document_dir {
        return Some(dir.join(BACKUP_ROOT_NAME).join("backups"));
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(userprofile) = std::env::var_os("USERPROFILE") {
            return Some(
                PathBuf::from(userprofile)
                    .join("Documents")
                    .join(BACKUP_ROOT_NAME)
                    .join("backups"),
            );
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Some(home) = std::env::var_os("HOME") {
            return Some(
                PathBuf::from(home)
                    .join("Documents")
                    .join(BACKUP_ROOT_NAME)
                    .join("backups"),
            );
        }
    }

    None
}

/// 一份备份的元数据。
#[derive(Debug, Clone, serde::Serialize)]
pub struct BackupInfo {
    /// 绝对路径
    pub path: String,
    /// 文件名（含扩展名）
    pub name: String,
    /// 文件大小（字节）
    pub size: u64,
    /// 修改时间，毫秒 epoch
    pub modified_ms: i64,
}

/// 列出所有备份，按修改时间倒序（最新在前）。目录不存在时返回空列表。
pub fn list_backups(backup_dir: &Path) -> Vec<BackupInfo> {
    let mut out: Vec<BackupInfo> = Vec::new();
    let read = match fs::read_dir(backup_dir) {
        Ok(r) => r,
        Err(_) => return out,
    };

    for entry in read.flatten() {
        let path = entry.path();
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if !name.starts_with(BACKUP_FILE_PREFIX) || !name.ends_with(BACKUP_FILE_EXT) {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        out.push(BackupInfo {
            path: path.to_string_lossy().to_string(),
            name,
            size: meta.len(),
            modified_ms,
        });
    }

    out.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    out
}

/// 创建一份新备份。使用 `VACUUM INTO` 取一致性快照，绕过 WAL 不一致问题。
///
/// 返回新备份的绝对路径。失败时调用方应 warn，不 panic。
pub fn create_backup(
    conn: &Connection,
    backup_dir: &Path,
    max_keep: usize,
) -> Result<PathBuf, String> {
    fs::create_dir_all(backup_dir)
        .map_err(|e| format!("create backup dir failed: {}", e))?;

    let ts = Local::now().format("%Y%m%d-%H%M%S").to_string();
    let target = backup_dir.join(format!("{}{}.{}", BACKUP_FILE_PREFIX, ts, BACKUP_FILE_EXT));

    // 如果同秒已存在（理论上不会）就跳过避免覆盖
    if target.exists() {
        return Ok(target);
    }

    // VACUUM INTO 需要绝对路径，且单引号转义路径
    let target_str = target.to_string_lossy().replace('\'', "''");
    let sql = format!("VACUUM INTO '{}'", target_str);
    conn.execute_batch(&sql)
        .map_err(|e| format!("VACUUM INTO failed: {}", e))?;

    prune_old(backup_dir, max_keep);
    Ok(target)
}

/// 删除超出保留数的旧备份。失败仅 warn，不返回错误。
fn prune_old(backup_dir: &Path, max_keep: usize) {
    let mut backups = list_backups(backup_dir);
    if backups.len() <= max_keep {
        return;
    }
    // backups 已按时间倒序，要删的是末尾（最老的）
    let to_remove = backups.split_off(max_keep);
    for b in to_remove {
        let path = PathBuf::from(&b.path);
        if let Err(e) = fs::remove_file(&path) {
            tracing::warn!("prune backup {:?} failed: {}", path, e);
        }
    }
}

/// 启动时自动恢复：如果 `target_db` 不存在但备份目录里有有效备份，
/// 把最新一份备份复制到 `target_db`，并写一个 `.restored-from` 标记文件。
///
/// 返回 `Ok(Some(used_backup))` 表示发生了恢复，`Ok(None)` 表示无需恢复，
/// `Err` 表示恢复尝试失败。
pub fn restore_if_missing(
    target_db: &Path,
    backup_dir: &Path,
) -> Result<Option<PathBuf>, String> {
    if target_db.exists() {
        return Ok(None);
    }
    let backups = list_backups(backup_dir);
    let latest = match backups.into_iter().next() {
        Some(b) => PathBuf::from(b.path),
        None => return Ok(None),
    };

    if let Some(parent) = target_db.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create parent failed: {}", e))?;
    }
    fs::copy(&latest, target_db)
        .map_err(|e| format!("copy backup failed: {}", e))?;

    // 写一个标记文件，方便用户/客服了解恢复来源
    let marker = target_db
        .parent()
        .map(|p| p.join(".restored-from"))
        .unwrap_or_else(|| PathBuf::from(".restored-from"));
    let content = format!(
        "{}\n{}\n",
        latest.to_string_lossy(),
        Local::now().to_rfc3339(),
    );
    let _ = fs::write(&marker, content);

    Ok(Some(latest))
}

/// 主动从指定备份恢复：把 `backup_path` 内容覆盖到 `target_db`。
/// 调用方必须在调用前确保已关闭原数据库连接。
pub fn restore_from(backup_path: &Path, target_db: &Path) -> Result<(), String> {
    if !backup_path.exists() {
        return Err(format!("backup file not found: {:?}", backup_path));
    }
    if let Some(parent) = target_db.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create parent failed: {}", e))?;
    }

    // 备份当前 db 一份带 `.before-restore-{ts}` 后缀的副本，防止用户后悔
    if target_db.exists() {
        let ts = Local::now().format("%Y%m%d-%H%M%S").to_string();
        let safety = target_db.with_extension(format!("db.before-restore-{}", ts));
        if let Err(e) = fs::copy(target_db, &safety) {
            tracing::warn!("safety copy before restore failed: {}", e);
        }
    }

    // 清掉 WAL/SHM 文件，否则旧 WAL 会污染恢复后的 db
    let wal = target_db.with_extension("db-wal");
    let shm = target_db.with_extension("db-shm");
    let _ = fs::remove_file(&wal);
    let _ = fs::remove_file(&shm);

    fs::copy(backup_path, target_db)
        .map_err(|e| format!("copy backup failed: {}", e))?;
    Ok(())
}
