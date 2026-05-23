//! ╔══════════════════════════════════════════════════════════════════════╗
//! ║  🚨 DO NOT REMOVE — IPC SAFETY LAYER                                  ║
//! ║                                                                       ║
//! ║  这个文件是 ai-canvas 渲染端**不崩**的最后一道防线。任何"瘦身"      ║
//! ║  / "重构" / "简化" 之前必读 `docs/性能与IPC规范.md` §11 + 本文件     ║
//! ║  顶部注释,以及 memory `project_ai_canvas_crash_fixes.md` 的 v3/v8。 ║
//! ║                                                                       ║
//! ║  历史:                                                                ║
//! ║   - 2026-05-22 v3 首次加入守门 → 修复 WebView2 渲染端崩溃             ║
//! ║   - 2026-05-23 commit 664c74a "瘦身重构" 一刀切删掉 → 当晚用户报      ║
//! ║     "进项目/点生成/生成等待中"三场景频繁闪退 → 同日 v8 全部恢复 +    ║
//! ║     封装成本文件 + 加测试/CI/启动自检/banner 多层防御。              ║
//! ║                                                                       ║
//! ║  **删本文件 = 删护栏 = 用户必崩。删之前请先在项目根跑                ║
//! ║   `pwsh scripts/check-ipc-guards.ps1` —— 它会失败并告诉你为啥不行。**║
//! ╚══════════════════════════════════════════════════════════════════════╝
//!
//! ## 五道闸门
//!
//! Tauri 2 + WebView2 在 Windows 上 invoke / event emit 单次 String 字段
//! 超过 ~3MB 会随机 ERR_CONNECTION_REFUSED 杀掉渲染进程(实测雷区 3-4MB),
//! Rust 主进程日志干净无线索。Mac 上限稍宽(~10MB),但仍不应作为常规通道。
//!
//! ### 跨 IPC(前后端通道)
//! 1. `guard_response_body()` — `ai_proxy` 等命令返回 String body 前必走。
//!    超 HARD 限即落盘到 `<data_dir>/debug/oversize_response/` + 返简短 stub。
//! 2. `check_stream_chunk()` — SSE 单条 `data:` chunk emit 前必走。
//!    超 HARD 限直接 `Err` 终止流(stream 上下文,无 spill)。
//! 3. `check_stream_buffer()` — SSE 行缓冲累积阶段必走。
//!    超 HARD 限且无 `\n` = 上游异常输出,直接 `Err` 中断,避免无限增长 OOM。
//!
//! ### 后端内存(不跨 IPC,但同样致命)
//! 4. `check_inline_total_bytes()` — `inline_local_files` 累计展开字节数,
//!    防止一次塞 N 张 4K 图把进程整体撑爆。
//! 5. `check_media_upload_chunk()` — 分块大文件上传时单 chunk 大小 + 累计总量,
//!    防止单 chunk 撞 IPC 雷区 + 防止 GB 级文件塞满磁盘。
//!
//! ### HTTP body 读取
//! 上限 `HTTP_RESPONSE_BODY_READ_HARD_LIMIT_BYTES` 在
//! `super::http_util::read_body_bounded_bytes` 里 inline 落地(不暴露
//! 单独 guard fn 是因为该 helper 已经把"流式读 + 上限校验"一体化封装,
//! 没有"自己起一个 loop 套 guard"的合理用法)。
//!
//! ## 强制约束
//!
//! - `commands/ai.rs` 的 `ai_proxy` / `ai_proxy_stream::do_stream` 必须调用本模块。
//! - 不允许在 ai.rs 内联实现守门逻辑 —— 重构者一眼看不到 = 一刀切删。
//! - `scripts/check-ipc-guards.ps1` 在 build 前 grep 验证 ai.rs 仍在调用,
//!   并 ban 已知 O(n²) buffer 反模式(`let mut buffer = String::new()` 紧跟
//!   `buffer.find('\n')`)。CI 必须跑这个脚本。

use std::path::{Path, PathBuf};
use chrono::Local;
use serde_json::json;

use super::ipc_limits::{
    HTTP_RESPONSE_BODY_READ_HARD_LIMIT_BYTES,
    INLINE_LOCAL_FILES_TOTAL_HARD_LIMIT_BYTES,
    IPC_RESPONSE_BODY_HARD_LIMIT_BYTES,
    IPC_STREAM_CHUNK_HARD_LIMIT_BYTES,
    MEDIA_UPLOAD_CHUNK_HARD_LIMIT_BYTES,
    MEDIA_TRANSFER_TOTAL_HARD_LIMIT_BYTES,
    STREAM_LINE_BUFFER_HARD_LIMIT_BYTES,
};
use super::util::run_blocking;

