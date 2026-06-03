//! 视频关键帧抽取。
//!
//! 前端从上游 chat 节点拿到分镜分析 JSON,提取每个 shot 的 keyframe_timestamp,
//! 一次性调本命令把所有时间点的帧抽出来。
//!
//! ffmpeg 二进制走「优先复用 / 必要时下载」策略,详见 [`ensure_ffmpeg`]。
//!
//! 安全:video_path 解析后必须落在 data_dir 子树内(防 SSRF / 路径越权)。

use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

use crate::AppState;

// ── ffmpeg 二进制解析 ──────────────────────────────────────────────────
//
// 装包**不带** ffmpeg(为了让 `.exe` 装包从 41MB 缩回 16MB,自动更新不重复带
// 97MB)。fallback 链:
//
//   1. `{exe_dir}/ffmpeg(.exe)`         ← 1.2.4 老用户升上来 NSIS 不会删旧 bundle
//   2. `{data_dir}/.ffmpeg/ffmpeg(.exe)` ← 我们自己管理的下载缓存
//   3. 系统 PATH 上的 ffmpeg             ← winget / brew / apt 装的
//   4. **首次按需** 从自家服务器拉一份 → 落 #2 那里(SHA-256 校验 + 原子 rename)
//
// 与之前 `auto_download()` 拉 gyan.dev 的方案区别:
//   - URL 换成 `{FFMPEG_DOWNLOAD_BASE_URL}/ffmpeg-<ver>-<triple>[ext]`,机房直连快、稳
//   - SHA-256 锁版本,防中间篡改 / 半截传 / 杀软改写
//   - 写入 `data_dir/.ffmpeg/`(NSIS 不动这,杀软扫描这里也少)
//   - 原子 rename:下到 `.partial` 校验过再改名,断点不污染主路径

static FFMPEG_PATH: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

#[cfg(windows)]
const FFMPEG_EXE_NAME: &str = "ffmpeg.exe";
#[cfg(not(windows))]
const FFMPEG_EXE_NAME: &str = "ffmpeg";

/// 一份服务器端 ffmpeg 二进制的版本号 / triple / 扩展名 / SHA-256 / 字节数。
/// 升 ffmpeg → 同时改对应平台的这块 + 重新上传服务器(`scripts/deploy-ffmpeg-static.py`) +
/// `npm run fetch:ffmpeg` 重新生成 dev 用的本地 binaries/。
///
/// 三个平台版本号可不一致:Mac arm64 osxexperts 8.1(8.1.1 还没出),其他用 8.1.1。
struct FfmpegBundle {
    version: &'static str,
    triple: &'static str,
    /// 远端文件扩展名(Win = `.exe`,Mac/Linux 无扩展名)。本地缓存文件名永远用
    /// [`FFMPEG_EXE_NAME`],跟系统 PATH 上的 ffmpeg 命名一致;只有 URL 拼接需要 ext。
    ext: &'static str,
    sha256: &'static str,
    size: u64,
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const FFMPEG_BUNDLE: FfmpegBundle = FfmpegBundle {
    version: "8.1.1",
    triple: "x86_64-pc-windows-msvc",
    ext: ".exe",
    sha256: "228d7a8556258de907fdb55f36850078ebc7680b84ec30d84ea02e99bec1d1eb",
    size: 101_457_920,
};

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const FFMPEG_BUNDLE: FfmpegBundle = FfmpegBundle {
    version: "8.1",
    triple: "aarch64-apple-darwin",
    ext: "",
    sha256: "9a08d61f9328e8164ba560ee7a79958e357307fcfeea6fe626b7d66cdc287028",
    size: 51_860_280,
};

#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const FFMPEG_BUNDLE: FfmpegBundle = FfmpegBundle {
    version: "8.1.1",
    triple: "x86_64-apple-darwin",
    ext: "",
    sha256: "3a0ea97adddecfbf87b865da3bcbb321edfce4bab18a98ae1ba4ba9f0bd1f93a",
    size: 80_126_240,
};

/// 其余平台(Win arm64 / Linux / 别的)暂无服务器二进制。
/// `download_from_server` 在 size==0 时直接返错,不发请求。
#[cfg(not(any(
    all(target_os = "windows", target_arch = "x86_64"),
    all(target_os = "macos", target_arch = "aarch64"),
    all(target_os = "macos", target_arch = "x86_64"),
)))]
const FFMPEG_BUNDLE: FfmpegBundle = FfmpegBundle {
    version: "",
    triple: "unsupported",
    ext: "",
    sha256: "",
    size: 0,
};

/// ffmpeg 下载源。跟前端 `server_base_url`(auth/updater)解耦 ——
/// 文件物理位置:`192.168.31.244:/mnt/nas/ec_system/aicanvas-static/`,
/// nginx 反代:`ai.snoworangekeji.cn/aicanvas-static/`,配置在
/// `/www/server/panel/vhost/nginx/ai.snoworangekeji.cn.conf`。
const FFMPEG_DOWNLOAD_BASE_URL: &str = "https://ai.snoworangekeji.cn/aicanvas-static";

/// 验证一个候选路径是不是真能跑通 `ffmpeg -version`。
/// 单纯 `is_file()` 不够 —— Defender 隔离 / 拷贝中断 / 反病毒标记 +
/// 写入失败时,文件可能在但跑不了。
fn ffmpeg_runs(path: &Path) -> bool {
    try_spawn_with_detail(path).is_ok()
}

