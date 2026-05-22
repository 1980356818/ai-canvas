//! WebView2 IPC 体积守门常量 —— 项目内唯一来源。
//!
//! 修改这里时**必须同步更新** `src/lib/ipcLimits.ts`（前端常量）。
//!
//! ## 为什么有这个文件
//!
//! Tauri 2 在 Windows + WebView2 上的 IPC 通道
//! （ipc.localhost custom protocol + postMessage fallback）对单次
//! invoke / event emit 的字符串字段大小**没有官方上限**，但实测
//! 超过约 **3 MB 就开始随机抛 `ERR_CONNECTION_REFUSED` /
//! "Failed to fetch"**，WebView2 会直接终止渲染进程（白屏一闪 →
//! 窗口关闭），Rust 主进程日志干净，毫无线索。
//!
//! 历史教训：曾经分 `SOFT_LIMIT = 4MB` / `HARD_LIMIT = 8MB` 两层，
//! 4-8 MB 之间只 warn 不落盘，正好踩在 WebView2 雷区 → 图片生成
//! 偶发崩溃半年没修干净。统一只保留一个 HARD 上限，超过必落盘。
//!
//! 所有跨 IPC 的字符串字段都必须遵守这里的上限：
//! - `ai_proxy` 回传给前端的 response body
//! - `ai-stream` event emit 的每条 chunk
//!
//! 后端内存上限（不跨 IPC）也放在这里集中管理。

/// `ai_proxy` 单次 response body 跨 IPC 回前端的硬上限。超过必落盘到
/// `<data_dir>/debug/oversize_response/` 并返回简短 error stub。
///
/// 与前端 `IPC_PAYLOAD_HARD_LIMIT_BYTES` 对称（两边都按 3 MB 算
/// 安全发送上限），但本端会再卡一道避免 provider 异常返回过大 body。
pub const IPC_RESPONSE_BODY_HARD_LIMIT_BYTES: usize = 3 * 1024 * 1024;

/// `ai-stream` 单条 SSE chunk 经 Tauri event emit 的硬上限。超过当
/// `error` 终止流。SSE 一行正常几 KB，几 MB 几乎必是异常 provider
/// （含 base64 image inline），硬塞 IPC 会拖崩渲染端。
pub const IPC_STREAM_CHUNK_HARD_LIMIT_BYTES: usize = 2 * 1024 * 1024;

/// 流式解析的 line buffer 最大长度。**这是后端内存上限，不跨 IPC**。
/// 超过这个值还没看到 `\n` 直接放弃整条流，避免恶意/异常上游持续
/// 不分行喂数据把 buffer 撑爆。SSE 一行通常不超过几十 KB。
pub const STREAM_LINE_BUFFER_HARD_LIMIT_BYTES: usize = 16 * 1024 * 1024;