/// 把要跨 IPC 回前端的 response body 过一道守门。超过 HARD 限即落盘 + 返 error stub。
///
/// **必须在任何 `#[tauri::command] -> Result<...String...>` 返回前调用。**
///
/// 落盘走 `spawn_blocking` 避免阻塞 runtime(写一个 3MB+ 文件最坏几百毫秒)。
/// 失败时只 warn-log,不 propagate(出错也得让原请求收尾)。
pub async fn guard_response_body(
    body: String,
    data_dir: &Path,
    tag: &str,
    request_id: &str,
    status: u16,
) -> String {
    if body.len() <= IPC_RESPONSE_BODY_HARD_LIMIT_BYTES {
        return body;
    }
    let original_len = body.len();
    let data_dir = data_dir.to_path_buf();
    let req_id = request_id.to_string();
    let tag_s = tag.to_string();
    let body_for_spill = body;
    let spilled = run_blocking(move || {
        Ok(spill_oversize_response(
            &data_dir, &tag_s, &req_id, status, &body_for_spill,
        ))
    })
    .await
    .ok()
    .flatten();
    tracing::error!(
        "[ipc_guard:{}] OVERSIZED response body {} bytes (>{}) — spilled to {:?}, replacing with stub to protect IPC",
        request_id, original_len, IPC_RESPONSE_BODY_HARD_LIMIT_BYTES, spilled
    );
    let spilled_str = spilled
        .as_ref()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| "<spill failed>".into());
    json!({
        "error": {
            "code": "response_too_large",
            "message": format!(
                "上游响应过大 ({} bytes，> {} MB 上限)，已落盘到 {}，请联系开发者诊断",
                original_len,
                IPC_RESPONSE_BODY_HARD_LIMIT_BYTES / (1024 * 1024),
                spilled_str
            ),
            "spilled_path": spilled_str,
        }
    })
    .to_string()
}

/// SSE 流式 chunk emit 之前必须过的守门。返 `Ok(())` 才能 emit。
///
/// SSE 一行正常几 KB,几 MB 几乎必是异常 provider(含 base64 image inline),
/// 硬塞 IPC 会拖崩渲染端。stream 上下文无法 spill —— 直接终止流。
pub fn check_stream_chunk(data: &str) -> Result<(), String> {
    if data.len() > IPC_STREAM_CHUNK_HARD_LIMIT_BYTES {
        tracing::error!(
            "[ipc_guard] chunk data {} bytes > {} hard limit — aborting stream to protect IPC",
            data.len(),
            IPC_STREAM_CHUNK_HARD_LIMIT_BYTES
        );
        return Err(format!(
            "上游单条 chunk {}MB 超过 IPC 安全上限，已中断流",
            data.len() / (1024 * 1024)
        ));
    }
    Ok(())
}

/// SSE 行缓冲累积上限守门。在每次 `buffer.extend_from_slice(&chunk)` 之后调用。
///
/// 没换行但 buffer 已经撑爆:上游异常输出,放弃流避免无限增长 OOM。
/// 有换行说明流处理器会消费,留给主循环正常 drain 即可。
pub fn check_stream_buffer(buffer: &[u8]) -> Result<(), String> {
    // `contains(&b'\n')` 内部走 memchr,比 iter().any() 快一个量级,
    // 流式热路径必须用 — 一次性吐 16MB 数据时差别明显。
    if buffer.len() > STREAM_LINE_BUFFER_HARD_LIMIT_BYTES && !buffer.contains(&b'\n') {
        tracing::error!(
            "[ipc_guard] line buffer exceeded {} bytes without newline — aborting stream",
            STREAM_LINE_BUFFER_HARD_LIMIT_BYTES
        );
        return Err(format!(
            "上游流式响应异常：单行超过 {}MB 仍未换行，已中断",
            STREAM_LINE_BUFFER_HARD_LIMIT_BYTES / (1024 * 1024)
        ));
    }
    Ok(())
}

