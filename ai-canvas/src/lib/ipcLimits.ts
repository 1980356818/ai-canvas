/**
 * WebView2 IPC 体积守门常量 —— 项目内唯一来源。
 *
 * 修改这里时**必须同步更新** `src-tauri/src/commands/ipc_limits.rs`（Rust 端常量）。
 *
 * ## 为什么有这个文件
 *
 * Tauri 2 在 Windows + WebView2 上的 IPC 通道
 * （ipc.localhost custom protocol + postMessage fallback）对单次
 * invoke / event emit 的字符串字段大小**没有官方上限**，但实测
 * 超过约 **3 MB 就开始随机抛 `ERR_CONNECTION_REFUSED` /
 * "Failed to fetch"**，WebView2 会直接终止渲染进程（白屏一闪 → 窗口关闭），
 * Rust 主进程日志干净，毫无线索。
 *
 * 历史教训：曾经分 `SOFT_LIMIT(4MB)` / `HARD_LIMIT(8MB)` 两层，
 * 4-8 MB 之间只 warn 不落盘，正好踩在 WebView2 雷区 → 图片生成
 * 偶发崩溃半年没修干净。统一只保留一个 HARD 上限。
 *
 * 所有跨 IPC 的字符串字段都必须遵守这里的上限。
 */

/** 前端 → Rust 单次 invoke 字符串字段安全上限。 */
export const IPC_PAYLOAD_HARD_LIMIT_BYTES = 3 * 1024 * 1024;
