//! JiJing 服务端响应解析的统一 serde 助手。
//!
//! ## 为什么有这个模块
//!
//! JiJing 服务端 (Spring Boot + Jackson) 全局配置了
//! `WRITE_NUMBERS_AS_STRINGS`-style 序列化器, 把 Java `Long` 统一序列化成
//! JSON 字符串 —— 规避 JavaScript Number 53-bit 安全整数上限 (典型场景:
//! 雪花 ID 例如 `"file-2058649766147788801"`)。所以服务端返回的所有
//! `Long` / `Optional<Long>` 字段, 在 JSON 里都是 `"123"` 字符串形态。
//!
//! Rust 这边用 `u64` / `i64` 直接反序列化会挂在
//! `invalid type: string "123", expected u64`。这个模块提供的
//! `deserialize_*_str_or_num` 同时接受字符串和数值两种形态。
//!
//! ## 规约
//!
//! 凡是反序列化 **JiJing 服务端** 响应的 struct, 数值字段按以下规则标注:
//!
//! | Java 类型               | Rust 字段类型     | 处理                                                |
//! | ----------------------- | ----------------- | --------------------------------------------------- |
//! | `String` / `Boolean`    | 同名              | 原生 serde, 不用任何标注                            |
//! | `int` (32-bit, 非 Long) | `i32` / `u32`     | 原生 serde —— Jackson 不会把 int 转 String           |
//! | `Long`                  | `u64` / `i64`     | `#[serde(deserialize_with = "deserialize_u64_str_or_num")]` |
//! | `Optional<Long>`        | `Option<u64/i64>` | `#[serde(deserialize_with = "deserialize_opt_u64_str_or_num", default)]` |
//!
//! 这条规约只适用于 **JiJing 服务端响应**。上游第三方 API (OpenAI 兼容、
//! Comfly、Replicate 等) 用各自原生 serde 即可, 不要套这个模块。
//!
//! ## 谁来 review
//!
//! 新增 / 修改任何反序列化 JiJing 响应的 struct 时, 必须确认所有 `Long`
//! 字段都套了上面的 deserializer。漏一个就会复现历史 bug:
//! `解析上传响应失败: invalid type: string "2050933", expected u64`。

use serde::{Deserialize, Deserializer};

/// JiJing 通用响应信封 `R<T>` —— 跟 `R.java` 对齐。
///
/// `code = 200` 才算成功; 非 200 时 `message` 是面向用户的可读文案。
/// `data` 失败时通常缺失或为 `null`, 所以用 `Option<T>`。
///
/// `code` 是 Java `int` (不是 `Long`), 所以 Jackson 不会转字符串, 用原生
/// `i32` 即可。`message` / `data` 缺失时 serde 自动当 `None`, 不需要
/// `#[serde(default)]` (后者会要求 `T: Default`, 收紧调用方约束)。
#[derive(Debug, Deserialize)]
pub struct ServerEnvelope<T> {
    pub code: i32,
    pub message: Option<String>,
    pub data: Option<T>,
}

/// JSON `Long` 字段 → `u64`。同时接受 `"123"` 字符串和 `123` 数值。
///
/// 用法: `#[serde(deserialize_with = "deserialize_u64_str_or_num")]`
pub fn deserialize_u64_str_or_num<'de, D>(de: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    use serde::de::Error;
    match serde_json::Value::deserialize(de)? {
        serde_json::Value::Number(n) => n
            .as_u64()
            .ok_or_else(|| D::Error::custom(format!("数值字段非 u64: {}", n))),
        serde_json::Value::String(s) => s
            .parse::<u64>()
            .map_err(|e| D::Error::custom(format!("字符串无法解析为 u64 ({}): {}", s, e))),
        other => Err(D::Error::custom(format!(
            "字段类型既不是 number 也不是 string: {}",
            other
        ))),
    }
}

