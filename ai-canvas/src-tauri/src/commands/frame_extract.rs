//! 视频关键帧抽取。
//!
//! 前端从上游 chat 节点拿到分镜分析 JSON,提取每个 shot 的 keyframe_timestamp,
//! 一次性调本命令把所有时间点的帧抽出来。
//!
//! ffmpeg-sidecar 走的是「下载预编译二进制」路线:
//!   - 首次使用时 auto_download() 拉一份 ffmpeg 到 cache 目录(~80MB)
//!   - 后续直接复用
//!   - 不依赖 C/C++ 工具链,Windows/macOS 不会因为缺 MSVC/Xcode 而炸
//!
//! 安全:video_path 解析后必须落在 data_dir 子树内(防 SSRF / 路径越权)。

use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::State;
use tokio::sync::Mutex;

use crate::AppState;

// ── ffmpeg 准备状态 ────────────────────────────────────────────────────
//
// 第一次调用时下载,后续直接复用。OnceLock<Mutex<bool>> 而不是 OnceLock<bool>:
// 因为 ensure_ffmpeg 是 async 的,要在 .await 跨点持有锁,普通 Cell 不够。

static FFMPEG_READY: OnceLock<Mutex<bool>> = OnceLock::new();

async fn ensure_ffmpeg() -> Result<(), String> {
    let cell = FFMPEG_READY.get_or_init(|| Mutex::new(false));
    let mut ready = cell.lock().await;
    if *ready {
        return Ok(());
    }

    let res = tokio::task::spawn_blocking(|| -> Result<(), String> {
        if ffmpeg_sidecar::command::ffmpeg_is_installed() {
            return Ok(());
        }
        ffmpeg_sidecar::download::auto_download()
            .map_err(|e| format!("ffmpeg 自动下载失败: {}", e))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("ffmpeg 准备线程出错: {}", e))?;

    res?;
    *ready = true;
    Ok(())
}

// ── 主命令 ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn extract_frames_at_timestamps(
    state: State<'_, AppState>,
    video_path: String,
    timestamps: Vec<f64>,
) -> Result<Vec<String>, String> {
    if timestamps.is_empty() {
        return Err("时间戳列表为空".to_string());
    }
    if timestamps.len() > 100 {
        return Err(format!("时间戳过多({} > 100),请缩减", timestamps.len()));
    }

    // 远程 URL 暂不支持(需要先下载,留给后续迭代)
    if video_path.starts_with("http://") || video_path.starts_with("https://") {
        return Err("暂不支持远程视频 URL,请先把视频拖到画布做本地化".to_string());
    }

    let data_dir = state.data_dir.clone();
    let abs_video = resolve_video_path(&video_path, &data_dir)?;

    ensure_ffmpeg().await?;

    // 视频 sha 做目录区分,避免不同视频的帧互相覆盖
    let sha = {
        let p = abs_video.clone();
        tokio::task::spawn_blocking(move || compute_sha256(&p))
            .await
            .map_err(|e| format!("sha256 线程出错: {}", e))??
    };
    let short_sha = &sha[..16];

    let out_dir = data_dir.join("media").join("keyframes").join(short_sha);
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("创建关键帧目录失败: {}", e))?;

    // 串行抽帧:每帧 ~50-200ms,N 帧总耗时可控;并发会撞 IO/磁盘 cache
    let mut results = Vec::with_capacity(timestamps.len());
    for (i, ts) in timestamps.iter().enumerate() {
        let out_name = format!("frame_{:03}.jpg", i + 1);
        let out_path = out_dir.join(&out_name);

        let video_str = abs_video.to_string_lossy().to_string();
        let out_str = out_path.to_string_lossy().to_string();
        let ts_val = *ts;
        let idx_for_err = i + 1;

        let join_result = tokio::task::spawn_blocking(move || -> Result<(), String> {
            use ffmpeg_sidecar::command::FfmpegCommand;

            // -ss 在 -i 前面 = 快速 seek(关键帧附近);精度足够(秒级语义关键帧不要求帧级)
            // -frames:v 1 = 只输出一帧
            // -q:v 5 = JPEG 质量(1-31,越低越好,5 ≈ 高质量但文件不大)
            // -y = 覆盖已存在文件
            let mut child = FfmpegCommand::new()
                .args([
                    "-y",
                    "-ss",
                    &format!("{:.3}", ts_val),
                    "-i",
                    &video_str,
                    "-frames:v",
                    "1",
                    "-q:v",
                    "5",
                    &out_str,
                ])
                .spawn()
                .map_err(|e| format!("ffmpeg spawn 失败: {}", e))?;

            let status = child
                .as_inner_mut()
                .wait()
                .map_err(|e| format!("ffmpeg wait 失败: {}", e))?;

            if !status.success() {
                return Err(format!("ffmpeg 退出码: {:?}", status.code()));
            }
            Ok(())
        })
        .await;

        match join_result {
            Ok(Ok(())) => {}
            Ok(Err(e)) => return Err(format!("抽第 {} 帧失败: {}", idx_for_err, e)),
            Err(e) => return Err(format!("抽帧线程出错(第 {} 帧): {}", idx_for_err, e)),
        }

        if !out_path.is_file() {
            return Err(format!(
                "第 {} 帧未生成: ffmpeg 退出成功但没写出 {:?}",
                idx_for_err, out_path
            ));
        }

        let rel = format!("media/keyframes/{}/{}", short_sha, out_name);
        results.push(rel);
    }

    Ok(results)
}

// ── 工具函数 ──────────────────────────────────────────────────────────

/// 解析视频路径,与 upload_remote::resolve_input_path 同样的安全策略。
///
/// 支持:
/// - "local://media/videos/xxx.mp4"
/// - 绝对路径(Windows `C:\...` / Unix `/...`)
/// - 相对 data_dir 的路径 `"media/videos/xxx.mp4"`
///
/// 安全:解析后必须是文件 + 落在 `data_dir` 子树内。
fn resolve_video_path(input: &str, data_dir: &Path) -> Result<PathBuf, String> {
    let rel = input.strip_prefix("local://").unwrap_or(input);
    if rel.is_empty() {
        return Err("空路径".to_string());
    }

    let raw = if Path::new(rel).is_absolute() {
        PathBuf::from(rel)
    } else {
        for seg in rel.split(['/', '\\']) {
            if seg == ".." {
                return Err(format!("路径包含 .. 段, 拒绝: {}", input));
            }
        }
        data_dir.join(rel.replace('\\', "/"))
    };

    if !raw.is_file() {
        return Err(format!("视频文件不存在: {}", input));
    }

    let canonical = raw
        .canonicalize()
        .map_err(|e| format!("路径解析失败 {:?}: {}", raw, e))?;
    let dir_canonical = data_dir
        .canonicalize()
        .map_err(|e| format!("data_dir 解析失败: {}", e))?;

    if !canonical.starts_with(&dir_canonical) {
        return Err(format!("路径越权: {:?} 不在 data_dir 下", canonical));
    }

    Ok(canonical)
}

fn compute_sha256(path: &Path) -> Result<String, String> {
    use std::fs::File;
    use std::io::Read;

    let mut file = File::open(path).map_err(|e| format!("打开文件失败: {}", e))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("读取文件失败: {}", e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(digest.len() * 2);
    for b in digest.iter() {
        use std::fmt::Write;
        write!(&mut hex, "{:02x}", b).unwrap();
    }
    Ok(hex)
}