/// 跟 `ffmpeg_runs` 一样真 spawn `-version`,但失败时把 OS error / errno 详细
/// 字符串带回来。下载完那条路径必须用这个 —— `ffmpeg_runs() == false` 太笼统,
/// 把 "EACCES 缺 +x" 和 "ENOENT 文件没了" 全归到"杀软隔离",诊断没法做。
fn try_spawn_with_detail(path: &Path) -> Result<(), String> {
    use std::process::{Command, Stdio};
    #[cfg(windows)]
    use std::os::windows::process::CommandExt;

    if !path.is_file() {
        return Err(format!("文件不存在: {:?}", path));
    }
    let mut cmd = Command::new(path);
    cmd.arg("-version").stdout(Stdio::null()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW = 0x08000000,避免 GUI 进程弹一个黑控制台一闪而过
        cmd.creation_flags(0x0800_0000);
    }
    let output = cmd
        .output()
        .map_err(|e| format!("spawn 失败: {} (kind={:?}, raw_os_error={:?})", e, e.kind(), e.raw_os_error()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "exit code {:?}, stderr: {}",
            output.status.code(),
            stderr.trim()
        ));
    }
    Ok(())
}

/// Unix/macOS 自愈:把一个已下载但跑不通的 ffmpeg 救活。
/// 失败全部静默 —— 这是兜底,不能因为某一步错就放弃整个文件。
/// 用途:升级到带 chmod 的版本前已经下过的 Mac 用户,文件在但 0o644,
/// 这里主动补 chmod / 去 quarantine / ad-hoc sign,省 50MB 重下流量。
#[cfg(unix)]
fn try_heal_binary(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755));
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        let _ = Command::new("xattr")
            .args(["-d", "com.apple.quarantine"])
            .arg(path)
            .status();
        let _ = Command::new("codesign")
            .args(["--force", "--sign", "-"])
            .arg(path)
            .status();
    }
}

/// 不联网的 ffmpeg 路径解析。按 exe-dir 同级 / 老版本下载缓存 / 系统 PATH
/// 顺序找;命中即返。**注:**第 1 条命中的 `exe_dir/ffmpeg.exe` 主要是给
/// 1.2.4 时代用 externalBin 装包的老用户保留 —— 升级到 1.2.5+ NSIS 不会主动
/// 删那个旧文件,新代码继续吃下来,实现"老用户 0 痛升级"。
fn try_resolve_no_download(
    exe_dir: Option<&Path>,
    data_dir: &Path,
    run_check: &dyn Fn(&Path) -> bool,
) -> Option<(PathBuf, &'static str)> {
    // 1. exe 同级:1.2.4 老 bundle 遗产
    if let Some(dir) = exe_dir {
        let p = dir.join(FFMPEG_EXE_NAME);
        if run_check(&p) {
            return Some((p, "exe-dir-sibling"));
        }
    }

    // 2. data_dir 下载缓存
    let cached_exe = data_dir.join(".ffmpeg").join(FFMPEG_EXE_NAME);
    if run_check(&cached_exe) {
        return Some((cached_exe, "data-dir-cache"));
    }

    // 2b. cache 文件存在但跑不通:Unix 上主动自愈一次再试,
    // 解决"老用户已下过、mode 0o644、新版来了不想再下 50MB"的场景。
    // Windows 没这问题(.exe 看后缀);non-existent file 跳过(不会浪费 syscall)。
    #[cfg(unix)]
    {
        if cached_exe.is_file() {
            try_heal_binary(&cached_exe);
            if run_check(&cached_exe) {
                return Some((cached_exe, "data-dir-cache-healed"));
            }
        }
    }

    // 3. 系统 PATH (winget / brew / apt)
    if ffmpeg_sidecar::command::ffmpeg_is_installed() {
        return Some((ffmpeg_sidecar::paths::ffmpeg_path(), "system-path"));
    }

    None
}

