//! Rust → 腾讯云 COS **前端直传** 三步链路 (presign → PUT → confirm)。
//!
//! ## 跟 [`upload_remote::do_multipart_upload`] 的区别
//!
//! - **multipart 中转**:文件字节 `POST /v1/files/upload` **经过 JiJing 服务器**
//!   再由服务端落对象存储。高并发下服务器入站带宽 / SakuraFrp 穿透成瓶颈。
//! - **本模块直传**:文件字节 **PUT 直达 COS**,服务器只签 URL (presign) + 写
//!   索引反查 (confirm),都是 KB 级请求。字节彻底不过服务器 —— 解决高并发
//!   上传慢。
//!
//! ## 三步
//!
//! 1. `POST /v1/files/presign {contentType,size,sha256}`:拿 COS 签名 PUT URL
//!    与 objectKey。**dedup 命中**(`cached=true`)时服务端直接返已有 URL,
//!    PUT/confirm 全省。
//! 2. `PUT <uploadUrl> <bytes>`:reqwest 直达 COS。`Content-Type` 与
//!    `Content-Length` 必须跟 presign 声明一致,否则 COS 在签名层 403(防伪造,
//!    见服务端 `TencentCosFileStorageService.generatePresignedUploadUrl`)。
//! 3. `POST /v1/files/confirm {objectKey,sha256,...}`:服务端 headObject 反查
//!    真实 size/contentType,写 `uploaded_files` 索引,返回最终公网 URL。
//!
//! ## Fallback 语义
//!
//! presign 返回"当前存储后端不支持前端直传"(服务端 `type=local`,没配 COS)
//! 时返回 `Ok(None)`,调用方 [`upload_remote::perform_leader_upload`] 自动退回
//! multipart 中转。其余环节失败返 `Err` —— **不静默退化**,避免把"直传变中转"
//! 伪装成成功而掩盖问题。
//!
//! ## CORS
//!
//! Tauri 桌面端用 Rust reqwest 直发 PUT,**不经浏览器**,不受 COS 桶 CORS 约束。
//! (Web 端若将来也要直传,需在 COS 桶配 CORS,见
//! `JiJing_Server/docs/COS_STORAGE_OPS.md` §1.1。)

use serde::{Deserialize, Serialize};

use super::config::apply_auth_headers;
use super::http_util::{read_body_bounded, root_cause_chain, send_with_retry};
use super::jijing_serde::{deserialize_opt_u64_str_or_num, ServerEnvelope};
use super::upload_remote::{truncate, ServerFileUploadResponse, UploadSource};

/// 上传用途分类 —— 跟 multipart 路径 `.text("purpose", ...)` 保持一致,
/// 确保两条链路写进 `uploaded_files.purpose` 的值统一。
const UPLOAD_PURPOSE: &str = "media-input";

/// `POST /v1/files/presign` 请求体 —— 跟服务端 `PresignRequest.java` 对齐。
#[derive(Serialize)]
struct PresignReqBody<'a> {
    #[serde(rename = "contentType")]
    content_type: &'a str,
    size: u64,
    sha256: &'a str,
    purpose: &'a str,
}

/// `POST /v1/files/confirm` 请求体 —— 跟服务端 `ConfirmRequest.java` 对齐。
#[derive(Serialize)]
struct ConfirmReqBody<'a> {
    #[serde(rename = "objectKey")]
    object_key: &'a str,
    sha256: &'a str,
    #[serde(rename = "contentType")]
    content_type: &'a str,
    size: u64,
    #[serde(rename = "originalFilename")]
    original_filename: &'a str,
    purpose: &'a str,
}

/// `POST /v1/files/presign` 响应 —— 跟服务端 `PresignResponse.java` 对齐。
///
/// 只解析本端用得到的字段;`expiryMinutes` / `existingId` / `existingPurpose`
/// 客户端 PUT/confirm 用不到,serde 自动忽略多余字段。
///
/// `existingSize` 是 Java `Long` → JSON 字符串形态,必须套
/// `deserialize_opt_u64_str_or_num`(见 [`super::jijing_serde`] 规约)。
#[derive(Debug, Deserialize)]
struct ServerPresignResponse {
    #[serde(rename = "uploadUrl")]
    upload_url: Option<String>,
    #[serde(rename = "objectKey")]
    object_key: Option<String>,
    #[serde(default)]
    cached: bool,
    #[serde(rename = "existingUrl")]
    existing_url: Option<String>,
    #[serde(rename = "existingSha256")]
    existing_sha256: Option<String>,
    #[serde(rename = "existingContentType")]
    existing_content_type: Option<String>,
    #[serde(
        rename = "existingSize",
        deserialize_with = "deserialize_opt_u64_str_or_num",
        default
    )]
    existing_size: Option<u64>,
}