/// JSON `Long` 字段 → `i64`。同时接受 `"-123"` 字符串和 `-123` 数值。
///
/// 用法: `#[serde(deserialize_with = "deserialize_i64_str_or_num")]`
#[allow(dead_code)] // 公共基础设施:目前业务只用 u64, i64 给未来接口预留
pub fn deserialize_i64_str_or_num<'de, D>(de: D) -> Result<i64, D::Error>
where
    D: Deserializer<'de>,
{
    use serde::de::Error;
    match serde_json::Value::deserialize(de)? {
        serde_json::Value::Number(n) => n
            .as_i64()
            .ok_or_else(|| D::Error::custom(format!("数值字段非 i64: {}", n))),
        serde_json::Value::String(s) => s
            .parse::<i64>()
            .map_err(|e| D::Error::custom(format!("字符串无法解析为 i64 ({}): {}", s, e))),
        other => Err(D::Error::custom(format!(
            "字段类型既不是 number 也不是 string: {}",
            other
        ))),
    }
}

/// JSON `Optional<Long>` 字段 → `Option<u64>`。
///
/// 接受 `null` / 缺失 / `"123"` / `123` 全部形态。
/// 用法: `#[serde(deserialize_with = "deserialize_opt_u64_str_or_num", default)]`
#[allow(dead_code)] // 公共基础设施:给未来接口预留 (Optional<Long> 形态)
pub fn deserialize_opt_u64_str_or_num<'de, D>(de: D) -> Result<Option<u64>, D::Error>
where
    D: Deserializer<'de>,
{
    use serde::de::Error;
    match Option::<serde_json::Value>::deserialize(de)? {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::Number(n)) => n
            .as_u64()
            .map(Some)
            .ok_or_else(|| D::Error::custom(format!("数值字段非 u64: {}", n))),
        Some(serde_json::Value::String(s)) => s
            .parse::<u64>()
            .map(Some)
            .map_err(|e| D::Error::custom(format!("字符串无法解析为 u64 ({}): {}", s, e))),
        Some(other) => Err(D::Error::custom(format!(
            "字段类型既不是 number 也不是 string: {}",
            other
        ))),
    }
}