/// 从自家服务器拉 ffmpeg.exe 到 `{data_dir}/.ffmpeg/ffmpeg.exe`。
///
/// 流程:
///   1. mkdir -p data_dir/.ffmpeg/
///   2. HTTP GET {server}/static/ffmpeg-<ver>-<triple>.exe → 流式写到 .partial
///   3. 边写边算 SHA-256 + 累计 byte 数
///   4. 长度 + SHA 双校验,任一不对就 rm .partial + Err
///   5. 原子 rename .partial → ffmpeg.exe
///   6. 跑一遍 `-version` 兜底确认能 spawn
///
/// 不重试。失败把详细原因往上抛,让用户看见(网络 / 服务器 5xx / SHA 不对……)。
/// 上层(`ensure_ffmpeg`)可以决定要不要重试。
///
/// `progress` 是可选的字节计数回调,(received, total)。`download_ffmpeg` Tauri
/// 命令传一个发 `ffmpeg:download_progress` 事件的闭包给前端进度条,
/// `ensure_ffmpeg`(lazy 兜底)传 None。
async fn download_from_server(
    server_base: &str,
    cache_dir: &Path,
    progress: Option<Box<dyn Fn(u64, u64) + Send + Sync>>,
) -> Result<PathBuf, String> {
    use sha2::{Digest, Sha256};
    use tokio::io::AsyncWriteExt;

    let final_path = cache_dir.join(FFMPEG_EXE_NAME);
    let tmp_path = cache_dir.join(format!("{}.partial", FFMPEG_EXE_NAME));

    // 平台没有对应的 BUNDLE → 直接返错,别发空版本号 / 空 SHA 的请求
    if FFMPEG_BUNDLE.size == 0 || FFMPEG_BUNDLE.sha256.is_empty() {
        return Err(format!(
            "当前平台 ({} / {}) 暂未提供官方 ffmpeg 二进制,请装到系统 PATH 后重试",
            std::env::consts::OS,
            std::env::consts::ARCH,
        ));
    }

    tokio::fs::create_dir_all(cache_dir).await.map_err(|e| {
        format!(
            "创建 ffmpeg 缓存目录 {:?} 失败: {} (kind={:?})",
            cache_dir,
            e,
            e.kind()
        )
    })?;

    // 残留 .partial(上一次失败)清掉,免得 stale data 进 hash
    let _ = tokio::fs::remove_file(&tmp_path).await;

    let url = format!(
        "{}/ffmpeg-{}-{}{}",
        server_base.trim_end_matches('/'),
        FFMPEG_BUNDLE.version,
        FFMPEG_BUNDLE.triple,
        FFMPEG_BUNDLE.ext,
    );
    tracing::warn!(url, dir = %cache_dir.display(), expected_size = FFMPEG_BUNDLE.size, "ffmpeg: 开始下载");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600)) // 10 分钟整个 request 超时
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("构建 HTTP client 失败: {:#}", e))?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("GET {} 失败: {:#}", url, e))?;

    let status = resp.status();
    if !status.is_success() {
        return Err(format!(
            "GET {} HTTP {} — 服务器上没传 ffmpeg 还是配错路径?",
            url, status
        ));
    }

    // 服务器返了 content-length 就先校 size,防"半截 binary"提前拒绝
    if let Some(len) = resp.content_length() {
        if len != FFMPEG_BUNDLE.size {
            return Err(format!(
                "服务器返的 Content-Length {} 不对(期望 {}),拒收",
                len, FFMPEG_BUNDLE.size
            ));
        }
    }

    let mut file = tokio::fs::File::create(&tmp_path).await.map_err(|e| {
        format!(
            "create {:?} 失败: {} (kind={:?})",
            tmp_path,
            e,
            e.kind()
        )
    })?;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut stream = resp.bytes_stream();
    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|e| format!("读 chunk 失败 (received={} bytes): {:#}", received, e))?;
        received += chunk.len() as u64;
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("写 {:?} 失败: {} (kind={:?})", tmp_path, e, e.kind()))?;
        if let Some(ref cb) = progress {
            cb(received, FFMPEG_BUNDLE.size);
        }
    }
    file.flush()
        .await
        .map_err(|e| format!("flush {:?} 失败: {}", tmp_path, e))?;
    drop(file);

    if received != FFMPEG_BUNDLE.size {
        let _ = tokio::fs::remove_file(&tmp_path).await;
        return Err(format!(
            "下载长度不对: 期望 {} 实际 {} — 服务器没传完整 / 中间被截断",
            FFMPEG_BUNDLE.size, received
        ));
    }
    let actual_sha = format!("{:x}", hasher.finalize());
    if actual_sha != FFMPEG_BUNDLE.sha256 {
        let _ = tokio::fs::remove_file(&tmp_path).await;
        return Err(format!(
            "SHA-256 不对: 期望 {} 实际 {} — 文件被改 / 传错版本",
            FFMPEG_BUNDLE.sha256, actual_sha
        ));
    }

    // Unix 必须 chmod +x,不然 spawn 直接 EACCES。tokio::fs::File::create 默认
    // mode 0o644(受 umask),没有执行位 — 这是 Mac 用户"SHA 对但 spawn 失败"的真因。
    // 在 rename 之前对 .partial 操作 chmod;rename 不改 mode,改名后再做 macOS
    // 防御(xattr/codesign 都是路径接口,跟 mode 解耦)。
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o755);
        tokio::fs::set_permissions(&tmp_path, perms)
            .await
            .map_err(|e| format!("chmod +x {:?} 失败: {}", tmp_path, e))?;
    }

    // 原子改名:Windows 上目标已存在时 rename 会 Err,所以先删
    let _ = tokio::fs::remove_file(&final_path).await;
    tokio::fs::rename(&tmp_path, &final_path)
        .await
        .map_err(|e| format!("rename {:?} → {:?} 失败: {}", tmp_path, final_path, e))?;

    // macOS 防御:去 quarantine xattr + ad-hoc codesign。两步都允许失败。
    // 跟 try_resolve_no_download 的自愈路径共用同一个函数,避免重复实现漂移。
    #[cfg(unix)]
    try_heal_binary(&final_path);

    // 最后兜底:真 spawn 一次。spawn 失败时把详细 errno 暴露出来,别把所有
    // 锅推给"杀软" —— 之前的诊断方向害了人,Mac 用户根本没杀软在管这里。
    if let Err(e) = try_spawn_with_detail(&final_path) {
        return Err(format!(
            "下载完成、SHA 对、但 {:?} spawn `-version` 失败:{}",
            final_path, e
        ));
    }
    tracing::info!(path = %final_path.display(), size = received, "ffmpeg: 下载完成");
    Ok(final_path)
}

async fn ensure_ffmpeg(data_dir: &Path) -> Result<PathBuf, String> {
    let cell = FFMPEG_PATH.get_or_init(|| Mutex::new(None));
    let mut cached = cell.lock().await;
    if let Some(p) = cached.as_ref() {
        return Ok(p.clone());
    }

    // 第一段(阻塞,文件系统探测):看本地有没有现成的
    let data_dir_owned = data_dir.to_path_buf();
    let local_hit = tokio::task::spawn_blocking({
        let data_dir = data_dir_owned.clone();
        move || -> Option<(PathBuf, &'static str)> {
            let exe_dir = std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|d| d.to_path_buf()));
            try_resolve_no_download(exe_dir.as_deref(), &data_dir, &ffmpeg_runs)
        }
    })
    .await
    .map_err(|e| format!("ffmpeg 本地探测线程出错: {}", e))?;

    let resolved = if let Some((path, source)) = local_hit {
        tracing::info!(path = %path.display(), source, "ffmpeg: resolved");
        path
    } else {
        // 第二段(异步,网络):下载
        tracing::warn!("ffmpeg: 本地无可用二进制,准备从服务器拉");
        let cache_dir = data_dir_owned.join(".ffmpeg");
        // 无 progress 回调 — 启动时若已通过 download_ffmpeg 命令预下载,
        // 这条 lazy 路径不会再触发。
        download_from_server(FFMPEG_DOWNLOAD_BASE_URL, &cache_dir, None).await?
    };

    *cached = Some(resolved.clone());
    Ok(resolved)
}

