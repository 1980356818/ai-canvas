//! 大文件分块上传 —— Tauri 单次 invoke 字符串上限 ~3MB (`IPC_PAYLOAD_HARD_LIMIT_BYTES`),
//! 所以视频/大图必须由前端切片 + 顺序发送,后端追加到 temp 文件,完事用
//! `save_media` 把 temp 当本地源走一遍。
//!
//! ## 流程
//!
//! ```text
//! 前端:                              后端:
//!   uuid = randomUUID()
//!   for slice in file.chunks(1.8MB):
//!     base64 = encode(slice)
//!     await invoke("upload_media_chunk", { uploadId: uuid, base64Chunk: base64 })
//!                                       → ipc_guard 守门
//!                                       → run_blocking 追加到
//!                                          <data_dir>/media/uploads_temp/<uuid>
//!   await invoke("save_media", {
//!     source: `media/uploads_temp/${uuid}`,  ← 走 save_media 本地文件分支
//!     filename, title, projectId
//!   })
//!                                       → save_media 读 temp,落到 media/images/
//!                                       → magic-byte 校正扩展名 + 自动保存副本
//!                                       → 返 SaveMediaResult
//!   await invoke("upload_media_cleanup", { uploadId: uuid })
//!                                       → 删 temp 文件
//! ```
//!
//! ## 守门
//!
//! - 单 chunk decoded 字节数 ≤ `MEDIA_UPLOAD_CHUNK_HARD_LIMIT_BYTES`
//! - 累计字节数 ≤ `MEDIA_TRANSFER_TOTAL_HARD_LIMIT_BYTES`
//! - upload_id 必须长得像 UUID(防止路径注入)
//!
//! ## 失败/孤儿文件清理
//!
//! 进程崩溃 / 用户半途取消 → temp 文件残留。下次 `cleanup_orphan_uploads_on_startup`
//! 启动时全清。前端正常完成 = 主动调 upload_media_cleanup;前端异常 = 等下次启动。

use base64::Engine as _;
use std::path::PathBuf;
use tauri::State;

use crate::AppState;
use super::ipc_guard::check_media_upload_chunk;
use super::util::run_blocking;

const BASE64_ENGINE: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// 校验前端传来的 upload_id —— 必须长得像 UUID,只含 ascii alnum + `-`,
/// 长度 16..=64。防止 `../` 注入跑出 uploads_temp/ 目录。
fn validate_upload_id(s: &str) -> Result<(), String> {
    let len = s.len();
    if !(16..=64).contains(&len) {
        return Err(format!("无效的 upload_id 长度 ({})", len));
    }
    if !s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("upload_id 含非法字符".into());
    }
    Ok(())
}

fn temp_path_for(data_dir: &std::path::Path, upload_id: &str) -> PathBuf {
    data_dir.join("media/uploads_temp").join(upload_id)
}

/// 追加一段 base64 编码的 chunk 到 `<data_dir>/media/uploads_temp/<upload_id>` 文件。
///
/// 返回值:写完之后该 temp 文件的累计字节数。前端可以拿这个值做进度条 / sanity check。
///
/// **必须**前端先调好,顺序追加完所有 chunk,再调 `save_media`
/// (source = `media/uploads_temp/<upload_id>`)落到 media/images/,
/// 最后调 [`upload_media_cleanup`] 删 temp 文件。
#[tauri::command]
pub async fn upload_media_chunk(
    state: State<'_, AppState>,
    upload_id: String,
    base64_chunk: String,
) -> Result<u64, String> {
    validate_upload_id(&upload_id)?;

    let data_dir = state.data_dir.clone();
    let temp_path = temp_path_for(&data_dir, &upload_id);
    let temp_dir = temp_path
        .parent()
        .ok_or("无法解析上传临时目录")?
        .to_path_buf();

    // base64 decode 走 blocking pool —— 1.8MB base64 ≈ 1.35MB 原始字节,
    // 解码本身 CPU bound,不该卡住 tokio worker
    let chunk_bytes = run_blocking(move || {
        BASE64_ENGINE
            .decode(&base64_chunk)
            .map_err(|e| format!("base64 解码失败: {}", e))
    })
    .await?;
    let chunk_len = chunk_bytes.len();

    // 准备目录 + 取当前 size + 守门 + append,一次性进 blocking pool 做完。
    // 注意:这里没有 per-upload Mutex,依赖前端顺序发送 chunk。如果两个并发 chunk
    // 撞到同一 upload_id,可能 size 检查不准 —— 但 Tauri IPC 在同一 window 是
    // FIFO 的,前端 await 写法保证了顺序,真打架属于前端 bug。
    let total = run_blocking(move || -> Result<u64, String> {
        std::fs::create_dir_all(&temp_dir)
            .map_err(|e| format!("创建上传临时目录失败: {}", e))?;

        let current = std::fs::metadata(&temp_path)
            .map(|m| m.len())
            .unwrap_or(0);
        let new_total = current.saturating_add(chunk_len as u64);

        // 单 chunk + 累计上限守门 —— 见 ipc_guard::check_media_upload_chunk
        check_media_upload_chunk(chunk_len, new_total)?;

        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&temp_path)
            .map_err(|e| format!("打开临时文件失败: {}", e))?;
        f.write_all(&chunk_bytes)
            .map_err(|e| format!("写入临时文件失败: {}", e))?;
        f.flush().map_err(|e| format!("flush 临时文件失败: {}", e))?;
        Ok(new_total)
    })
    .await?;

    tracing::debug!(
        "[upload] chunk appended: upload_id={}, chunk_bytes={}, total_bytes={}",
        upload_id, chunk_len, total
    );

    Ok(total)
}

