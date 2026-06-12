//! 自动化桥的线缆协议 —— 请求/响应信封与错误码。
//!
//! 三种入口 (REST `/v1/call`、MCP `/mcp`、应用内对话面板) 最终都规约成同一个
//! `CallRequest` → `CallResponse`,由前端 host (src/services/automation) 执行。
//! 这里只定义形状,不含任何业务逻辑。

use serde::{Deserialize, Serialize};
use serde_json::Value as Json;

/// 外部 → 桥的统一请求体 (`POST /v1/call` 的 body)。
#[derive(Debug, Clone, Deserialize)]
pub struct CallRequest {
    /// 动词名,如 `card.create` / `run.group`。
    pub verb: String,
    /// 动词参数,形状由各动词自定义 (前端 schema 校验)。缺省为 `null`。
    #[serde(default)]
    pub params: Json,
    /// 幂等/追踪用的请求 id;不传则服务端生成。
    #[serde(default, rename = "requestId")]
    pub request_id: Option<String>,
}

/// 桥 → 外部的统一响应体。`ok` 为真时带 `data`,否则带 `error`。
///
/// 前端 host 处理完动词后,用 `automation_respond` 把**完整**的本结构回传给 Rust;
/// Rust 仅做透传 + 落日志,不重组。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallResponse {
    pub ok: bool,
    #[serde(rename = "requestId")]
    pub request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Json>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<CallError>,
}

/// 错误信封。`code` 是闭集 (见下),`message` 是给人看的中文说明 (已脱敏)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallError {
    pub code: String,
    pub message: String,
}

impl CallResponse {
    // Rust 端只构造错误响应;成功响应由前端 host 构造并经 automation_respond 回传。
    // 本方法保持 ok/err 对称(单测用,未来 panel 直连路径可能用),故 allow dead_code。
    #[allow(dead_code)]
    pub fn ok(request_id: impl Into<String>, data: Json) -> Self {
        Self {
            ok: true,
            request_id: request_id.into(),
            data: Some(data),
            error: None,
        }
    }

    pub fn err(
        request_id: impl Into<String>,
        code: ErrorCode,
        message: impl Into<String>,
    ) -> Self {
        Self {
            ok: false,
            request_id: request_id.into(),
            data: None,
            error: Some(CallError {
                code: code.as_str().to_string(),
                message: message.into(),
            }),
        }
    }
}

/// 闭集错误码。新增动词不应引入新码;不够用时优先复用 `INTERNAL`。
///
/// 与前端 `src/services/automation/types.ts` 的 `ErrorCode` 一一对应,改一处必须改两处。
#[derive(Debug, Clone, Copy)]
pub enum ErrorCode {
    /// 桥未开启 —— 前端语义。Rust server 起来后到不了这分支,保留以对齐前端闭集。
    #[allow(dead_code)]
    Disabled,
    /// 鉴权失败 (token 缺失/不符)。
    Unauthorized,
    /// 请求体无法解析。
    InvalidArgs,
    /// 前端在超时窗口内没有回包。
    Timeout,
    /// 桥内部错误 (前端 host 未就绪 / panic 等)。
    Internal,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::Disabled => "DISABLED",
            ErrorCode::Unauthorized => "UNAUTHORIZED",
            ErrorCode::InvalidArgs => "INVALID_ARGS",
            ErrorCode::Timeout => "TIMEOUT",
            ErrorCode::Internal => "INTERNAL",
        }
    }
}

/// Rust → 前端的事件载荷 (`emit("automation:request", _)`)。
#[derive(Debug, Clone, Serialize)]
pub struct RequestEvent {
    #[serde(rename = "requestId")]
    pub request_id: String,
    pub verb: String,
    pub params: Json,
    /// 请求来源,用于日志区分:`bridge` = 外部 HTTP/MCP,`panel` = 应用内对话面板。
    pub source: &'static str,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ok_response_shape() {
        let r = CallResponse::ok("r_1", json!({ "a": 1 }));
        let s = serde_json::to_value(&r).unwrap();
        assert_eq!(s["ok"], true);
        assert_eq!(s["requestId"], "r_1");
        assert_eq!(s["data"]["a"], 1);
        // error 为 None 时不应出现在序列化结果里。
        assert!(s.get("error").is_none());
    }

    #[test]
    fn err_response_shape() {
        let r = CallResponse::err("r_2", ErrorCode::Timeout, "超时");
        let s = serde_json::to_value(&r).unwrap();
        assert_eq!(s["ok"], false);
        assert_eq!(s["error"]["code"], "TIMEOUT");
        assert_eq!(s["error"]["message"], "超时");
        assert!(s.get("data").is_none());
    }

    #[test]
    fn request_parses_with_defaults() {
        let req: CallRequest = serde_json::from_str(r#"{"verb":"card.create"}"#).unwrap();
        assert_eq!(req.verb, "card.create");
        assert!(req.params.is_null());
        assert!(req.request_id.is_none());
    }

    #[test]
    fn request_reads_camel_case_request_id() {
        let req: CallRequest =
            serde_json::from_str(r#"{"verb":"x","requestId":"abc","params":{"k":1}}"#).unwrap();
        assert_eq!(req.request_id.as_deref(), Some("abc"));
        assert_eq!(req.params["k"], 1);
    }

    #[test]
    fn error_codes_are_stable() {
        assert_eq!(ErrorCode::Disabled.as_str(), "DISABLED");
        assert_eq!(ErrorCode::Unauthorized.as_str(), "UNAUTHORIZED");
        assert_eq!(ErrorCode::InvalidArgs.as_str(), "INVALID_ARGS");
        assert_eq!(ErrorCode::Timeout.as_str(), "TIMEOUT");
        assert_eq!(ErrorCode::Internal.as_str(), "INTERNAL");
    }
}