/// `inline_local_files` 累计字节守门。每展开一个 `local://` 文件后调用,
/// 超过总量上限直接 `Err` 中断本次请求,避免一次塞 N 张 4K 大图把内存撑爆。
///
/// 在 `inline_local_files` 内部调用,**不**进 IPC,纯后端内存保护。
pub fn check_inline_total_bytes(total: usize) -> Result<(), String> {
    if total > INLINE_LOCAL_FILES_TOTAL_HARD_LIMIT_BYTES {
        tracing::error!(
            "[ipc_guard] inline_local_files accumulated {} bytes > {} hard limit — aborting request",
            total,
            INLINE_LOCAL_FILES_TOTAL_HARD_LIMIT_BYTES
        );
        return Err(format!(
            "请求体引用的本地文件累计超过 {}MB 上限,无法一次性发出。请减少引用文件数量或换张小一些的图。",
            INLINE_LOCAL_FILES_TOTAL_HARD_LIMIT_BYTES / (1024 * 1024)
        ));
    }
    Ok(())
}

// HTTP response body 上限实际生效在 `super::http_util::read_body_bounded_bytes` 里
// 用 max_bytes 参数 inline 实现 —— 每次读 chunk 后比对 max_bytes 即可,不再单独
// 暴露 check_http_body_size() helper(死代码 / 重复实现)。
// HTTP_RESPONSE_BODY_READ_HARD_LIMIT_BYTES 常量本身仍由 `read_body_bounded` 默认
// 传入,见那边注释。

/// 分块媒体上传的单 chunk 守门 + 累计总量守门。在 `upload_media_chunk` 入口调用。
///
/// - chunk_len > MEDIA_UPLOAD_CHUNK_HARD_LIMIT_BYTES → 单 chunk 本身就会撞 IPC 雷区,拒绝。
/// - new_total > MEDIA_TRANSFER_TOTAL_HARD_LIMIT_BYTES → 防止用户上传 GB 级文件把磁盘塞满。
pub fn check_media_upload_chunk(chunk_len: usize, new_total: u64) -> Result<(), String> {
    if chunk_len > MEDIA_UPLOAD_CHUNK_HARD_LIMIT_BYTES {
        return Err(format!(
            "上传分块 {}KB 超过单块 {}KB 安全上限",
            chunk_len / 1024,
            MEDIA_UPLOAD_CHUNK_HARD_LIMIT_BYTES / 1024,
        ));
    }
    if new_total > MEDIA_TRANSFER_TOTAL_HARD_LIMIT_BYTES as u64 {
        return Err(format!(
            "上传文件累计 {}MB 超过单文件 {}MB 上限,请压缩或裁剪后重试",
            (new_total / (1024 * 1024)),
            MEDIA_TRANSFER_TOTAL_HARD_LIMIT_BYTES / (1024 * 1024),
        ));
    }
    Ok(())
}

// ── 编译期常量自检 ────────────────────────────────────────────
// `const _: () = assert!(...)` 是 Rust 的 const-assertion 惯用法:
// 表达式在编译期求值,失败 → cargo build 直接 fail,根本走不到 runtime。
// 这比 sanity_check_limits() 的 runtime panic 更强 — 改坏常量的 commit
// 在 CI 上必然挂掉,不会出问题包。
const _: () = assert!(
    IPC_RESPONSE_BODY_HARD_LIMIT_BYTES >= 1024 * 1024
        && IPC_RESPONSE_BODY_HARD_LIMIT_BYTES <= 16 * 1024 * 1024,
    "IPC_RESPONSE_BODY_HARD_LIMIT_BYTES must be 1..=16 MB",
);
const _: () = assert!(
    IPC_STREAM_CHUNK_HARD_LIMIT_BYTES >= 256 * 1024
        && IPC_STREAM_CHUNK_HARD_LIMIT_BYTES <= 8 * 1024 * 1024,
    "IPC_STREAM_CHUNK_HARD_LIMIT_BYTES must be 256KB..=8MB",
);
const _: () = assert!(
    STREAM_LINE_BUFFER_HARD_LIMIT_BYTES >= 1024 * 1024
        && STREAM_LINE_BUFFER_HARD_LIMIT_BYTES <= 64 * 1024 * 1024,
    "STREAM_LINE_BUFFER_HARD_LIMIT_BYTES must be 1..=64 MB",
);
// chunk 限必须 <= response 限,否则 stream 比单次响应还能塞,语义错乱
const _: () = assert!(
    IPC_STREAM_CHUNK_HARD_LIMIT_BYTES <= IPC_RESPONSE_BODY_HARD_LIMIT_BYTES,
    "stream chunk limit must not exceed response body limit",
);

