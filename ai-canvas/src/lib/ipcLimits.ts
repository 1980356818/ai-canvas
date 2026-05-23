/**
 * WebView2 IPC 体积守门常量 —— 项目内唯一来源。
 *
 * **必须与 `src-tauri/src/commands/ipc_limits.rs` 同步**(Rust 端是真正强制者,
 * 但前端这边的常量帮助分流"哪些走单 invoke / 哪些必须走分块上传")。
 *
 * ## 为什么有这个文件
 *
 * Tauri 2 在 Windows + WebView2 上的 IPC 通道
 * (ipc.localhost custom protocol + postMessage fallback) 对单次
 * invoke / event emit 的字符串字段大小**没有官方上限**,但实测
 * 超过约 **3 MB 就开始随机抛 `ERR_CONNECTION_REFUSED` /
 * "Failed to fetch"**,WebView2 会直接终止渲染进程(白屏一闪 → 窗口关闭),
 * Rust 主进程日志干净,毫无线索。
 *
 * 历史教训:曾经分 `SOFT_LIMIT(4MB)` / `HARD_LIMIT(8MB)` 两层,
 * 4-8 MB 之间只 warn 不落盘,正好踩在 WebView2 雷区 → 图片生成
 * 偶发崩溃半年没修干净。统一只保留一个 HARD 上限。
 *
 * 所有跨 IPC 的字符串字段都必须遵守这里的上限。
 */

/** 前端 → Rust 单次 invoke 字符串字段安全上限 (Rust 端 IPC_RESPONSE_BODY_HARD_LIMIT_BYTES 同值)。 */
export const IPC_PAYLOAD_HARD_LIMIT_BYTES = 3 * 1024 * 1024;

/**
 * 单 invoke 走 dataURL 的"安全阈值"。
 * 超过这个值的文件必须改走 `persistLargeFile` 的分块上传通道,否则会撞 WebView2 雷区。
 *
 * 1.5MB 原始字节 → 约 2MB base64 字符串 → 加 dataURL prefix + JSON 包装仍 < 3MB IPC 上限,
 * 留有 1MB headroom 应对 Tauri 内部 JSON envelope overhead。
 */
export const IPC_SINGLE_INVOKE_SAFE_RAW_BYTES = 1.5 * 1024 * 1024;

/**
 * `upload_media_chunk` 单次 chunk **base64 字符串**上限 ——
 * **必须** ≤ Rust 端 `MEDIA_UPLOAD_CHUNK_HARD_LIMIT_BYTES` (1,800,000) 且 ≤ IPC 上限。
 * 1.8MB base64 对应 ≈ 1.35MB 原始字节,见 `MEDIA_UPLOAD_CHUNK_RAW_BYTES`。
 */
export const MEDIA_UPLOAD_CHUNK_BASE64_BYTES = 1_800_000;

/**
 * `upload_media_chunk` 单次 chunk 的**原始字节**大小(前端 File.slice 的步长)。
 * = MEDIA_UPLOAD_CHUNK_BASE64_BYTES × 3 / 4 - 小余量。1.35MB 是验证过的安全值。
 */
export const MEDIA_UPLOAD_CHUNK_RAW_BYTES = 1_350_000;

/**
 * 单文件传输上限(Rust 端 MEDIA_TRANSFER_TOTAL_HARD_LIMIT_BYTES 同值)。
 * 超过此值前端预先拒绝,不浪费一通分块再被后端 reject。
 */
export const MEDIA_TRANSFER_TOTAL_BYTES = 500 * 1024 * 1024;
