//! bridge.json 发现文件 + token 生成。
//!
//! 外部 AI 工具靠 `{data_dir}/automation/bridge.json` 找到端口与 token:
//! ```jsonc
//! { "port": 11420, "token": "…", "pid": 1234, "appVersion": "1.3.8", "apiVersion": 1 }
//! ```
//! 桥开启时写,关闭/退出时删。token 每次开启随机重生 (不持久化),所以泄漏一次的影响
//! 仅限本次会话。文件权限依赖 OS 用户隔离 —— 威胁模型与 Chrome remote-debugging 同级,
//! 详见 docs/automation/自动化接口-设计与施工图.md §3.1。

use std::path::{Path, PathBuf};

use serde::Serialize;

/// bridge.json 的内容。字段名即文件里的 key (camelCase)。
#[derive(Serialize)]
pub struct BridgeInfo {
    pub port: u16,
    pub token: String,
    pub pid: u32,
    #[serde(rename = "appVersion")]
    pub app_version: String,
    #[serde(rename = "apiVersion")]
    pub api_version: u32,
}

fn bridge_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("automation")
}

fn bridge_path(data_dir: &Path) -> PathBuf {
    bridge_dir(data_dir).join("bridge.json")
}

/// 写 bridge.json。目录不存在则创建。
pub fn write(data_dir: &Path, info: &BridgeInfo) -> std::io::Result<()> {
    let dir = bridge_dir(data_dir);
    std::fs::create_dir_all(&dir)?;
    let json = serde_json::to_string_pretty(info)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    std::fs::write(bridge_path(data_dir), json)
}

/// 删除 bridge.json。文件不存在不算错。
pub fn remove(data_dir: &Path) {
    let _ = std::fs::remove_file(bridge_path(data_dir));
}

/// 生成 64 位十六进制随机 token。
///
/// 两个 v4 UUID (各 128bit,OS RNG) 拼接取 hex —— 共 256bit 熵,远超本地鉴权所需,
/// 且不引入额外随机数依赖 (uuid 已在 Cargo.toml)。
pub fn gen_token() -> String {
    let a = uuid::Uuid::new_v4().simple().to_string();
    let b = uuid::Uuid::new_v4().simple().to_string();
    format!("{a}{b}")
}

/// 随二进制编译进来的 AGENTS.md 操作手册(仓库根那份)。
const AGENTS_MANUAL: &str = include_str!("../../../AGENTS.md");

/// 把 AGENTS.md 写到 automation 目录,和 bridge.json 并排。
///
/// 用 `include_str!` 编译进二进制 → 不依赖 NSIS/bundle 打包、三端一致、运行时必定存在。
/// 外部 AI 工具在数据目录的 `automation/` 下既能拿到连接信息(bridge.json),也能读到怎么用
/// (AGENTS.md)。每次开启桥都覆盖写,保证手册随版本更新。
pub fn write_manual(data_dir: &Path) {
    let dir = data_dir.join("automation");
    if std::fs::create_dir_all(&dir).is_ok() {
        let _ = std::fs::write(dir.join("AGENTS.md"), AGENTS_MANUAL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_is_64_hex_chars() {
        let t = gen_token();
        assert_eq!(t.len(), 64);
        assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn tokens_are_unique() {
        assert_ne!(gen_token(), gen_token());
    }

    #[test]
    fn write_creates_then_remove_deletes() {
        let dir = tempfile::tempdir().unwrap();
        let info = BridgeInfo {
            port: 11420,
            token: "tok".into(),
            pid: 1,
            app_version: "1.3.8".into(),
            api_version: 1,
        };
        write(dir.path(), &info).unwrap();

        let path = dir.path().join("automation").join("bridge.json");
        assert!(path.exists());
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("\"port\": 11420"));
        assert!(content.contains("\"apiVersion\": 1"));
        assert!(content.contains("\"appVersion\": \"1.3.8\""));

        remove(dir.path());
        assert!(!path.exists());
        // 再删一次不应 panic(文件已不存在)。
        remove(dir.path());
    }
}