// 新加常量的范围自检 —— 改坏直接 build fail,不走 runtime
const _: () = assert!(
    INLINE_LOCAL_FILES_TOTAL_HARD_LIMIT_BYTES >= 4 * 1024 * 1024
        && INLINE_LOCAL_FILES_TOTAL_HARD_LIMIT_BYTES <= 256 * 1024 * 1024,
    "INLINE_LOCAL_FILES_TOTAL_HARD_LIMIT_BYTES must be 4..=256 MB",
);
const _: () = assert!(
    HTTP_RESPONSE_BODY_READ_HARD_LIMIT_BYTES >= 4 * 1024 * 1024
        && HTTP_RESPONSE_BODY_READ_HARD_LIMIT_BYTES <= 256 * 1024 * 1024,
    "HTTP_RESPONSE_BODY_READ_HARD_LIMIT_BYTES must be 4..=256 MB",
);
// HTTP 读上限必须 >= IPC response 上限,否则会出现"能放 IPC 但根本读不到"的死区
const _: () = assert!(
    HTTP_RESPONSE_BODY_READ_HARD_LIMIT_BYTES >= IPC_RESPONSE_BODY_HARD_LIMIT_BYTES,
    "HTTP read limit must be >= IPC response limit (else valid responses get truncated by read guard)",
);
const _: () = assert!(
    MEDIA_UPLOAD_CHUNK_HARD_LIMIT_BYTES >= 256 * 1024
        && MEDIA_UPLOAD_CHUNK_HARD_LIMIT_BYTES <= 2 * 1024 * 1024,
    "MEDIA_UPLOAD_CHUNK_HARD_LIMIT_BYTES must be 256KB..=2MB",
);
// 分块上限**必须**严格小于 IPC payload 限,否则单块就撞 WebView2 雷区
const _: () = assert!(
    MEDIA_UPLOAD_CHUNK_HARD_LIMIT_BYTES < IPC_RESPONSE_BODY_HARD_LIMIT_BYTES,
    "media chunk size must be strictly < IPC payload limit",
);
const _: () = assert!(
    MEDIA_TRANSFER_TOTAL_HARD_LIMIT_BYTES >= 16 * 1024 * 1024
        && MEDIA_TRANSFER_TOTAL_HARD_LIMIT_BYTES <= 4 * 1024 * 1024 * 1024,
    "MEDIA_TRANSFER_TOTAL_HARD_LIMIT_BYTES must be 16MB..=4GB",
);

/// 启动时调用 — 写日志确认守门已加载,顺便给 check-ipc-guards.ps1 一个
/// grep 锚点(脚本验证 lib.rs 必须调用本函数)。
/// 真正的常量范围检查已在编译期由 `const _: () = assert!(...)` 完成。
pub fn sanity_check_limits() {
    tracing::info!(
        "[ipc_guard] limits loaded: ipc_resp={}MB stream_chunk={}MB line_buf={}MB \
         inline_total={}MB http_read={}MB media_chunk={}KB media_total={}MB \
         (all compile-time validated)",
        IPC_RESPONSE_BODY_HARD_LIMIT_BYTES / (1024 * 1024),
        IPC_STREAM_CHUNK_HARD_LIMIT_BYTES / (1024 * 1024),
        STREAM_LINE_BUFFER_HARD_LIMIT_BYTES / (1024 * 1024),
        INLINE_LOCAL_FILES_TOTAL_HARD_LIMIT_BYTES / (1024 * 1024),
        HTTP_RESPONSE_BODY_READ_HARD_LIMIT_BYTES / (1024 * 1024),
        MEDIA_UPLOAD_CHUNK_HARD_LIMIT_BYTES / 1024,
        MEDIA_TRANSFER_TOTAL_HARD_LIMIT_BYTES / (1024 * 1024),
    );
}

