pub mod ai;
pub mod backup;
pub mod chat;
pub mod config;
pub mod device;
pub mod gateway;
// http_request: 通用上行 HTTP 入口, 前端 platform/httpAdapter.ts 的 httpJson 走这里。
// 详见模块顶部注释 —— 这是前端唯一调任意远程 HTTP host 的合规方式。
pub mod http_request;
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
// transfer: 项目「导出/导入」为 .aicat 可移植文件。详见 transfer.rs 顶部注释。
pub mod transfer;
pub mod tasks;
// upload_local: 前端 → Rust 本地分块写盘 (规避 WebView2 IPC 3MB 上限)
// upload_remote: Rust → JiJing /v1/files/upload (规避上游 API body 上限)
// upload_presign: upload_remote 的 leader 优先调它走 presign→PUT COS→confirm
//   三步直传 (字节不过服务器); 后端 type=local 不支持时 fallback 回 multipart。
// 三个模块语义不同, 绝不要互相替代。详见各自顶部注释。
pub mod upload_local;
pub mod upload_remote;
pub mod upload_presign;
// frame_extract: ffmpeg-sidecar 抽关键帧。前端解析分镜 JSON 后批量请求时间点的图像。
pub mod frame_extract;
// image_shrink: >10MB 参考图上传前压到 ~10MB 内 (upload_remote 内部调,无 Tauri command)。
pub mod image_shrink;
// template_assets: 模板图下载到 data_dir/template-assets/(内容哈希命名,本地持久化,非浏览器缓存)。
pub mod template_assets;
// update: 自动更新 + 版本切换。详见 update.rs 顶部注释。
pub mod update;
pub mod util;
