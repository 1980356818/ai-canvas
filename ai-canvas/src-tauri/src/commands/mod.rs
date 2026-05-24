pub mod ai;
pub mod backup;
pub mod chat;
pub mod config;
pub mod device;
pub mod gateway;
pub mod http_util;
// ipc_limits + ipc_guard 是 WebView2 渲染端不崩的最后防线,详见 ipc_guard.rs 顶部。
// 删除任一行会让 ai.rs 编译失败 —— 这是故意的。
pub mod ipc_guard;
pub mod ipc_limits;
pub mod project;
pub mod tasks;
// upload_local: 前端 → Rust 本地分块写盘 (规避 WebView2 IPC 3MB 上限)
// upload_remote: Rust → JiJing /v1/files/upload (规避上游 API body 上限)
// 两个模块语义完全不同, 绝不要互相替代。详见各自顶部注释。
pub mod upload_local;
pub mod upload_remote;
pub mod util;