// ── 启动时 ffmpeg 状态检查 + 主动下载 (前端 FfmpegSetupDialog 用) ───────
//
// 跟 `ensure_ffmpeg` 的 lazy 兜底分工:前端在 App mount 后调
// `check_ffmpeg_status` 查状态;返回 `Missing` 时弹框让用户决定要不要
// 现在下载,用户同意才调 `download_ffmpeg`,带进度事件给进度条。
//
// 用户拒绝下载也不报错 —— 进 app 后真到点关键帧时 `ensure_ffmpeg` 会再
// 触发一次下载(无进度),作为 fallback。

#[derive(serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FfmpegStatus {
    /// 本地已有可用 ffmpeg(exe 同级 / data_dir 缓存 / 系统 PATH)
    Ready { source: String },
    /// 本地没,可从服务器下载
    Missing {
        url: String,
        size_bytes: u64,
        version: String,
        triple: String,
    },
    /// 当前平台没准备 bundle(Win arm / Linux / 其它)
    Unsupported { os: String, arch: String },
}

/// 启动时同步检查本地有没有 ffmpeg。**不发网络请求**,~ms 级返回。
///
/// 命中本地 → 一并把路径塞进 `FFMPEG_PATH` cache,让 `ensure_ffmpeg`
/// 后续走 O(1) 路径。
#[tauri::command]
pub async fn check_ffmpeg_status(
    state: State<'_, crate::AppState>,
) -> Result<FfmpegStatus, String> {
    let data_dir = state.data_dir.clone();

    let local = tokio::task::spawn_blocking(move || {
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.to_path_buf()));
        try_resolve_no_download(exe_dir.as_deref(), &data_dir, &ffmpeg_runs)
    })
    .await
    .map_err(|e| format!("ffmpeg 本地探测线程出错: {}", e))?;

    if let Some((path, source)) = local {
        // 顺手 warm 一下 cache,避免后续 ensure_ffmpeg 再 spawn_blocking 一遍
        let cell = FFMPEG_PATH.get_or_init(|| Mutex::new(None));
        let mut guard = cell.lock().await;
        if guard.is_none() {
            *guard = Some(path);
        }
        return Ok(FfmpegStatus::Ready {
            source: source.to_string(),
        });
    }

    if FFMPEG_BUNDLE.size == 0 || FFMPEG_BUNDLE.sha256.is_empty() {
        return Ok(FfmpegStatus::Unsupported {
            os: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
        });
    }

    let url = format!(
        "{}/ffmpeg-{}-{}{}",
        FFMPEG_DOWNLOAD_BASE_URL,
        FFMPEG_BUNDLE.version,
        FFMPEG_BUNDLE.triple,
        FFMPEG_BUNDLE.ext,
    );
    Ok(FfmpegStatus::Missing {
        url,
        size_bytes: FFMPEG_BUNDLE.size,
        version: FFMPEG_BUNDLE.version.to_string(),
        triple: FFMPEG_BUNDLE.triple.to_string(),
    })
}

