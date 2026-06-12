//! 本地 HTTP server (axum) —— 自动化桥的网络面。
//!
//! 只绑 `127.0.0.1`,三个端点:
//!   - `GET  /v1/health`  存活探测 (无需 token)。
//!   - `POST /v1/call`    统一 RPC,curl 兜底入口。
//!   - `POST /mcp`        MCP streamable HTTP (无状态),Claude Code / Codex 标准接入。
//!
//! 所有业务都不在这里:server 把请求 `emit` 给前端 host 执行,等前端经 `automation_respond`
//! 回包,再写 HTTP 响应。`/v1/call` 与 `/mcp` 的 `tools/call` 共用同一 `dispatch`。

use std::path::{Path, PathBuf};
use std::time::Duration;

use axum::{
    extract::{rejection::JsonRejection, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value as Json2};
use tokio::sync::oneshot;

use super::protocol::{CallRequest, CallResponse, ErrorCode, RequestEvent};
use super::{journal, AutomationState, API_VERSION, REQUEST_TIMEOUT_SECS};
use tauri::{AppHandle, Emitter, Manager};

/// server handler 共享的上下文 (每次请求 clone,都是廉价 clone)。
#[derive(Clone)]
pub struct ServerCtx {
    pub app: AppHandle,
    pub token: String,
    pub data_dir: PathBuf,
}

pub fn build_router(ctx: ServerCtx) -> Router {
    Router::new()
        .route("/v1/health", get(health))
        .route("/v1/call", post(handle_call))
        .route("/mcp", post(handle_mcp))
        .with_state(ctx)
}

fn gen_request_id() -> String {
    let id = uuid::Uuid::new_v4().simple().to_string();
    format!("r_{}", &id[..12])
}

/// 校验 `Authorization: Bearer {token}`。
fn auth_ok(headers: &HeaderMap, token: &str) -> bool {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .map(|t| t == token)
        .unwrap_or(false)
}

async fn health() -> impl IntoResponse {
    Json(json!({ "ok": true, "apiVersion": API_VERSION }))
}

/// 把一个 (verb, params) 派发给前端执行并等待回包。`/v1/call` 与 MCP `tools/call` 共用。
///
/// 时序:注册 oneshot → emit 事件 → 限时等待前端 `automation_respond` → 落日志 → 返回。
async fn dispatch(
    app: &AppHandle,
    data_dir: &Path,
    source: &'static str,
    verb: String,
    params: Json2,
    request_id: String,
) -> CallResponse {
    let started = chrono::Local::now().timestamp_millis();

    let (tx, rx) = oneshot::channel::<CallResponse>();
    {
        let state = app.state::<AutomationState>();
        state.register_pending(request_id.clone(), tx);
    }

    let event = RequestEvent {
        request_id: request_id.clone(),
        verb: verb.clone(),
        params,
        source,
    };
    if app.emit("automation:request", event).is_err() {
        app.state::<AutomationState>().take_pending(&request_id);
        return CallResponse::err(request_id, ErrorCode::Internal, "桥内部事件分发失败");
    }

    let outcome = tokio::time::timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS), rx).await;
    let resp = match outcome {
        Ok(Ok(r)) => r,
        // 前端 host 在回包前丢弃了 sender (极少见:host 卸载/重装)。
        Ok(Err(_)) => CallResponse::err(
            request_id.clone(),
            ErrorCode::Internal,
            "前端未返回结果 (host 可能未就绪)",
        ),
        Err(_) => {
            app.state::<AutomationState>().take_pending(&request_id);
            CallResponse::err(request_id.clone(), ErrorCode::Timeout, "前端处理超时")
        }
    };

    let ms = (chrono::Local::now().timestamp_millis() - started).max(0) as u64;
    let code = resp.error.as_ref().map(|e| e.code.as_str());
    let message = resp
        .error
        .as_ref()
        .map(|e| journal::clip_message(&e.message));
    journal::append(
        data_dir,
        &journal::Entry {
            ts: chrono::Local::now().to_rfc3339(),
            request_id: &request_id,
            verb: &verb,
            source,
            ok: resp.ok,
            ms,
            code,
            message,
        },
    );

    resp
}

async fn handle_call(
    State(ctx): State<ServerCtx>,
    headers: HeaderMap,
    body: Result<Json<CallRequest>, JsonRejection>,
) -> impl IntoResponse {
    if !auth_ok(&headers, &ctx.token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(CallResponse::err(
                "",
                ErrorCode::Unauthorized,
                "缺少或无效的 token",
            )),
        );
    }
    let req = match body {
        Ok(Json(r)) => r,
        Err(rej) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(CallResponse::err(
                    "",
                    ErrorCode::InvalidArgs,
                    format!("请求体解析失败: {rej}"),
                )),
            )
        }
    };
    let request_id = req.request_id.unwrap_or_else(gen_request_id);
    let resp = dispatch(&ctx.app, &ctx.data_dir, "bridge", req.verb, req.params, request_id).await;
    (StatusCode::OK, Json(resp))
}

