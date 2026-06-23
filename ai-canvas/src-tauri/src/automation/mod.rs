//! 本地自动化桥 —— 让外部 AI 工具 (Claude Code / Codex 等) 与应用内对话面板,用同一套
//! 动词操控画布 (建项目/建卡/连线/跑生成/拿结果),全程不碰内部 data.db。
//!
//! ── 架构 (详见 docs/automation/自动化接口-设计与施工图.md) ───────────────────
//!  外部工具 ──HTTP/MCP──▶ 本模块 axum server (127.0.0.1)
//!                              │ emit("automation:request")
//!                              ▼
//!                     前端 host (src/services/automation) 按动词分发
//!                              │ 与 UI 完全同一代码路径 (会员/试用门禁天然继承)
//!                              ▼
//!                     stores + cardRunner/groupRunner + autoSave → data.db
//!
//! **本模块只做哑管道**:HTTP ↔ Tauri event 的双向桥接 + token 鉴权 + bridge.json 发现 +
//! 请求级 JSONL 日志。一行业务逻辑都不在 Rust —— 这样 UI 与自动化永不分叉。
//!
//! 生命周期:默认关闭。用户在设置里开启 → 前端 host 装好 listener 后 invoke
//! `automation_start` → server 起、写 bridge.json。关闭/退出 → `automation_stop` → 删
//! bridge.json。token 每次开启随机重生。

pub mod protocol;

mod bridge;
mod journal;
mod server;

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value as Json;
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;

use protocol::CallResponse;

/// 自动化桥 API 版本。破坏性变更才 +1;新增动词不动它。与 bridge.json 的 `apiVersion` 一致。
pub const API_VERSION: u32 = 1;

/// 首选端口。被占用时回退随机端口 (见 `automation_start`)。
pub const DEFAULT_PORT: u16 = 11420;

/// 单个请求等待前端回包的上限。生成可能 30–200s,给足余量;`automation_start` 不依赖它。
pub const REQUEST_TIMEOUT_SECS: u64 = 590;

/// 自动化桥的运行态。被 Tauri `manage`,在 server handler 与 command 间共享。
pub struct AutomationState {
    inner: Mutex<Inner>,
}

struct Inner {
    running: Option<Running>,
    /// 在途请求:requestId → 等待前端回包的 oneshot sender。
    pending: HashMap<String, oneshot::Sender<CallResponse>>,
    /// 前端 host 推来的动词 schema (MCP `tools/list` 用)。host 未就绪时为 None。
    descriptor: Option<Json>,
}

struct Running {
    port: u16,
    token: String,
    /// `send(())` 触发 axum graceful shutdown。
    shutdown: Option<oneshot::Sender<()>>,
}

impl Default for AutomationState {
    fn default() -> Self {
        Self::new()
    }
}

impl AutomationState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                running: None,
                pending: HashMap::new(),
                descriptor: None,
            }),
        }
    }

    fn register_pending(&self, request_id: String, tx: oneshot::Sender<CallResponse>) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.pending.insert(request_id, tx);
        }
    }

    fn take_pending(&self, request_id: &str) -> Option<oneshot::Sender<CallResponse>> {
        self.inner
            .lock()
            .ok()
            .and_then(|mut inner| inner.pending.remove(request_id))
    }

    /// 前端回包:取出 pending sender 并投递。无对应在途请求 (已超时清理) 则丢弃。
    fn resolve_pending(&self, request_id: &str, resp: CallResponse) {
        if let Some(tx) = self.take_pending(request_id) {
            let _ = tx.send(resp);
        }
    }

    /// MCP `tools/list` 的工具数组:取 descriptor.tools,缺省空数组。
    fn descriptor_tools(&self) -> Json {
        self.inner
            .lock()
            .ok()
            .and_then(|inner| inner.descriptor.clone())
            .and_then(|d| d.get("tools").cloned())
            .unwrap_or_else(|| Json::Array(vec![]))
    }
}

/// 桥状态,回给前端设置界面展示 + 给开关用。
#[derive(Serialize)]
pub struct StatusInfo {
    pub running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(rename = "apiVersion")]
    pub api_version: u32,
}

fn status_of(running: &Option<Running>) -> StatusInfo {
    match running {
        Some(r) => StatusInfo {
            running: true,
            port: Some(r.port),
            token: Some(r.token.clone()),
            api_version: API_VERSION,
        },
        None => StatusInfo {
            running: false,
            port: None,
            token: None,
            api_version: API_VERSION,
        },
    }
}

// ── Tauri commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn automation_status(app: AppHandle) -> Result<StatusInfo, String> {
    let auto = app.state::<AutomationState>();
    let inner = auto.inner.lock().map_err(|e| e.to_string())?;
    Ok(status_of(&inner.running))
}