/// presign 的三种结果。
enum PresignOutcome {
    /// 服务端签了 PUT URL,需客户端 PUT 字节后 confirm。
    Signed { upload_url: String, object_key: String },
    /// (user, sha256) dedup 命中,服务端直接返已有 URL,PUT/confirm 全省。
    Cached(ServerFileUploadResponse),
    /// 后端不支持前端直传(服务端 `type=local`),调用方应 fallback multipart。
    Unsupported,
}

/// 三步直传入口。返回:
/// - `Ok(Some(resp))` —— 直传成功(或 dedup 命中),`resp` 跟 multipart 同类型,
///   调用方下游处理零分支。
/// - `Ok(None)` —— 后端明确不支持直传,调用方 fallback 到 multipart 中转。
/// - `Err(e)` —— presign / PUT / confirm 任一真失败。**不静默退化**。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn try_direct_upload(
    http: &reqwest::Client,
    provider: &str,
    base_url: &str,
    api_key: &str,
    source: &UploadSource,
    sha256: &str,
    content_type: &str,
    filename: &str,
    size: u64,
) -> Result<Option<ServerFileUploadResponse>, String> {
    // 1. presign — 拿签名 PUT URL / dedup 命中 / 不支持信号
    let (upload_url, object_key) =
        match request_presign(http, provider, base_url, api_key, sha256, content_type, size).await? {
            PresignOutcome::Unsupported => return Ok(None),
            PresignOutcome::Cached(resp) => {
                tracing::info!("[upload_presign] dedup hit sha256={} url={}", sha256, resp.url);
                return Ok(Some(resp));
            }
            PresignOutcome::Signed { upload_url, object_key } => (upload_url, object_key),
        };

    // 2. 读字节 + PUT 直达 COS(字节不过 JiJing 服务器)
    let bytes = source.read_bytes().await?;
    put_to_cos(http, &upload_url, bytes, content_type).await?;

    // 3. confirm — 服务端 headObject 反查 + 写索引,拿最终公网 URL
    let resp = confirm_upload(
        http, provider, base_url, api_key, &object_key, sha256, content_type, filename, size,
    )
    .await?;

    // sha256 对账 —— 跟 multipart 路径同款防线:服务端反查算出的跟本地不符就拒,
    // 不把"错的 url"写进本地缓存。
    if !resp.sha256.eq_ignore_ascii_case(sha256) {
        return Err(format!(
            "confirm 服务端 sha256 不匹配 (local={}, server={}),上传被拒绝",
            sha256, resp.sha256
        ));
    }
    Ok(Some(resp))
}