/// JSON `Optional<Long>` 字段 → `Option<i64>`。
///
/// 用法: `#[serde(deserialize_with = "deserialize_opt_i64_str_or_num", default)]`
#[allow(dead_code)] // 公共基础设施:给未来接口预留
pub fn deserialize_opt_i64_str_or_num<'de, D>(de: D) -> Result<Option<i64>, D::Error>
where
    D: Deserializer<'de>,
{
    use serde::de::Error;
    match Option::<serde_json::Value>::deserialize(de)? {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::Number(n)) => n
            .as_i64()
            .map(Some)
            .ok_or_else(|| D::Error::custom(format!("数值字段非 i64: {}", n))),
        Some(serde_json::Value::String(s)) => s
            .parse::<i64>()
            .map(Some)
            .map_err(|e| D::Error::custom(format!("字符串无法解析为 i64 ({}): {}", s, e))),
        Some(other) => Err(D::Error::custom(format!(
            "字段类型既不是 number 也不是 string: {}",
            other
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Deserialize)]
    struct U64Holder {
        #[serde(deserialize_with = "deserialize_u64_str_or_num")]
        v: u64,
    }

    #[derive(Debug, Deserialize)]
    struct I64Holder {
        #[serde(deserialize_with = "deserialize_i64_str_or_num")]
        v: i64,
    }

    #[derive(Debug, Deserialize)]
    struct OptU64Holder {
        #[serde(deserialize_with = "deserialize_opt_u64_str_or_num", default)]
        v: Option<u64>,
    }

    #[derive(Debug, Deserialize)]
    struct OptI64Holder {
        #[serde(deserialize_with = "deserialize_opt_i64_str_or_num", default)]
        v: Option<i64>,
    }

    // ── u64 ─────────────────────────────────────────────────────────────

    #[test]
    fn u64_accepts_number() {
        let h: U64Holder = serde_json::from_str(r#"{"v":2050933}"#).unwrap();
        assert_eq!(h.v, 2_050_933);
    }

    #[test]
    fn u64_accepts_string() {
        let h: U64Holder = serde_json::from_str(r#"{"v":"2050933"}"#).unwrap();
        assert_eq!(h.v, 2_050_933);
    }

    /// 服务端 ID 用雪花算法超出 JS Number 安全范围, 必须能解析。
    #[test]
    fn u64_accepts_large_string_beyond_js_safe_int() {
        let h: U64Holder = serde_json::from_str(r#"{"v":"2058649766147788801"}"#).unwrap();
        assert_eq!(h.v, 2_058_649_766_147_788_801);
    }

    #[test]
    fn u64_rejects_garbage_string() {
        let err = serde_json::from_str::<U64Holder>(r#"{"v":"not-a-number"}"#).unwrap_err();
        assert!(err.to_string().contains("无法解析为 u64"));
    }

    #[test]
    fn u64_rejects_negative_string() {
        let err = serde_json::from_str::<U64Holder>(r#"{"v":"-1"}"#).unwrap_err();
        assert!(err.to_string().contains("无法解析为 u64"));
    }

    #[test]
    fn u64_rejects_bool() {
        let err = serde_json::from_str::<U64Holder>(r#"{"v":true}"#).unwrap_err();
        assert!(err.to_string().contains("既不是 number 也不是 string"));
    }

    // ── i64 ─────────────────────────────────────────────────────────────

    #[test]
    fn i64_accepts_signed_string() {
        let h: I64Holder = serde_json::from_str(r#"{"v":"-9223372036854775808"}"#).unwrap();
        assert_eq!(h.v, i64::MIN);
    }

    #[test]
    fn i64_accepts_number() {
        let h: I64Holder = serde_json::from_str(r#"{"v":-42}"#).unwrap();
        assert_eq!(h.v, -42);
    }

    // ── Option<u64> ─────────────────────────────────────────────────────

    #[test]
    fn opt_u64_accepts_null() {
        let h: OptU64Holder = serde_json::from_str(r#"{"v":null}"#).unwrap();
        assert_eq!(h.v, None);
    }

    #[test]
    fn opt_u64_accepts_missing() {
        let h: OptU64Holder = serde_json::from_str(r#"{}"#).unwrap();
        assert_eq!(h.v, None);
    }

    #[test]
    fn opt_u64_accepts_string_form() {
        let h: OptU64Holder = serde_json::from_str(r#"{"v":"100"}"#).unwrap();
        assert_eq!(h.v, Some(100));
    }

    #[test]
    fn opt_u64_accepts_number_form() {
        let h: OptU64Holder = serde_json::from_str(r#"{"v":100}"#).unwrap();
        assert_eq!(h.v, Some(100));
    }

    // ── Option<i64> ─────────────────────────────────────────────────────

    #[test]
    fn opt_i64_round_trip_forms() {
        let null: OptI64Holder = serde_json::from_str(r#"{"v":null}"#).unwrap();
        let missing: OptI64Holder = serde_json::from_str(r#"{}"#).unwrap();
        let str_form: OptI64Holder = serde_json::from_str(r#"{"v":"-5"}"#).unwrap();
        let num_form: OptI64Holder = serde_json::from_str(r#"{"v":-5}"#).unwrap();
        assert_eq!(null.v, None);
        assert_eq!(missing.v, None);
        assert_eq!(str_form.v, Some(-5));
        assert_eq!(num_form.v, Some(-5));
    }

    // ── ServerEnvelope ──────────────────────────────────────────────────

    #[derive(Debug, Deserialize)]
    struct Empty {}

    #[test]
    fn envelope_success_with_data() {
        let body = r#"{"code":200,"message":"操作成功","data":{}}"#;
        let env: ServerEnvelope<Empty> = serde_json::from_str(body).unwrap();
        assert_eq!(env.code, 200);
        assert_eq!(env.message.as_deref(), Some("操作成功"));
        assert!(env.data.is_some());
    }

    #[test]
    fn envelope_failure_without_data() {
        let body = r#"{"code":400,"message":"参数错误"}"#;
        let env: ServerEnvelope<Empty> = serde_json::from_str(body).unwrap();
        assert_eq!(env.code, 400);
        assert_eq!(env.message.as_deref(), Some("参数错误"));
        assert!(env.data.is_none());
    }

    #[test]
    fn envelope_passes_unknown_fields_through() {
        // 服务端可能加 success / requestId 等顶级字段, 不应破坏解析。
        let body = r#"{"code":200,"message":"ok","data":{},"success":true,"requestId":"abc"}"#;
        let env: ServerEnvelope<Empty> = serde_json::from_str(body).unwrap();
        assert_eq!(env.code, 200);
    }
}