/// 删除前端 upload_id 对应的 temp 文件 —— 通常在 `save_media` 成功后由前端主动调,
/// 但即便不调,下次启动也会被 [`cleanup_orphan_uploads_on_startup`] 清掉。
///
/// 不存在 = 静默 Ok(()),不抛错(可能 save_media 已删,可能前端重试调了两次)。
#[tauri::command]
pub async fn upload_media_cleanup(
    state: State<'_, AppState>,
    upload_id: String,
) -> Result<(), String> {
    validate_upload_id(&upload_id)?;
    let temp_path = temp_path_for(&state.data_dir, &upload_id);
    let _ = run_blocking(move || -> Result<(), String> {
        match std::fs::remove_file(&temp_path) {
            Ok(_) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("删除临时文件失败: {}", e)),
        }
    })
    .await;
    Ok(())
}

/// 启动时清空 `<data_dir>/media/uploads_temp/` —— 上一次进程崩溃残留的孤儿文件
/// 在这里被清。同步调用(启动阶段无 tokio runtime 可言),目录本身就一两个文件,
/// 不会卡。
pub fn cleanup_orphan_uploads_on_startup(data_dir: &std::path::Path) {
    let temp_dir = data_dir.join("media/uploads_temp");
    if !temp_dir.is_dir() {
        return;
    }
    let entries = match std::fs::read_dir(&temp_dir) {
        Ok(e) => e,
        Err(e) => {
            tracing::warn!("[upload] 清理孤儿 uploads_temp 失败 (read_dir): {}", e);
            return;
        }
    };
    let mut cleared = 0usize;
    for entry in entries.flatten() {
        if std::fs::remove_file(entry.path()).is_ok() {
            cleared += 1;
        }
    }
    if cleared > 0 {
        tracing::info!("[upload] 启动清理 uploads_temp/: 删除 {} 个孤儿文件", cleared);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_upload_id_accepts_uuid() {
        assert!(validate_upload_id("550e8400-e29b-41d4-a716-446655440000").is_ok());
    }

    #[test]
    fn validate_upload_id_rejects_too_short() {
        assert!(validate_upload_id("short").is_err());
    }

    #[test]
    fn validate_upload_id_rejects_too_long() {
        assert!(validate_upload_id(&"a".repeat(100)).is_err());
    }

    #[test]
    fn validate_upload_id_rejects_path_traversal() {
        assert!(validate_upload_id("../../etc/passwd1234567890").is_err());
        assert!(validate_upload_id("foo/bar/baz/qux/quux/corge1").is_err());
        assert!(validate_upload_id("foo\\bar\\baz\\qux\\quux\\1").is_err());
    }

    #[test]
    fn validate_upload_id_rejects_special_chars() {
        assert!(validate_upload_id("hello world hello world hello").is_err());
        assert!(validate_upload_id("hello+world+hello+world+hello").is_err());
    }
}