/// 启动桥:绑端口 → spawn axum server → 写 bridge.json。已在运行则幂等返回当前状态。
#[tauri::command]
pub fn automation_start(app: AppHandle) -> Result<StatusInfo, String> {
    let auto = app.state::<AutomationState>();

    // 已在运行 → 幂等。
    {
        let inner = auto.inner.lock().map_err(|e| e.to_string())?;
        if inner.running.is_some() {
            return Ok(status_of(&inner.running));
        }
    }

    let data_dir = app.state::<crate::AppState>().data_dir.clone();
    let token = bridge::gen_token();

    // 先用同步 std bind 探测端口 (首选 11420,占用则随机),好把 port 同步返回给前端;
    // 再转 tokio listener 交给 axum。
    let std_listener = std::net::TcpListener::bind(("127.0.0.1", DEFAULT_PORT))
        .or_else(|_| std::net::TcpListener::bind(("127.0.0.1", 0)))
        .map_err(|e| format!("绑定本地端口失败: {e}"))?;
    let port = std_listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();
    std_listener
        .set_nonblocking(true)
        .map_err(|e| e.to_string())?;

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let ctx = server::ServerCtx {
        app: app.clone(),
        token: token.clone(),
        data_dir: data_dir.clone(),
    };
    tauri::async_runtime::spawn(async move {
        match tokio::net::TcpListener::from_std(std_listener) {
            Ok(listener) => {
                let router = server::build_router(ctx);
                let serve = axum::serve(listener, router)
                    .with_graceful_shutdown(async move {
                        let _ = shutdown_rx.await;
                    });
                if let Err(e) = serve.await {
                    tracing::error!("automation: axum serve ended with error: {e}");
                }
            }
            Err(e) => tracing::error!("automation: tokio listener from_std failed: {e}"),
        }
    });

    let info = bridge::BridgeInfo {
        port,
        token: token.clone(),
        pid: std::process::id(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        api_version: API_VERSION,
    };
    if let Err(e) = bridge::write(&data_dir, &info) {
        tracing::warn!("automation: write bridge.json failed: {e}");
    }
    // 把操作手册写到 bridge.json 旁边,外部 AI 工具在同一目录既拿到连接信息也读到用法。
    bridge::write_manual(&data_dir);

    {
        let mut inner = auto.inner.lock().map_err(|e| e.to_string())?;
        inner.running = Some(Running {
            port,
            token: token.clone(),
            shutdown: Some(shutdown_tx),
        });
    }
    tracing::info!("automation bridge started on 127.0.0.1:{port}");

    Ok(StatusInfo {
        running: true,
        port: Some(port),
        token: Some(token),
        api_version: API_VERSION,
    })
}

/// 停止桥:触发 graceful shutdown + 删 bridge.json。未运行则 no-op。
#[tauri::command]
pub fn automation_stop(app: AppHandle) -> Result<(), String> {
    let auto = app.state::<AutomationState>();
    let data_dir = app.state::<crate::AppState>().data_dir.clone();
    {
        let mut inner = auto.inner.lock().map_err(|e| e.to_string())?;
        if let Some(mut r) = inner.running.take() {
            if let Some(tx) = r.shutdown.take() {
                let _ = tx.send(());
            }
        }
    }
    bridge::remove(&data_dir);
    tracing::info!("automation bridge stopped");
    Ok(())
}

/// 前端 host 处理完动词后回传完整响应信封,解决对应的在途请求。
#[tauri::command]
pub fn automation_respond(app: AppHandle, response: CallResponse) -> Result<(), String> {
    let request_id = response.request_id.clone();
    app.state::<AutomationState>()
        .resolve_pending(&request_id, response);
    Ok(())
}

/// 前端 host 安装时推送动词 schema 清单,供 MCP `tools/list` 返回。
#[tauri::command]
pub fn automation_set_descriptor(app: AppHandle, descriptor: Json) -> Result<(), String> {
    let auto = app.state::<AutomationState>();
    let mut inner = auto.inner.lock().map_err(|e| e.to_string())?;
    inner.descriptor = Some(descriptor);
    Ok(())
}

/// 读自动化日志尾部 (供 `logs.tail` 动词)。返回原始 JSONL 文本行。
#[tauri::command]
pub fn automation_log_tail(app: AppHandle, lines: Option<usize>) -> Result<Vec<String>, String> {
    let data_dir = app.state::<crate::AppState>().data_dir.clone();
    let n = lines.unwrap_or(100).clamp(1, 1000);
    Ok(journal::tail(&data_dir, n))
}

/// 进程退出前清掉 bridge.json,避免遗留陈旧的端口/token 文件。lib.rs 的窗口关闭事件调它。
pub fn cleanup_on_exit(app: &AppHandle) {
    if let Some(state) = app.try_state::<crate::AppState>() {
        bridge::remove(&state.data_dir);
    }
}