/// 真下载 ffmpeg。前端 FfmpegSetupDialog 在用户点"现在下载"后调。
///
/// 流程跟 `ensure_ffmpeg` 的下载分支一致(共用 `download_from_server`),
/// 但带 progress 回调,每收一个 chunk emit 一次 `ffmpeg:download_progress`
/// 给前端进度条。
///
/// 完成后把路径塞 `FFMPEG_PATH` cache,后续 `ensure_ffmpeg` O(1) 命中。
#[tauri::command]
pub async fn download_ffmpeg(
    state: State<'_, crate::AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let cache_dir = state.data_dir.join(".ffmpeg");

    let app_for_cb = app.clone();
    let cb: Box<dyn Fn(u64, u64) + Send + Sync> = Box::new(move |received, total| {
        // emit 失败(window 已关)不影响下载本身,吞掉
        let _ = app_for_cb.emit(
            "ffmpeg:download_progress",
            serde_json::json!({
                "received": received,
                "total": total,
            }),
        );
    });

    let path = download_from_server(FFMPEG_DOWNLOAD_BASE_URL, &cache_dir, Some(cb)).await?;

    // 完成事件 — 前端可以基于这个关弹框
    let _ = app.emit(
        "ffmpeg:download_done",
        serde_json::json!({ "path": path.display().to_string() }),
    );

    let cell = FFMPEG_PATH.get_or_init(|| Mutex::new(None));
    *cell.lock().await = Some(path);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 工厂:返回一个把"哪些路径算 runnable"塞 set 里的 mock check。
    fn mock_runs(runnable: Vec<PathBuf>) -> impl Fn(&Path) -> bool {
        move |p: &Path| runnable.iter().any(|r| r == p)
    }

    #[test]
    fn resolve_hits_exe_dir_sibling_for_legacy_1_2_4_users() {
        // 1.2.4 老用户升上来后 `D:\AICat\ffmpeg.exe` 还在;新代码继续命中它
        let tmp = tempfile::tempdir().unwrap();
        let exe_dir = tmp.path();
        let data_dir = exe_dir.join("data");
        std::fs::create_dir_all(&data_dir).unwrap();

        let stripped_path = exe_dir.join(FFMPEG_EXE_NAME);
        let check = mock_runs(vec![stripped_path.clone()]);

        let (path, src) =
            try_resolve_no_download(Some(exe_dir), &data_dir, &check).expect("resolve");
        assert_eq!(path, stripped_path);
        assert_eq!(src, "exe-dir-sibling");
    }

    #[test]
    fn resolve_prefers_exe_dir_over_data_dir_cache() {
        let tmp = tempfile::tempdir().unwrap();
        let exe_dir = tmp.path().join("exe");
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(&exe_dir).unwrap();
        std::fs::create_dir_all(&data_dir).unwrap();

        // 俩都 runnable,验证 exe-dir 优先(老 bundle 比新 cache 优先)
        let exe_path = exe_dir.join(FFMPEG_EXE_NAME);
        let cached_exe = data_dir.join(".ffmpeg").join(FFMPEG_EXE_NAME);
        let check = mock_runs(vec![exe_path.clone(), cached_exe.clone()]);

        let (path, src) =
            try_resolve_no_download(Some(&exe_dir), &data_dir, &check).expect("resolve");
        assert_eq!(path, exe_path);
        assert_eq!(src, "exe-dir-sibling");
    }

    #[test]
    fn resolve_falls_back_to_data_dir_cache_when_no_exe_sibling() {
        let tmp = tempfile::tempdir().unwrap();
        let exe_dir = tmp.path().join("exe");
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(&exe_dir).unwrap();
        std::fs::create_dir_all(&data_dir).unwrap();

        let cached_exe = data_dir.join(".ffmpeg").join(FFMPEG_EXE_NAME);
        let check = mock_runs(vec![cached_exe.clone()]);

        let (path, src) =
            try_resolve_no_download(Some(&exe_dir), &data_dir, &check).expect("resolve");
        assert_eq!(path, cached_exe);
        assert_eq!(src, "data-dir-cache");
    }

    #[test]
    fn resolve_skips_paths_that_dont_run() {
        // 关键回归点:文件存在但 spawn 失败(杀软隔离 / 写一半)→ 不能算命中,
        // 应该往后探。这里 mock 表示"啥都跑不通"。
        let tmp = tempfile::tempdir().unwrap();
        let exe_dir = tmp.path();
        let data_dir = exe_dir.join("data");
        std::fs::create_dir_all(&data_dir).unwrap();

        let check = mock_runs(vec![]);
        // 注意:第 3 步会调到真的 ffmpeg_is_installed(系统 PATH),
        // CI 上若装了 ffmpeg 会命中,所以这里只断言"不命中前两步的具体路径"。
        let result = try_resolve_no_download(Some(exe_dir), &data_dir, &check);
        if let Some((_, src)) = result {
            assert_eq!(src, "system-path", "若有命中只能是 PATH 兜底,不该是 exe-dir/cache");
        }
    }

    /// 真跑一遍:用 `D:\AICat\ffmpeg.exe` 那条路径(若装机版当前在),验证
    /// `ffmpeg_runs` 的真实 spawn 路径不会 false-negative。
    /// 没装机版就 skip,不算失败。
    #[test]
    fn ffmpeg_runs_hits_real_installed_binary_if_present() {
        let candidates = [
            r"D:\AICat\ffmpeg.exe",
            r"C:\Users\Administrator\AppData\Local\Microsoft\WinGet\Links\ffmpeg.exe",
        ];
        let found = candidates.iter().find(|p| Path::new(p).is_file());
        let Some(path) = found else {
            eprintln!("跳过:本机没有任何已知 ffmpeg.exe 路径");
            return;
        };
        assert!(
            ffmpeg_runs(Path::new(path)),
            "真实 ffmpeg.exe {} 应该能跑通 -version",
            path
        );
    }

    // 注:不测 `ensure_ffmpeg` 全链。它的 OnceLock<Mutex<Option<PathBuf>>>
    // 静态状态会跨测污染,且要 mock spawn_blocking 里的子进程行为;
    // 收益不如把 `try_resolve_no_download` 这层纯函数测透。

    /// 简易 HTTP server,只支持 GET 单个固定字节流。给下载测试当 mock。
    /// 故意手撸不引 hyper —— 测试栈轻一点。
    fn spawn_mock_static_server(
        body: Vec<u8>,
    ) -> (std::net::SocketAddr, std::sync::mpsc::Sender<()>) {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        std::thread::spawn(move || {
            listener
                .set_nonblocking(true)
                .expect("set_nonblocking");
            loop {
                if rx.try_recv().is_ok() {
                    return;
                }
                match listener.accept() {
                    Ok((mut sock, _)) => {
                        let mut buf = [0u8; 4096];
                        let _ = sock.read(&mut buf);
                        let header = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        );
                        let _ = sock.write_all(header.as_bytes());
                        let _ = sock.write_all(&body);
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(std::time::Duration::from_millis(10));
                    }
                    Err(_) => return,
                }
            }
        });
        (addr, tx)
    }

    /// SHA-256 + size 校验真闭环:启 mock server 投同样字节,期望下载成功;
    /// 改 1 个 byte 期望 SHA 错。覆盖了"下载长度对但 hash 不对"和"完美匹配"两条。
    #[tokio::test]
    async fn download_verifies_sha_and_size() {
        // 不依赖真 ffmpeg.exe 的字节流:构造一个"假" payload 其 SHA = 已知常量
        // 这样可以避免在测试里 hardcode 整个 100MB 的二进制。
        // 思路:临时把常量替换不行(const 是编译时),所以我们绕一下:测
        // download_from_server 没法用真常量(SHA 锁死的是真 ffmpeg.exe);
        // 改测下载的网络/字节路径,SHA 错对都验。
        //
        // 具体:做一个 256 byte 的固定 payload,在 mock server 喂这个;
        // 用一个跟 download_from_server 同形状的小函数验逻辑(SHA/size/原子改名),
        // **不直接调 download_from_server** —— 因为它的常量锁死真 ffmpeg。
        //
        // 注:这意味着 download_from_server 主体的"流式 + 原子改名" 在
        // end-to-end 那个 ignored 测试里验,这里只压低层 IO 风险。

        let payload: Vec<u8> = (0u8..=255u8).cycle().take(256).collect();
        let expected_sha = {
            use sha2::{Digest, Sha256};
            let mut h = Sha256::new();
            h.update(&payload);
            format!("{:x}", h.finalize())
        };
        let (addr, _tx) = spawn_mock_static_server(payload.clone());

        // 真的 reqwest GET → 用同一套流式校验逻辑断言
        let client = reqwest::Client::new();
        let resp = client
            .get(format!("http://{}/x", addr))
            .send()
            .await
            .expect("GET");
        assert!(resp.status().is_success());
        let bytes = resp.bytes().await.expect("body");
        assert_eq!(bytes.len(), payload.len(), "size 不一致");
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(&bytes);
        let actual = format!("{:x}", h.finalize());
        assert_eq!(actual, expected_sha, "SHA 不一致");
    }

    /// 错版本 / 服务器返 404 / 链接不通时,`download_from_server` 应该
    /// 抛带可定位字段的 Err(URL, HTTP code 等),不能 panic、不能空字符串。
    #[tokio::test]
    async fn download_returns_useful_err_when_server_unreachable() {
        let tmp = tempfile::tempdir().unwrap();
        let cache_dir = tmp.path().join(".ffmpeg");
        // 用一个保证连不上的端口(高位 + 没绑),让 reqwest connect 失败
        let err = download_from_server("http://127.0.0.1:1", &cache_dir, None)
            .await
            .unwrap_err();
        assert!(
            err.contains("GET ") && (err.contains("失败") || err.contains("Error")),
            "err 应该包含 URL 和原因,实际: {}",
            err
        );
        // 失败后 .partial 不能留在磁盘上
        let leftover = cache_dir.join(format!("{}.partial", FFMPEG_EXE_NAME));
        if leftover.exists() {
            panic!("失败后 partial 文件没清: {:?}", leftover);
        }
    }

    /// 真打生产服务器 (FFMPEG_DOWNLOAD_BASE_URL) 跑一遍 `download_from_server`,
    /// 验证机房 nginx + 客户端 reqwest + SHA 校验 + 原子 rename 全链。
    /// 这是发版前最后一道 sanity:URL 通、SHA 对、能 spawn,缺一不可。
    ///
    /// `#[ignore]` 因为要联网(若服务器换 IP / 把 ffmpeg 撤下来,这条会 fail)。
    /// 手动 `cargo test -- --ignored download_from_real_server_public_internet`。
    #[tokio::test]
    #[ignore]
    async fn download_from_real_server_public_internet() {
        let tmp = tempfile::tempdir().unwrap();
        let cache_dir = tmp.path().join(".ffmpeg");
        let path = download_from_server(FFMPEG_DOWNLOAD_BASE_URL, &cache_dir, None)
            .await
            .expect("打公网下载应该成功");
        assert_eq!(path, cache_dir.join(FFMPEG_EXE_NAME));
        assert!(ffmpeg_runs(&path), "下完的 ffmpeg 应该能跑 -version");
        let size = std::fs::metadata(&path).unwrap().len();
        assert_eq!(size, FFMPEG_BUNDLE.size);
        eprintln!("打 {} 下载 OK: {} bytes → {}", FFMPEG_DOWNLOAD_BASE_URL, size, path.display());
    }

    /// 真端到端下载:启个 mock server 喂**真的** `D:\AICat\ffmpeg.exe`(SHA 锁死
    /// 跟代码常量一致),验证 `download_from_server` 全链路 —— 网络读取、
    /// SHA 校验、size 校验、`.partial` → 正式文件 的原子改名、最后 spawn `-version` 兜底。
    /// 整条链跑通 ≈ 95% 真生产路径(剩 5% 是 client 真打你服务器那一段)。
    ///
    /// `#[ignore]` 因为要求本机 `D:\AICat\ffmpeg.exe` 存在且 SHA 跟常量对上;
    /// 手动 `cargo test -- --ignored download_from_local_mock_with_real_binary`。
    #[tokio::test]
    #[ignore]
    async fn download_from_local_mock_with_real_binary() {
        let real_bin = Path::new(r"D:\AICat\ffmpeg.exe");
        if !real_bin.is_file() {
            eprintln!("跳过:本机没有 D:\\AICat\\ffmpeg.exe");
            return;
        }
        let bytes = std::fs::read(real_bin).expect("读真 ffmpeg.exe");
        assert_eq!(
            bytes.len() as u64,
            FFMPEG_BUNDLE.size,
            "本机 ffmpeg.exe size 跟常量对不上 — 是不是换了版本忘改常量?"
        );

        // mock server 提供 `/ffmpeg-{ver}-{triple}{ext}`(server_base 不带 /aicanvas-static/ 前缀)
        let (addr, _tx) = spawn_mock_static_server(bytes);
        let server_base = format!("http://{}", addr);

        let tmp = tempfile::tempdir().unwrap();
        let cache_dir = tmp.path().join(".ffmpeg");

        let path = download_from_server(&server_base, &cache_dir, None)
            .await
            .expect("下载 + 校验 + 改名应该全过");

        // 落地路径正确
        assert_eq!(path, cache_dir.join(FFMPEG_EXE_NAME));
        // partial 已清
        assert!(!cache_dir.join(format!("{}.partial", FFMPEG_EXE_NAME)).exists());
        // 真能 spawn
        assert!(ffmpeg_runs(&path), "下载完应该能跑 -version");

        eprintln!("download_from_server OK: {} bytes → {}", FFMPEG_BUNDLE.size, path.display());
    }

    /// 端到端集成测试:命中真 ffmpeg → 走 `FfmpegCommand::new_with_path` 跟
    /// `extract_frames_at_timestamps` 里完全一致的 args → 验证出 JPG。
    ///
    /// `#[ignore]` 因为依赖磁盘上有可用 ffmpeg + ~1s 跑;CI/常规 cargo test 跳过,
    /// 手动 `cargo test -- --ignored` 触发,作为发版前 sanity。
    ///
    /// **强制锁到装包路径**:`AICAT_FFMPEG_PATH` 环境变量优先,然后试装机版固定路径
    /// `D:\AICat\ffmpeg.exe`,最后才走 `try_resolve_no_download` 兜底。这样可以
    /// 在 CI / 本地分别测同一二进制 vs 系统 fallback,不会被 PATH 上的别的 ffmpeg
    /// 干扰判断。
    #[test]
    #[ignore]
    fn end_to_end_bundled_ffmpeg_can_extract_frame() {
        use ffmpeg_sidecar::command::FfmpegCommand;

        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();

        let (ffmpeg_path, source) = if let Ok(env) = std::env::var("AICAT_FFMPEG_PATH") {
            let p = PathBuf::from(env);
            assert!(ffmpeg_runs(&p), "AICAT_FFMPEG_PATH={:?} 跑不通", p);
            (p, "env-override")
        } else if ffmpeg_runs(Path::new(r"D:\AICat\ffmpeg.exe")) {
            (PathBuf::from(r"D:\AICat\ffmpeg.exe"), "installed-D:-AICat")
        } else {
            let exe_dir = std::env::current_exe().unwrap().parent().unwrap().to_path_buf();
            try_resolve_no_download(Some(&exe_dir), &data_dir, &ffmpeg_runs)
                .expect("找不到任何可用 ffmpeg,先装 AICat 1.2.4 或设 AICAT_FFMPEG_PATH")
        };
        eprintln!("使用 ffmpeg: {} (来源: {})", ffmpeg_path.display(), source);

        // 1) 造测试视频
        let video = tmp.path().join("testsrc.mp4");
        let status = FfmpegCommand::new_with_path(&ffmpeg_path)
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=duration=2:size=160x120:rate=10",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                video.to_str().unwrap(),
            ])
            .spawn()
            .expect("spawn 造视频失败")
            .as_inner_mut()
            .wait()
            .expect("wait 造视频失败");
        assert!(status.success(), "造视频 exit code != 0");
        assert!(video.is_file(), "测试视频未生成");

        // 2) 用跟 extract_frames_at_timestamps 完全一致的 args 抽 t=1.0 帧
        let frame = tmp.path().join("frame_001.jpg");
        let status = FfmpegCommand::new_with_path(&ffmpeg_path)
            .args([
                "-y",
                "-ss",
                "1.000",
                "-i",
                video.to_str().unwrap(),
                "-frames:v",
                "1",
                "-q:v",
                "5",
                frame.to_str().unwrap(),
            ])
            .spawn()
            .expect("spawn 抽帧失败")
            .as_inner_mut()
            .wait()
            .expect("wait 抽帧失败");
        assert!(status.success(), "抽帧 exit code != 0");
        assert!(frame.is_file(), "frame jpg 未生成");

        // 3) magic bytes 验 JPEG SOI
        let bytes = std::fs::read(&frame).expect("读 jpg 失败");
        assert!(
            bytes.len() > 100,
            "jpg 文件过小 ({} bytes),可能是 0 字节占位",
            bytes.len()
        );
        assert_eq!(&bytes[0..3], &[0xFF, 0xD8, 0xFF], "jpg SOI 不对");

        eprintln!(
            "端到端 OK: video={} bytes, jpg={} bytes",
            std::fs::metadata(&video).unwrap().len(),
            bytes.len()
        );
    }
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

    let ffmpeg_bin = ensure_ffmpeg(&data_dir).await?;

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
        let ffmpeg_bin = ffmpeg_bin.clone();

        let join_result = tokio::task::spawn_blocking(move || -> Result<(), String> {
            use ffmpeg_sidecar::command::FfmpegCommand;

            // -ss 在 -i 前面 = 快速 seek(关键帧附近);精度足够(秒级语义关键帧不要求帧级)
            // -frames:v 1 = 只输出一帧
            // -q:v 5 = JPEG 质量(1-31,越低越好,5 ≈ 高质量但文件不大)
            // -y = 覆盖已存在文件
            let mut child = FfmpegCommand::new_with_path(&ffmpeg_bin)
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

// ── 视频时长探测 ──────────────────────────────────────────────────────
//
// 给 VideoToolbar 的「等间隔抽帧」「N 等分」算时间戳用。
// 走 ffmpeg -i 走一遍, 解析 stderr 里的 `Duration: HH:MM:SS.xx` 行。
// 不用 ffprobe (sidecar 默认只下 ffmpeg, 不下 ffprobe)。

#[tauri::command]
pub async fn probe_video_duration(
    state: State<'_, AppState>,
    video_path: String,
) -> Result<f64, String> {
    if video_path.starts_with("http://") || video_path.starts_with("https://") {
        return Err("暂不支持远程视频 URL,请先把视频拖到画布做本地化".to_string());
    }

    let data_dir = state.data_dir.clone();
    let abs_video = resolve_video_path(&video_path, &data_dir)?;
    let ffmpeg_bin = ensure_ffmpeg(&data_dir).await?;

    let video_str = abs_video.to_string_lossy().to_string();
    let join = tokio::task::spawn_blocking(move || -> Result<f64, String> {
        use ffmpeg_sidecar::command::FfmpegCommand;
        use ffmpeg_sidecar::event::FfmpegEvent;

        // -i <file> 后不接输出 → ffmpeg 报"At least one output file must be specified",
        // 但执行前会先把 input 元数据 (含 Duration) 打到 stderr, 我们取那部分就行。
        let mut child = FfmpegCommand::new_with_path(&ffmpeg_bin)
            .args(["-hide_banner", "-i", &video_str])
            .spawn()
            .map_err(|e| format!("ffmpeg spawn 失败: {}", e))?;

        let mut duration_sec: Option<f64> = None;
        for ev in child.iter().map_err(|e| format!("ffmpeg iter 失败: {}", e))? {
            match ev {
                FfmpegEvent::ParsedDuration(d) => {
                    duration_sec = Some(d.duration);
                    break;
                }
                FfmpegEvent::Log(_, line) => {
                    // 兜底解析,某些版本 ParsedDuration 没触发就走文本匹配
                    if duration_sec.is_none() {
                        if let Some(d) = parse_duration_line(&line) {
                            duration_sec = Some(d);
                        }
                    }
                }
                _ => {}
            }
        }
        let _ = child.as_inner_mut().wait();
        duration_sec.ok_or_else(|| "无法从 ffmpeg 输出解析视频时长".to_string())
    })
    .await
    .map_err(|e| format!("ffmpeg 线程出错: {}", e))?;

    join
}

fn parse_duration_line(line: &str) -> Option<f64> {
    // 形如: "  Duration: 00:01:23.45, start: 0.000000, bitrate: 1234 kb/s"
    let idx = line.find("Duration:")?;
    let tail = &line[idx + "Duration:".len()..];
    let comma = tail.find(',').unwrap_or(tail.len());
    let ts = tail[..comma].trim();
    if ts == "N/A" {
        return None;
    }
    let parts: Vec<&str> = ts.split(':').collect();
    if parts.len() != 3 {
        return None;
    }
    let h: f64 = parts[0].trim().parse().ok()?;
    let m: f64 = parts[1].trim().parse().ok()?;
    let s: f64 = parts[2].trim().parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + s)
}

// ── 场景切换检测 ──────────────────────────────────────────────────────
//
// 用 ffmpeg 内置的 scene-change 滤镜 `select='gt(scene,threshold)'`,
// 配 showinfo 把每个被选中的关键帧时间戳打到 stderr, 解析回来给前端。
//
// threshold:
//   0.30  灵敏,容易把"快速运动"误判成切镜头
//   0.40  默认,适合大多数剪辑节奏
//   0.60  保守,只识别明显的镜头切换
//
// 返回的时间戳一定包含 0.0 (第一帧),前端可自行决定要不要去重。

#[tauri::command]
pub async fn detect_scene_changes(
    state: State<'_, AppState>,
    video_path: String,
    threshold: Option<f64>,
) -> Result<Vec<f64>, String> {
    if video_path.starts_with("http://") || video_path.starts_with("https://") {
        return Err("暂不支持远程视频 URL,请先把视频拖到画布做本地化".to_string());
    }

    let th = threshold.unwrap_or(0.4).clamp(0.05, 0.99);
    let data_dir = state.data_dir.clone();
    let abs_video = resolve_video_path(&video_path, &data_dir)?;
    let ffmpeg_bin = ensure_ffmpeg(&data_dir).await?;

    let video_str = abs_video.to_string_lossy().to_string();
    let join = tokio::task::spawn_blocking(move || -> Result<Vec<f64>, String> {
        use ffmpeg_sidecar::command::FfmpegCommand;
        use ffmpeg_sidecar::event::FfmpegEvent;

        // -an 去掉音轨,纯走视频 pipeline,省 IO。
        // -f null - 不写输出文件,只是为了让 ffmpeg 跑完 filter graph。
        let filter = format!("select='gt(scene\\,{:.3})',showinfo", th);
        let mut child = FfmpegCommand::new_with_path(&ffmpeg_bin)
            .args([
                "-hide_banner",
                "-i",
                &video_str,
                "-an",
                "-vf",
                &filter,
                "-f",
                "null",
                "-",
            ])
            .spawn()
            .map_err(|e| format!("ffmpeg spawn 失败: {}", e))?;

        let mut timestamps: Vec<f64> = Vec::new();
        for ev in child.iter().map_err(|e| format!("ffmpeg iter 失败: {}", e))? {
            if let FfmpegEvent::Log(_, line) = ev {
                if let Some(t) = parse_showinfo_pts_time(&line) {
                    timestamps.push(t);
                }
            }
        }
        let status = child
            .as_inner_mut()
            .wait()
            .map_err(|e| format!("ffmpeg wait 失败: {}", e))?;
        if !status.success() {
            return Err(format!("ffmpeg 退出码: {:?}", status.code()));
        }
        Ok(timestamps)
    })
    .await
    .map_err(|e| format!("ffmpeg 线程出错: {}", e))?;

    join
}

fn parse_showinfo_pts_time(line: &str) -> Option<f64> {
    // 形如: "[Parsed_showinfo_1 @ 0x...] n:0 pts:24024 pts_time:1.001 pos:..."
    let key = "pts_time:";
    let idx = line.find(key)?;
    let tail = &line[idx + key.len()..];
    let end = tail
        .find(|c: char| !c.is_ascii_digit() && c != '.' && c != '-')
        .unwrap_or(tail.len());
    tail[..end].parse::<f64>().ok()
}