/// 第 1 步:签发 PUT URL。区分 signed / dedup-cached / 后端不支持 三态。
async fn request_presign(
    http: &reqwest::Client,
    provider: &str,
    base_url: &str,
    api_key: &str,
    sha256: &str,
    content_type: &str,
    size: u64,
) -> Result<PresignOutcome, String> {
    let url = format!("{}/v1/files/presign", base_url.trim_end_matches('/'));
    let body = PresignReqBody { content_type, size, sha256, purpose: UPLOAD_PURPOSE };

    let resp = send_with_retry(
        || apply_auth_headers(http.post(&url).json(&body), provider, api_key),
        "presign",
        &url,
    )
    .await?;
    let status = resp.status();
    let text = read_body_bounded(resp, "presign").await?;

    match serde_json::from_str::<ServerEnvelope<ServerPresignResponse>>(&text) {
        Ok(env) if env.code == 200 => {
            let data = env.data.ok_or_else(|| "presign 响应 code=200 但缺 data".to_string())?;
            if data.cached {
                let url = data
                    .existing_url
                    .ok_or_else(|| "presign cached=true 但缺 existingUrl".to_string())?;
                Ok(PresignOutcome::Cached(ServerFileUploadResponse {
                    url,
                    sha256: data.existing_sha256.unwrap_or_else(|| sha256.to_string()),
                    content_type: data
                        .existing_content_type
                        .unwrap_or_else(|| content_type.to_string()),
                    size: data.existing_size.unwrap_or(size),
                    cached: true,
                }))
            } else {
                let upload_url =
                    data.upload_url.ok_or_else(|| "presign 未返回 uploadUrl".to_string())?;
                let object_key =
                    data.object_key.ok_or_else(|| "presign 未返回 objectKey".to_string())?;
                Ok(PresignOutcome::Signed { upload_url, object_key })
            }
        }
        // code != 200 —— 区分"后端不支持直传"(可 fallback) vs 真失败
        Ok(env) => {
            let msg = env.message.unwrap_or_else(|| format!("code={}", env.code));
            if is_unsupported_backend(&msg) {
                tracing::info!("[upload_presign] 后端不支持直传,fallback multipart: {}", msg);
                Ok(PresignOutcome::Unsupported)
            } else {
                Err(format!("presign 失败: {}", msg))
            }
        }
        Err(e) => {
            if status.is_success() {
                Err(format!("解析 presign 响应失败: {}, body={}", e, truncate(&text, 300)))
            } else {
                Err(format!("presign 失败 HTTP {}: {}", status.as_u16(), truncate(&text, 300)))
            }
        }
    }
}

/// 第 2 步:PUT 字节直达 COS。**不走 [`send_with_retry`]**:
/// - body 是整块 bytes,`Fn` 闭包重入会克隆大内存;
/// - COS 不是反代边缘节点,不存在 send_with_retry 针对的"复用 RST 僵尸连接"热点。
///
/// `Content-Type` 必须显式带且跟 presign 声明一致 —— 服务端已把它锁进 V4 签名,
/// 不一致 COS 直接 403。`Content-Length` 由 reqwest 按 `Vec<u8>` body 自动设精确
/// 值(非 chunked),同样满足绑定签名。
async fn put_to_cos(
    http: &reqwest::Client,
    upload_url: &str,
    bytes: Vec<u8>,
    content_type: &str,
) -> Result<(), String> {
    let resp = http
        .put(upload_url)
        .header("Content-Type", content_type)
        .body(bytes)
        .send()
        .await
        .map_err(|e| {
            format!("PUT 直传 COS 失败: url={} {}", truncate(upload_url, 120), root_cause_chain(&e))
        })?;

    let status = resp.status();
    if status.is_success() {
        return Ok(());
    }
    // COS 失败体是 XML,读出来帮助定位(403 签名不符 / 过期 / SignatureDoesNotMatch 等)
    let body = read_body_bounded(resp, "put-cos").await.unwrap_or_default();
    Err(format!("PUT 直传 COS 被拒 HTTP {}: {}", status.as_u16(), truncate(&body, 300)))
}

/// 第 3 步:确认上传完成,服务端反查 + 写索引,返回最终公网 URL。
#[allow(clippy::too_many_arguments)]
async fn confirm_upload(
    http: &reqwest::Client,
    provider: &str,
    base_url: &str,
    api_key: &str,
    object_key: &str,
    sha256: &str,
    content_type: &str,
    filename: &str,
    size: u64,
) -> Result<ServerFileUploadResponse, String> {
    let url = format!("{}/v1/files/confirm", base_url.trim_end_matches('/'));
    let body = ConfirmReqBody {
        object_key,
        sha256,
        content_type,
        size,
        original_filename: filename,
        purpose: UPLOAD_PURPOSE,
    };

    let resp = send_with_retry(
        || apply_auth_headers(http.post(&url).json(&body), provider, api_key),
        "confirm",
        &url,
    )
    .await?;
    let status = resp.status();
    let text = read_body_bounded(resp, "confirm").await?;

    if !status.is_success() {
        // 服务端异常也包成 R<T>,优先取 message
        if let Ok(env) = serde_json::from_str::<ServerEnvelope<serde_json::Value>>(&text) {
            if let Some(msg) = env.message {
                return Err(format!("confirm 失败 HTTP {}: {}", status.as_u16(), msg));
            }
        }
        return Err(format!("confirm 失败 HTTP {}: {}", status.as_u16(), truncate(&text, 300)));
    }

    let env: ServerEnvelope<ServerFileUploadResponse> = serde_json::from_str(&text)
        .map_err(|e| format!("解析 confirm 响应失败: {}, body={}", e, truncate(&text, 300)))?;
    if env.code != 200 {
        return Err(format!(
            "confirm 失败: {}",
            env.message.unwrap_or_else(|| format!("code={}", env.code))
        ));
    }
    env.data.ok_or_else(|| "confirm 响应 code=200 但缺 data".to_string())
}