/// 把超大 response body 落盘到 `<data_dir>/debug/oversize_response/`,返回相对路径。
/// 内部辅助,不直接对外 —— 走 `guard_response_body()` 即可。
fn spill_oversize_response(
    data_dir: &Path,
    tag: &str,
    request_id: &str,
    status: u16,
    body: &str,
) -> Option<PathBuf> {
    let dir = data_dir.join("debug").join("oversize_response");
    if std::fs::create_dir_all(&dir).is_err() {
        return None;
    }
    let ts = Local::now().format("%Y%m%d_%H%M%S_%3f");
    let path = dir.join(format!("{}_{}_{}.{}.body", tag, request_id, ts, status));
    match std::fs::write(&path, body) {
        Ok(_) => Some(path),
        Err(e) => {
            tracing::warn!("[ipc_guard] spill write failed {:?}: {}", path, e);
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::fs;

    /// 内联的临时目录创建 —— 不引入 tempfile dep,测试自包含。
    fn tmp_dir(name: &str) -> PathBuf {
        let mut p = env::temp_dir();
        p.push(format!(
            "ai-canvas-ipc-guard-test-{}-{}",
            name,
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn small_body_passes_through_unchanged() {
        let dir = tmp_dir("small");
        let body = "a".repeat(1024);
        let out = guard_response_body(body.clone(), &dir, "test", "rid1", 200).await;
        assert_eq!(out, body, "≤ limit 的 body 必须原样透传");
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn oversize_body_is_spilled_and_stubbed() {
        let dir = tmp_dir("over");
        let body = "x".repeat(IPC_RESPONSE_BODY_HARD_LIMIT_BYTES + 1024);
        let out = guard_response_body(body, &dir, "test", "rid2", 200).await;
        // 返回的必须是 error stub JSON,不能是原 body
        let parsed: serde_json::Value =
            serde_json::from_str(&out).expect("stub 必须是合法 JSON");
        assert_eq!(parsed["error"]["code"], "response_too_large");
        // spill 文件必须落盘
        let spill_dir = dir.join("debug").join("oversize_response");
        assert!(spill_dir.is_dir(), "spill 目录必须创建");
        let files: Vec<_> = fs::read_dir(&spill_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
        assert_eq!(files.len(), 1, "应落盘 1 个 spill 文件");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn chunk_below_limit_is_ok() {
        let data = "a".repeat(1024);
        assert!(check_stream_chunk(&data).is_ok());
    }

    #[test]
    fn chunk_at_limit_is_ok() {
        let data = "a".repeat(IPC_STREAM_CHUNK_HARD_LIMIT_BYTES);
        assert!(
            check_stream_chunk(&data).is_ok(),
            "等于 limit 不应 reject(只 reject 严格大于)"
        );
    }

    #[test]
    fn chunk_above_limit_is_err() {
        let data = "a".repeat(IPC_STREAM_CHUNK_HARD_LIMIT_BYTES + 1);
        let r = check_stream_chunk(&data);
        assert!(r.is_err(), "> limit 必须 reject");
        let msg = r.unwrap_err();
        assert!(msg.contains("超过 IPC 安全上限"), "错误信息要中文化");
    }

    #[test]
    fn buffer_small_no_newline_ok() {
        let buf = vec![b'a'; 1024];
        assert!(check_stream_buffer(&buf).is_ok());
    }

    #[test]
    fn buffer_huge_with_newline_ok() {
        // 即使超 limit,只要含有 \n 就允许 —— 主循环会 drain
        let mut buf = vec![b'a'; STREAM_LINE_BUFFER_HARD_LIMIT_BYTES + 1024];
        buf[100] = b'\n';
        assert!(check_stream_buffer(&buf).is_ok());
    }

    #[test]
    fn buffer_huge_no_newline_is_err() {
        // 单行超 limit 还没 \n = 上游异常 → 必须 reject
        let buf = vec![b'a'; STREAM_LINE_BUFFER_HARD_LIMIT_BYTES + 1];
        let r = check_stream_buffer(&buf);
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("未换行"));
    }

    #[test]
    fn sanity_check_passes_for_default_constants() {
        // 静默跑,如果常量被改成非法值会 panic
        sanity_check_limits();
    }

    #[test]
    fn inline_total_under_limit_ok() {
        assert!(check_inline_total_bytes(0).is_ok());
        assert!(check_inline_total_bytes(INLINE_LOCAL_FILES_TOTAL_HARD_LIMIT_BYTES).is_ok());
    }

    #[test]
    fn inline_total_over_limit_err() {
        let r = check_inline_total_bytes(INLINE_LOCAL_FILES_TOTAL_HARD_LIMIT_BYTES + 1);
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("MB 上限"));
    }

    #[test]
    fn media_chunk_within_limits_ok() {
        // 单 chunk 1MB, 总量 10MB
        assert!(check_media_upload_chunk(1024 * 1024, 10 * 1024 * 1024).is_ok());
    }

    #[test]
    fn media_chunk_too_large_err() {
        let r = check_media_upload_chunk(MEDIA_UPLOAD_CHUNK_HARD_LIMIT_BYTES + 1, 0);
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("KB 安全上限"));
    }

    #[test]
    fn media_total_too_large_err() {
        let r = check_media_upload_chunk(
            1024,
            MEDIA_TRANSFER_TOTAL_HARD_LIMIT_BYTES as u64 + 1,
        );
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("MB 上限"));
    }
}
