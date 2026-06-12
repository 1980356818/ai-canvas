//! 自动化桥的请求级日志 —— 每个请求一行 JSONL,落 `{data_dir}/logs/automation-YYYYMMDD.jsonl`。
//!
//! 这是**外部进程可读**的排障通道:agent 经 `logs.tail` 动词、客服经文件,看到同一份记录。
//! 与 Rust 的 `app.log` (tracing) 互补 —— 那个是开发视角的全量日志,这个是面向自动化调用方的
//! 结构化审计。
//!
//! 脱敏:本模块**只记动词名/结果/耗时/错误码**,绝不写 `params` 或任何卡片内容,
//! 因此天然不泄漏 prompt / api key / 媒体内容。`message` 截断到 200 字符再落盘。

use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// 一条请求日志。字段顺序固定,方便 `grep`/肉眼对齐。
#[derive(Serialize)]
pub struct Entry<'a> {
    pub ts: String,
    #[serde(rename = "requestId")]
    pub request_id: &'a str,
    pub verb: &'a str,
    pub source: &'a str,
    pub ok: bool,
    pub ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

fn log_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("logs")
}

fn today_file(data_dir: &Path) -> PathBuf {
    let day = chrono::Local::now().format("%Y%m%d");
    log_dir(data_dir).join(format!("automation-{day}.jsonl"))
}

/// 追加一行。任何 IO 失败仅静默吞掉 —— 日志不该影响主流程。
pub fn append(data_dir: &Path, entry: &Entry<'_>) {
    let dir = log_dir(data_dir);
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let Ok(line) = serde_json::to_string(entry) else {
        return;
    };
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(today_file(data_dir))
    {
        let _ = writeln!(f, "{line}");
    }
    prune_old(&dir);
}

/// 读当天文件最后 `lines` 行 (倒序文件按时间天然递增,取尾即最新)。
/// 返回原始 JSONL 文本行,前端 `logs.tail` 动词原样回给调用方。
pub fn tail(data_dir: &Path, lines: usize) -> Vec<String> {
    let path = today_file(data_dir);
    let Ok(content) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let all: Vec<&str> = content.lines().filter(|l| !l.trim().is_empty()).collect();
    let start = all.len().saturating_sub(lines);
    all[start..].iter().map(|s| s.to_string()).collect()
}

/// 截断 message,避免单行过长 (上游错误文本可能很长)。
pub fn clip_message(msg: &str) -> String {
    const MAX: usize = 200;
    if msg.chars().count() <= MAX {
        return msg.to_string();
    }
    let truncated: String = msg.chars().take(MAX).collect();
    format!("{truncated}…")
}

/// 清掉 14 天前的日志文件,避免无限增长。best-effort。
fn prune_old(dir: &Path) {
    const KEEP_DAYS: i64 = 14;
    let cutoff = chrono::Local::now() - chrono::Duration::days(KEEP_DAYS);
    let cutoff_stamp = cutoff.format("%Y%m%d").to_string();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        // 形如 automation-20260613.jsonl;比字符串即可 (定长 YYYYMMDD 字典序 = 时间序)。
        if let Some(stamp) = name
            .strip_prefix("automation-")
            .and_then(|s| s.strip_suffix(".jsonl"))
        {
            if stamp < cutoff_stamp.as_str() {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry<'a>(request_id: &'a str, verb: &'a str, ok: bool) -> Entry<'a> {
        Entry {
            ts: "2026-06-13T10:00:00+08:00".into(),
            request_id,
            verb,
            source: "bridge",
            ok,
            ms: 12,
            code: None,
            message: None,
        }
    }

    #[test]
    fn clip_short_message_unchanged() {
        assert_eq!(clip_message("hi"), "hi");
    }

    #[test]
    fn clip_long_message_truncates_with_ellipsis() {
        let long = "x".repeat(500);
        let clipped = clip_message(&long);
        // 200 字符 + 省略号
        assert_eq!(clipped.chars().count(), 201);
        assert!(clipped.ends_with('…'));
    }

    #[test]
    fn append_then_tail_returns_lines_in_order() {
        let dir = tempfile::tempdir().unwrap();
        append(dir.path(), &entry("r1", "project.create", true));
        let mut e2 = entry("r2", "run.card", false);
        e2.code = Some("TIMEOUT");
        e2.message = Some("前端处理超时".into());
        append(dir.path(), &e2);

        let lines = tail(dir.path(), 10);
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("r1"));
        assert!(lines[1].contains("r2"));
        assert!(lines[1].contains("TIMEOUT"));
        // 成功行不应带 code 字段(skip none)。
        assert!(!lines[0].contains("code"));
    }

    #[test]
    fn tail_missing_file_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert!(tail(dir.path(), 10).is_empty());
    }

    #[test]
    fn tail_respects_line_limit() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..5 {
            append(dir.path(), &entry(&format!("r{i}"), "v", true));
        }
        let lines = tail(dir.path(), 2);
        assert_eq!(lines.len(), 2);
        assert!(lines[1].contains("r4"));
    }
}
