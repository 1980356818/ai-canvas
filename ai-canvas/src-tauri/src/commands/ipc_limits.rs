//! ╔══════════════════════════════════════════════════════════════════════╗
//! ║  🚨 DO NOT REMOVE / RELAX — IPC SAFETY CONSTANTS                      ║
//! ║                                                                       ║
//! ║  改前必读: docs/RUST_REFACTOR_CHECKLIST.md + super::ipc_guard 顶部。  ║
//! ║  改完必跑: `pwsh scripts/check-ipc-guards.ps1`                        ║
//! ║                                                                       ║
//! ║  调高任何常量(尤其 RESPONSE/CHUNK)= 让 WebView2 进入崩溃雷区。       ║
//! ║  改前先在内网用 ai_proxy 实际打一次相应大小的 response 验证。        ║
//! ╚══════════════════════════════════════════════════════════════════════╝
//!
//! WebView2 IPC 体积守门常量 —— 项目内唯一来源。
//!
//! 修改这里时**必须同步更新** `src/lib/ipcLimits.ts`(前端常量),并跑
//! `cargo test -p ai-canvas commands::ipc_guard` 让单测验证仍在 sanity 范围内。
//!
//! ## 为什么有这个文件
//!
//! Tauri 2 在 Windows + WebView2 上的 IPC 通道
//! (ipc.localhost custom protocol + postMessage fallback) 对单次
//! invoke / event emit 的字符串字段大小**没有官方上限**,但实测
//! 超过约 **3 MB 就开始随机抛 `ERR_CONNECTION_REFUSED` /
//! "Failed to fetch"**,WebView2 会直接终止渲染进程(白屏一闪 →
//! 窗口关闭),Rust 主进程日志干净,毫无线索。
//!
//! 历史教训:
//! - 2025-Q1 曾分 `SOFT = 4MB` / `HARD = 8MB` 两层,4-8MB 区间只 warn
//!   不落盘,正好踩在 WebView2 雷区 → 图片生成偶发崩溃半年没修干净。
//! - 2026-05-22 v3 统一改成单一 3MB HARD,超过必落盘。
//! - 2026-05-23 commit 664c74a "瘦身重构"把整个 ipc_limits 模块从 mod.rs
//!   下线,守门一刀切删,当晚用户报"进项目/点生成/生成等待中"频繁闪退。
//!   v8 全部恢复 + 加测试/CI/banner 多层防御。
//!
//! 所有跨 IPC 的字符串字段都必须遵守这里的上限,统一走 `super::ipc_guard`:
//! - `ai_proxy` 回传给前端的 response body → `guard_response_body()`
//! - `ai-stream` event emit 的每条 chunk → `check_stream_chunk()`
//! - 流式 line buffer 累积 → `check_stream_buffer()`
//!
//! 后端内存上限(不跨 IPC)也放在这里集中管理。

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

/// `inline_local_files` 一次请求里把所有 `local://...` 引用展开成 base64
/// 后的**累计**字节数上限。超过即 abort 本次请求,不再继续展开后续文件。
///
/// 为什么需要:用户可以同时在卡片上挂 N 张高清图 + 视频引用,一次 ai_proxy
/// 请求把它们全 inline 进 outgoing JSON 后,内存峰值会到 base64 总和的 1×。
/// 单文件无上限 + 不限总量 = 极端情况下 OOM 拖崩主进程。
///
/// 64MB 是宽松值:典型一次请求 < 10MB,留 6× headroom 容下"多图 ICL"用法。
pub const INLINE_LOCAL_FILES_TOTAL_HARD_LIMIT_BYTES: usize = 64 * 1024 * 1024;

/// 从 HTTP/网络层流式读 response body 的累计上限。超过即 abort,避免
/// 恶意/buggy provider 返 1GB 把 Rust 进程整体撑死。**这一道在 ipc_guard
/// `guard_response_body` 之前**,因为后者需要先 alloc 完整 String 才能检查。
///
/// 比 IPC_RESPONSE_BODY_HARD_LIMIT_BYTES 大一些 = 给"读完再裁"留余量:
/// 上游可能返一个稍超 IPC 限的 JSON,我们还是允许读完落盘,再用 ipc_guard
/// 替换成 stub 返前端。但绝对超过这个值就连读都不读。
pub const HTTP_RESPONSE_BODY_READ_HARD_LIMIT_BYTES: usize = 32 * 1024 * 1024;

/// 大文件分块上传:单次 chunk 通过 invoke 进 Rust 的 base64 上限。
/// **必须**严格小于 `IPC_PAYLOAD_HARD_LIMIT_BYTES`(前端常量),否则
/// 单个 chunk 就会撞 WebView2 雷区。1.8MB 是 base64 后的安全大小
/// (≈ 2.4MB 原始字节)。前端 `MEDIA_UPLOAD_CHUNK_BYTES` 必须 ≤ 这个值。
pub const MEDIA_UPLOAD_CHUNK_HARD_LIMIT_BYTES: usize = 1_800_000;

/// 单文件媒体传输总字节上限 —— 同时用于:
///   - 分块上传(`upload_media_chunk` 累计)
///   - 远程下载(`save_media` HTTP fetch,AI 返了张大图/大视频 URL)
///   - 落盘前后的 read_media_base64 / save_media local-file 路径
///
/// 防止用户拖一个 4K 一小时视频(几 GB)把磁盘/内存搞爆。
/// 500MB 对绝大多数 UGC 场景够用,够大到能容下 AI 生成的几十 MB 视频。
pub const MEDIA_TRANSFER_TOTAL_HARD_LIMIT_BYTES: usize = 500 * 1024 * 1024;
