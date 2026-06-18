//! 模板素材本地缓存。前端拉到模板定义(图为极境 NAS 的**内容哈希 URL**)后,调
//! [`sync_template_assets`] 把所有图下到 `{data_dir}/template-assets/<哈希文件名>`,
//! 返回 url → 本地相对路径映射;前端用 `lib/media.ts::getDisplayUrl(rel)` 转成
//! `asset://` 喂 `<img>`。
//!
//! ## 为什么这样设计(对比浏览器缓存)
//! - **内容哈希命名**:文件名末段就是 `<base>.<sha16>.<ext>`。换图 = 哈希变 = URL 变 →
//!   本地没有这个新名字 → 重下;旧文件不在新清单里被 prune。**永不 stale**。
//! - **存在即跳过**:文件名含哈希,存在就一定是对的内容 → 不重下 → **下载一次**(硬保证,
//!   不像浏览器缓存会被淘汰)。
//! - **可控、可整理**:都在一个可见目录里,prune 清旧版本。
//! - 跟 `frame_extract.rs` 的 ffmpeg 下载器同一套(reqwest 流式 + .partial 原子改名),
//!   全 app 只有一种「下资源」机制。走 Rust 出站,合规。

use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, OnceLock};

use futures_util::StreamExt;
use serde::Serialize;
use tauri::State;
use tokio::io::AsyncWriteExt;

use crate::AppState;

const SUBDIR: &str = "template-assets";
/// 单文件下载并发上限。
const CONCURRENCY: usize = 6;

/// 串行化整次同步。`load()` 可能被并发调用(React StrictMode 双挂载 / dev HMR / 重入),
/// 而本函数末尾的 prune 会删掉目录里**所有** `.partial`。两次调用一旦重叠,后者的 prune
/// 会把前者**正在下载**的 `.partial` 删掉 → 前者 `rename(.partial → 正式名)` 报
/// `os error 2`(找不到文件)→ 本地零落地、封面裂图(线上实测 59/59 全栽在这)。
/// 全局串行:后到的调用等前一次跑完,届时文件已在 → 秒级跳过,无竞争。
static SYNC_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

fn sync_lock() -> &'static tokio::sync::Mutex<()> {
    SYNC_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

#[derive(Serialize)]
pub struct AssetMapping {
    pub url: String,
    /// data_dir 下相对路径(如 `template-assets/white-bg.<sha16>.jpg`);下载失败为 `null`。
    pub rel: Option<String>,
}

/// 从 URL 取末段做本地文件名(已含内容哈希)。拒绝路径穿越 / 非法字符。
fn filename_from_url(url: &str) -> Option<String> {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    let name = path.rsplit('/').next()?;
    if name.is_empty() || name.contains("..") || name.contains('\\') {
        return None;
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
    {
        return None;
    }
    Some(name.to_string())
}

async fn download_one(
    client: &reqwest::Client,
    url: &str,
    dir: &Path,
    name: &str,
) -> Result<(), String> {
    let final_path = dir.join(name);
    if final_path.is_file() {
        return Ok(()); // 哈希命名 → 存在即正确,跳过(下载一次)
    }
    let tmp_path = dir.join(format!("{}.partial", name));
    let _ = tokio::fs::remove_file(&tmp_path).await;

    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("GET {} 失败: {:#}", url, e))?;
    if !resp.status().is_success() {
        return Err(format!("GET {} HTTP {}", url, resp.status()));
    }
    let expected = resp.content_length();

    let mut file = tokio::fs::File::create(&tmp_path)
        .await
        .map_err(|e| format!("create {:?} 失败: {}", tmp_path, e))?;
    let mut received: u64 = 0;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("读 chunk 失败: {:#}", e))?;
        received += chunk.len() as u64;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("写 {:?} 失败: {}", tmp_path, e))?;
    }
    file.flush().await.map_err(|e| format!("flush 失败: {}", e))?;
    drop(file);

    if let Some(exp) = expected {
        if exp != received {
            let _ = tokio::fs::remove_file(&tmp_path).await;
            return Err(format!("长度不符: 期望 {} 实际 {}(可能截断)", exp, received));
        }
    }

    let _ = tokio::fs::remove_file(&final_path).await;
    tokio::fs::rename(&tmp_path, &final_path)
        .await
        .map_err(|e| format!("rename {:?} → {:?} 失败: {}", tmp_path, final_path, e))?;
    Ok(())
}

/// 同步模板图到本地:下载缺失的、清理孤儿(旧版本/已删模板),返回 url → 相对路径映射。
///
/// 幂等:重复调只下新增/变更的图(文件名含哈希,存在即跳过),其余瞬时返回。
#[tauri::command]
pub async fn sync_template_assets(
    state: State<'_, AppState>,
    urls: Vec<String>,
) -> Result<Vec<AssetMapping>, String> {
    // 串行化:避免并发调用的 prune 删掉彼此在途的 .partial(见 sync_lock 注释)。
    let _guard = sync_lock().lock().await;

    let dir = Arc::new(state.data_dir.join(SUBDIR));
    tokio::fs::create_dir_all(dir.as_path())
        .await
        .map_err(|e| format!("创建 {:?} 失败: {}", dir, e))?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("构建 HTTP client 失败: {:#}", e))?;

    // 去重
    let mut seen = HashSet::new();
    let unique: Vec<String> = urls.into_iter().filter(|u| seen.insert(u.clone())).collect();
    // 期望保留的文件名(无论本次是否下载成功,都不能被 prune 掉)
    let keep: HashSet<String> = unique.iter().filter_map(|u| filename_from_url(u)).collect();

    let results: Vec<AssetMapping> = futures_util::stream::iter(unique)
        .map(|url| {
            let client = client.clone();
            let dir = dir.clone();
            async move {
                let name = match filename_from_url(&url) {
                    Some(n) => n,
                    None => return AssetMapping { url, rel: None },
                };
                match download_one(&client, &url, dir.as_path(), &name).await {
                    Ok(()) => AssetMapping {
                        rel: Some(format!("{}/{}", SUBDIR, name)),
                        url,
                    },
                    Err(e) => {
                        tracing::warn!(url = %url, error = %e, "模板图下载失败");
                        AssetMapping { url, rel: None }
                    }
                }
            }
        })
        .buffer_unordered(CONCURRENCY)
        .collect()
        .await;

    // prune 孤儿(旧哈希版本 / 已删模板的图)+ 残留 .partial → 目录整洁
    if let Ok(mut rd) = tokio::fs::read_dir(dir.as_path()).await {
        while let Ok(Some(entry)) = rd.next_entry().await {
            let fname = entry.file_name().to_string_lossy().to_string();
            if fname.ends_with(".partial") || !keep.contains(&fname) {
                let _ = tokio::fs::remove_file(entry.path()).await;
            }
        }
    }

    Ok(results)
}
