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
// upload: 大文件分块上传通道,详见 upload.rs 顶部注释 + ipc_guard 守门链。
pub mod upload;
pub mod util;
