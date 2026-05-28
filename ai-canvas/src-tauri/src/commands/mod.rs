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
// jijing_serde: JiJing 服务端响应反序列化的统一规约 (Long → String 兼容)。
// 凡是解析 JiJing 响应的 struct 都要走这里, 详见模块顶部 doc。
pub mod jijing_serde;
pub mod project;
// groups: 节点分组(card_groups 表)的 Tauri commands。详见 groups.rs 顶部注释。
pub mod groups;
pub mod tasks;
// upload_local: 前端 → Rust 本地分块写盘 (规避 WebView2 IPC 3MB 上限)
// upload_remote: Rust → JiJing /v1/files/upload (规避上游 API body 上限)
// 两个模块语义完全不同, 绝不要互相替代。详见各自顶部注释。
pub mod upload_local;
pub mod upload_remote;
// frame_extract: ffmpeg-sidecar 抽关键帧。前端解析分镜 JSON 后批量请求时间点的图像。
pub mod frame_extract;
// update: 自动更新 + 版本切换。详见 update.rs 顶部注释。
pub mod update;
pub mod util;