/// 判定 presign 的失败是否是"服务端存储后端不支持前端直传"(type=local)。
/// 命中则调用方 fallback multipart。文案锚点见服务端
/// `UploadedFilePortAdapter.presign`:"当前存储后端不支持前端直传 ..."。
fn is_unsupported_backend(msg: &str) -> bool {
    msg.contains("不支持前端直传")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// signed 形态:拿到 uploadUrl + objectKey,cached=false。
    #[test]
    fn parses_signed_presign_response() {
        let body = r#"{"code":200,"message":"操作成功","data":{"uploadUrl":"https://jijing-1303012844.cos.ap-shanghai.myqcloud.com/media/input/1/20260604/abc.png?sign=xxx","objectKey":"media/input/1/20260604/abc.png","expiryMinutes":15,"cached":false},"success":true}"#;
        let env: ServerEnvelope<ServerPresignResponse> = serde_json::from_str(body).unwrap();
        assert_eq!(env.code, 200);
        let data = env.data.unwrap();
        assert!(!data.cached);
        assert!(data.upload_url.unwrap().contains("myqcloud.com"));
        assert_eq!(data.object_key.as_deref(), Some("media/input/1/20260604/abc.png"));
    }

    /// dedup 命中形态:existingSize 是 Long → 字符串,必须能解析(否则复现历史
    /// `invalid type: string, expected u64` bug)。
    #[test]
    fn parses_cached_presign_response_with_string_size() {
        let body = r#"{"code":200,"message":"操作成功","data":{"cached":true,"existingId":"file-2058","existingUrl":"https://cdn.jjowo.com/media/input/1/x.png","existingSha256":"abc123","existingContentType":"image/png","existingSize":"204800","existingPurpose":"media-input"},"success":true}"#;
        let env: ServerEnvelope<ServerPresignResponse> = serde_json::from_str(body).unwrap();
        let data = env.data.unwrap();
        assert!(data.cached);
        assert_eq!(data.existing_size, Some(204_800));
        assert_eq!(data.existing_content_type.as_deref(), Some("image/png"));
        assert_eq!(data.existing_url.as_deref(), Some("https://cdn.jjowo.com/media/input/1/x.png"));
    }

    /// 服务端 `type=local` 时的 fallback 文案必须被识别。
    #[test]
    fn unsupported_backend_message_recognized() {
        assert!(is_unsupported_backend(
            "当前存储后端不支持前端直传 (需配 jijing.storage.type=cos 或 minio)"
        ));
        assert!(!is_unsupported_backend("objectKey 不能为空"));
        assert!(!is_unsupported_backend("文件大小超出限制"));
    }

    /// 服务端将来加字段不应破坏解析。
    #[test]
    fn presign_response_ignores_unknown_fields() {
        let body = r#"{"uploadUrl":"https://x","objectKey":"k","cached":false,"expiryMinutes":30,"futureField":123}"#;
        let r: ServerPresignResponse = serde_json::from_str(body).unwrap();
        assert_eq!(r.object_key.as_deref(), Some("k"));
        assert!(r.upload_url.is_some());
    }

    /// existingSize 也接受数值形态(防御:万一服务端某版本没转字符串)。
    #[test]
    fn existing_size_accepts_number_form() {
        let body = r#"{"cached":true,"existingUrl":"https://x","existingSize":4096}"#;
        let r: ServerPresignResponse = serde_json::from_str(body).unwrap();
        assert_eq!(r.existing_size, Some(4096));
    }
}