// ── MCP (Model Context Protocol) streamable HTTP, 无状态模式 ──────────────
//
// 只实现 agent 接入必需的 4 个 JSON-RPC 方法。tools 的 schema 由前端 host 经
// `automation_set_descriptor` 推来缓存,tools/list 零延迟返回。

fn rpc_result(id: Json2, result: Json2) -> Json2 {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_error(id: Json2, code: i64, message: &str) -> Json2 {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

async fn handle_mcp(
    State(ctx): State<ServerCtx>,
    headers: HeaderMap,
    body: Result<Json<Json2>, JsonRejection>,
) -> impl IntoResponse {
    if !auth_ok(&headers, &ctx.token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(rpc_error(Json2::Null, -32001, "unauthorized")),
        );
    }
    let rpc = match body {
        Ok(Json(v)) => v,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(rpc_error(Json2::Null, -32700, "parse error")),
            )
        }
    };

    let id = rpc.get("id").cloned().unwrap_or(Json2::Null);
    let method = rpc.get("method").and_then(|m| m.as_str()).unwrap_or("");

    match method {
        "initialize" => (
            StatusCode::OK,
            Json(rpc_result(
                id,
                json!({
                    "protocolVersion": "2024-11-05",
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "aicat", "version": env!("CARGO_PKG_VERSION") }
                }),
            )),
        ),
        // 客户端发的初始化完成通知,无需结果。
        "notifications/initialized" | "notifications/cancelled" => {
            (StatusCode::OK, Json(json!({ "jsonrpc": "2.0" })))
        }
        "tools/list" => {
            let tools = ctx.app.state::<AutomationState>().descriptor_tools();
            (StatusCode::OK, Json(rpc_result(id, json!({ "tools": tools }))))
        }
        "tools/call" => {
            let params = rpc.get("params").cloned().unwrap_or(Json2::Null);
            let name = params
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or("")
                .to_string();
            if name.is_empty() {
                return (
                    StatusCode::OK,
                    Json(rpc_error(id, -32602, "missing tool name")),
                );
            }
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            let request_id = gen_request_id();
            let resp =
                dispatch(&ctx.app, &ctx.data_dir, "bridge", name, args, request_id).await;

            // 把统一信封转成 MCP tools/call 结果:成功 → data 的 JSON 文本;
            // 失败 → isError + 错误文本。两者都用单个 text content block。
            let mcp_result = if resp.ok {
                let text = serde_json::to_string(&resp.data.unwrap_or(Json2::Null))
                    .unwrap_or_else(|_| "{}".to_string());
                json!({ "content": [{ "type": "text", "text": text }] })
            } else {
                let err = resp.error.unwrap_or_else(|| super::protocol::CallError {
                    code: "INTERNAL".into(),
                    message: "未知错误".into(),
                });
                json!({
                    "content": [{ "type": "text", "text": format!("[{}] {}", err.code, err.message) }],
                    "isError": true
                })
            };
            (StatusCode::OK, Json(rpc_result(id, mcp_result)))
        }
        _ => (
            StatusCode::OK,
            Json(rpc_error(id, -32601, "method not found")),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;
    use serde_json::json;

    fn headers_with_auth(value: &'static str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("authorization", HeaderValue::from_static(value));
        h
    }

    #[test]
    fn auth_accepts_matching_bearer() {
        assert!(auth_ok(&headers_with_auth("Bearer secret"), "secret"));
    }

    #[test]
    fn auth_rejects_wrong_token() {
        assert!(!auth_ok(&headers_with_auth("Bearer wrong"), "secret"));
    }

    #[test]
    fn auth_rejects_missing_header() {
        assert!(!auth_ok(&HeaderMap::new(), "secret"));
    }

    #[test]
    fn auth_rejects_non_bearer_scheme() {
        assert!(!auth_ok(&headers_with_auth("Basic secret"), "secret"));
    }

    #[test]
    fn rpc_result_shape() {
        let r = rpc_result(json!(1), json!({ "ok": true }));
        assert_eq!(r["jsonrpc"], "2.0");
        assert_eq!(r["id"], 1);
        assert_eq!(r["result"]["ok"], true);
    }

    #[test]
    fn rpc_error_shape() {
        let r = rpc_error(json!("x"), -32601, "method not found");
        assert_eq!(r["jsonrpc"], "2.0");
        assert_eq!(r["id"], "x");
        assert_eq!(r["error"]["code"], -32601);
        assert_eq!(r["error"]["message"], "method not found");
    }

    #[test]
    fn request_id_has_prefix_and_length() {
        let id = gen_request_id();
        assert!(id.starts_with("r_"));
        assert_eq!(id.len(), 14); // "r_" + 12 hex
    }
}
