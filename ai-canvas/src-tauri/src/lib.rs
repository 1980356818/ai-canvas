mod backup;
mod commands;
mod db;

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::Manager;

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn resize_window(
    app: tauri::AppHandle,
    width: f64,
    height: f64,
    min_width: Option<f64>,
    min_height: Option<f64>,
    resizable: Option<bool>,
) {
    if let Some(win) = app.get_webview_window("main") {
        if let Some(r) = resizable {
            let _ = win.set_resizable(r);
        }
        match (min_width, min_height) {
            (Some(mw), Some(mh)) => {
                let _ = win.set_min_size(Some(tauri::LogicalSize::new(mw, mh)));
            }
            _ => {
                let _ = win.set_min_size(None::<tauri::LogicalSize<f64>>);
            }
        }
        let _ = win.set_size(tauri::LogicalSize::new(width, height));
        let _ = win.center();
    }
}

pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
    http_client: OnceLock<reqwest::Client>,
    stream_client: OnceLock<reqwest::Client>,
    pub active_streams: Mutex<HashMap<String, Arc<AtomicBool>>>,
    pub data_dir: std::path::PathBuf,
    /// 文件自动保存的**默认目录**。当 `settings.file_auto_save_path` 为空时，
    /// 所有自动保存/导出回退都落到这里。规则参见 [`resolve_auto_save_default_dir`]。
    pub auto_save_default_dir: std::path::PathBuf,
    /// 数据库备份目录（`~/Documents/AICat Data/backups/`）。
    /// 故意放在 Documents 而非 app_data_dir，规避卸载工具清理。
    pub backup_dir: std::path::PathBuf,
}

impl AppState {
    pub fn http_client(&self) -> &reqwest::Client {
        self.http_client.get_or_init(|| {
            reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(600))
                .connect_timeout(std::time::Duration::from_secs(120))
                .tcp_keepalive(std::time::Duration::from_secs(30))
                // 反代/边缘节点常在 ~30s 主动关闭 idle 连接；
                // 我们把客户端 idle 超时设得短一些，避免拿到一个对端已 RST 的"僵尸连接"复用，
                // 否则下次请求会以 "unexpected EOF during handshake" / "broken pipe" 报错。
                .pool_idle_timeout(std::time::Duration::from_secs(15))
                .pool_max_idle_per_host(4)
                .tcp_nodelay(true)
                .build()
                .expect("failed to create http client")
        })
    }

    pub fn stream_client(&self) -> &reqwest::Client {
        self.stream_client.get_or_init(|| {
            reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(300))
                .connect_timeout(std::time::Duration::from_secs(120))
                .tcp_keepalive(std::time::Duration::from_secs(30))
                // 同 http_client：避免复用对端已关闭的连接
                .pool_idle_timeout(std::time::Duration::from_secs(10))
                .pool_max_idle_per_host(2)
                .tcp_nodelay(true)
                .http1_only()
                .build()
                .expect("failed to create stream client")
        })
    }
}

/// 解析数据存储目录。策略：
///
/// - **Windows release**：优先使用 exe 同级 `data/` 目录（便携模式），
///   但如果旧版 AppData 中已有数据库而 exe/data 中没有，继续使用 AppData（升级兼容）。
///   Program Files 下安装或 exe 目录不可写时自动回退到 AppData。
/// - **Windows debug / Linux**：始终使用系统 app_data_dir。
/// - **macOS**：系统 `Application Support/com.ai-canvas.desktop/`；如果当前位置
///   没有 data.db 但旧版 `com.ai-canvas.app/` 下有，自动迁移过来。
fn resolve_data_dir(app: &tauri::App) -> Result<std::path::PathBuf, Box<dyn std::error::Error>> {
    let app_data = app.path().app_data_dir()?;

    #[cfg(target_os = "windows")]
    {
        if cfg!(debug_assertions) {
            tracing::info!("dev mode: using app_data_dir");
            return Ok(app_data);
        }

        if let Ok(exe) = std::env::current_exe() {
            if let Some(exe_dir) = exe.parent() {
                let exe_dir_str = exe_dir.to_string_lossy().to_lowercase();
                if exe_dir_str.contains("program files") {
                    tracing::info!("exe in Program Files, using app_data_dir");
                    return Ok(app_data);
                }

                let candidate = exe_dir.join("data");
                let app_data_has_db = app_data.join("data.db").exists();
                let exe_data_has_db = candidate.join("data.db").exists();

                if app_data_has_db && !exe_data_has_db {
                    tracing::info!(
                        "upgrade detected: AppData has data.db but exe/data does not, staying with AppData"
                    );
                    return Ok(app_data);
                }

                if std::fs::create_dir_all(&candidate).is_ok() {
                    return Ok(candidate);
                }

                tracing::warn!(
                    "cannot create {:?}, falling back to AppData",
                    candidate
                );
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        // 历史包袱：早期 bundle identifier 是 `com.ai-canvas.app`，因 `.app` 后缀
        // 与应用包扩展名冲突已改为 `com.ai-canvas.desktop`。旧版用户的 data.db
        // 还沉淀在老路径里 —— 如果新路径没数据但老路径有，整体搬过去。
        if let Some(parent) = app_data.parent() {
            let legacy = parent.join("com.ai-canvas.app");
            let new_has_db = app_data.join("data.db").exists();
            let legacy_has_db = legacy.join("data.db").exists();

            if !new_has_db && legacy_has_db {
                boot_log(&format!(
                    "macOS legacy identifier data detected at {:?}, migrating to {:?}",
                    legacy, app_data
                ));
                if let Err(e) = migrate_legacy_macos_identifier(&legacy, &app_data) {
                    boot_log(&format!("legacy identifier migration failed: {}", e));
                } else {
                    boot_log("legacy identifier migration succeeded");
                }
            }
        }
    }

    Ok(app_data)
}

/// 把 macOS 旧 identifier 目录（`com.ai-canvas.app`）下的所有内容拷贝到新目录。
///
/// 用 copy 而非 rename 是为了兼容跨卷场景（理论上不会跨卷，但保险）。
/// 拷贝成功后保留旧目录不删，给用户留一份兜底；同时写一个 `.migrated-to`
/// 标记到旧目录，避免下次启动重复迁移日志噪音。
#[cfg(target_os = "macos")]
fn migrate_legacy_macos_identifier(
    legacy: &std::path::Path,
    new: &std::path::Path,
) -> std::io::Result<()> {
    std::fs::create_dir_all(new)?;
    copy_dir_recursive(legacy, new)?;
    let marker = legacy.join(".migrated-to");
    let _ = std::fs::write(&marker, new.to_string_lossy().as_bytes());
    Ok(())
}

#[cfg(target_os = "macos")]
fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let src_path = entry.path();
        let name = entry.file_name();
        // 跳过我们自己写的标记文件
        if name == ".migrated-to" {
            continue;
        }
        let dst_path = dst.join(&name);
        if file_type.is_dir() {
            std::fs::create_dir_all(&dst_path)?;
            copy_dir_recursive(&src_path, &dst_path)?;
        } else if file_type.is_file() {
            // 目标已存在就跳过（新目录里的同名文件优先，避免覆盖用户新数据）
            if !dst_path.exists() {
                std::fs::copy(&src_path, &dst_path)?;
            }
        }
    }
    Ok(())
}

/// 自动保存目录的固定文件夹名。
pub const AUTO_SAVE_FOLDER_NAME: &str = "文件自动保存";

/// 解析"文件自动保存"的**默认目录**（用户未在设置里指定路径时使用）。
///
/// 规则：
/// - Windows release：优先 `exe 同级目录/文件自动保存/`（与便携模式 `data/` 同级，
///   用户友好可见）。exe 在 Program Files 或不可写时回退到 `data_dir/文件自动保存/`。
/// - macOS release：app bundle 内的 `MacOS/` 不适合放用户文件，直接用
///   `data_dir/文件自动保存/`。
/// - 任意 debug 模式：始终用 `data_dir/文件自动保存/`，避免 cargo clean 误删。
fn resolve_auto_save_default_dir(data_dir: &std::path::Path) -> std::path::PathBuf {
    if cfg!(debug_assertions) {
        return data_dir.join(AUTO_SAVE_FOLDER_NAME);
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(exe_dir) = exe.parent() {
                let exe_dir_str = exe_dir.to_string_lossy().to_lowercase();
                if !exe_dir_str.contains("program files") {
                    let candidate = exe_dir.join(AUTO_SAVE_FOLDER_NAME);
                    if std::fs::create_dir_all(&candidate).is_ok() {
                        return candidate;
                    }
                }
            }
        }
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(exe_dir) = exe.parent() {
                let candidate = exe_dir.join(AUTO_SAVE_FOLDER_NAME);
                if std::fs::create_dir_all(&candidate).is_ok() {
                    return candidate;
                }
            }
        }
    }

    data_dir.join(AUTO_SAVE_FOLDER_NAME)
}

/// 把旧版 `{data_dir}/auto-save/` 中的内容迁移到新默认目录。
/// 仅在新目录不存在或为空时迁移；冲突时保留两者并打日志，等待用户决定。
fn migrate_legacy_auto_save_dir(
    data_dir: &std::path::Path,
    new_dir: &std::path::Path,
) {
    let legacy = data_dir.join("auto-save");
    if !legacy.exists() {
        return;
    }
    if legacy == new_dir {
        return;
    }

    let new_is_empty = !new_dir.exists()
        || std::fs::read_dir(new_dir)
            .map(|mut it| it.next().is_none())
            .unwrap_or(false);

    if !new_is_empty {
        boot_log(&format!(
            "legacy auto-save dir exists at {:?}, but new dir {:?} is non-empty; leaving legacy in place",
            legacy, new_dir
        ));
        return;
    }

    if new_dir.exists() {
        let _ = std::fs::remove_dir(new_dir);
    }
    match std::fs::rename(&legacy, new_dir) {
        Ok(_) => boot_log(&format!("migrated auto-save {:?} -> {:?}", legacy, new_dir)),
        Err(e) => boot_log(&format!(
            "failed to migrate auto-save {:?} -> {:?}: {}",
            legacy, new_dir, e
        )),
    }
}

fn boot_log_path() -> std::path::PathBuf {
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = std::env::var_os("HOME") {
            return std::path::PathBuf::from(home)
                .join("Library/Application Support/com.ai-canvas.desktop/startup.log");
        }
    }
    std::env::temp_dir().join("aicat-startup.log")
}

/// 在不依赖 Tauri context 的情况下尽量预测 data_dir，仅用于日志落盘目录。
fn predict_log_dir() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "windows")]
    {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            return Some(
                std::path::PathBuf::from(appdata)
                    .join("com.ai-canvas.desktop")
                    .join("logs"),
            );
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = std::env::var_os("HOME") {
            return Some(
                std::path::PathBuf::from(home)
                    .join("Library/Application Support/com.ai-canvas.desktop/logs"),
            );
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Some(home) = std::env::var_os("HOME") {
            return Some(
                std::path::PathBuf::from(home)
                    .join(".local/share/com.ai-canvas.desktop/logs"),
            );
        }
    }
    None
}

static TRACING_GUARD: OnceLock<tracing_appender::non_blocking::WorkerGuard> = OnceLock::new();

fn init_tracing() {
    if let Some(dir) = predict_log_dir() {
        if std::fs::create_dir_all(&dir).is_ok() {
            let file_appender = tracing_appender::rolling::daily(&dir, "app.log");
            let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);
            let init_result = tracing_subscriber::fmt()
                .with_writer(non_blocking)
                .with_ansi(false)
                .with_thread_ids(true)
                .with_target(false)
                .try_init();
            if init_result.is_ok() {
                let _ = TRACING_GUARD.set(guard);
                boot_log(&format!("tracing initialized → file appender at {:?}", dir));
                return;
            }
            boot_log("tracing file init failed, falling back to stderr");
        } else {
            boot_log(&format!("could not create log dir {:?}, falling back to stderr", dir));
        }
    } else {
        boot_log("could not predict log dir, falling back to stderr");
    }
    let _ = tracing_subscriber::fmt().try_init();
}

fn boot_log(msg: &str) {
    use std::io::Write;
    let path = boot_log_path();
    let _ = std::fs::create_dir_all(path.parent().unwrap_or(std::path::Path::new(".")));
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(f, "[{}] {}", chrono::Local::now().format("%H:%M:%S%.3f"), msg);
    }
}

#[cfg(target_os = "windows")]
extern "system" {
    fn MessageBoxW(
        hwnd: *mut std::ffi::c_void,
        text: *const u16,
        caption: *const u16,
        utype: u32,
    ) -> i32;
    fn ShellExecuteW(
        hwnd: *mut std::ffi::c_void,
        operation: *const u16,
        file: *const u16,
        parameters: *const u16,
        directory: *const u16,
        show_cmd: i32,
    ) -> isize;
}

const MIN_WEBVIEW2_MAJOR: u32 = 111;

#[cfg(target_os = "windows")]
fn get_webview2_version() -> (Option<String>, u32) {
    use winreg::enums::*;
    use winreg::RegKey;

    const WV2_CLIENT_KEY: &str =
        r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BEE-13A6279FE6FF}";
    const WV2_CLIENT_KEY_WOW64: &str =
        r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BEE-13A6279FE6FF}";

    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);

    let version = hklm
        .open_subkey(WV2_CLIENT_KEY_WOW64)
        .or_else(|_| hklm.open_subkey(WV2_CLIENT_KEY))
        .or_else(|_| hkcu.open_subkey(WV2_CLIENT_KEY))
        .ok()
        .and_then(|key| key.get_value::<String, _>("pv").ok());

    let major = version
        .as_deref()
        .and_then(|v| v.split('.').next())
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);

    (version, major)
}

#[cfg(target_os = "windows")]
fn win_msgbox(text: &str, caption: &str, flags: u32) -> i32 {
    unsafe {
        use std::os::windows::ffi::OsStrExt;
        let text_w: Vec<u16> = std::ffi::OsStr::new(text)
            .encode_wide()
            .chain(Some(0))
            .collect();
        let cap_w: Vec<u16> = std::ffi::OsStr::new(caption)
            .encode_wide()
            .chain(Some(0))
            .collect();
        MessageBoxW(std::ptr::null_mut(), text_w.as_ptr(), cap_w.as_ptr(), flags)
    }
}

#[cfg(target_os = "windows")]
fn win_open_url(url: &str) {
    unsafe {
        use std::os::windows::ffi::OsStrExt;
        let op: Vec<u16> = std::ffi::OsStr::new("open")
            .encode_wide()
            .chain(Some(0))
            .collect();
        let url_w: Vec<u16> = std::ffi::OsStr::new(url)
            .encode_wide()
            .chain(Some(0))
            .collect();
        ShellExecuteW(
            std::ptr::null_mut(),
            op.as_ptr(),
            url_w.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1, // SW_SHOWNORMAL
        );
    }
}

/// Returns `true` if WebView2 is good to go; `false` means the process should exit.
///
/// When the version is too old, enters a retry loop: the user can install the
/// update and click "重试" without restarting the app.
#[cfg(target_os = "windows")]
fn check_webview2_version() -> bool {
    const WV2_DOWNLOAD_URL: &str = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";

    loop {
        let (version, major) = get_webview2_version();

        if major == 0 || major >= MIN_WEBVIEW2_MAJOR {
            return true;
        }

        let ver_str = version.as_deref().unwrap_or("未知");
        boot_log(&format!(
            "WebView2 too old: v{} (major {}), need >= {}",
            ver_str, major, MIN_WEBVIEW2_MAJOR,
        ));

        // First dialog: offer to open the download page
        // MB_YESNO = 0x04, MB_ICONWARNING = 0x30
        let msg = format!(
            "检测到您的 WebView2 组件版本过旧（v{}），\
             应用界面将无法正常显示。\n\n\
             点击「是」立即打开下载页面。\n\
             点击「否」退出应用。",
            ver_str,
        );
        let choice = win_msgbox(&msg, "AI猫 - 需要更新 WebView2 组件", 0x04 | 0x30);

        if choice != 6 {
            // IDYES = 6; user chose No → exit
            return false;
        }

        win_open_url(WV2_DOWNLOAD_URL);

        // Second dialog: wait for user to finish installing, then retry
        // MB_RETRYCANCEL = 0x05, MB_ICONINFORMATION = 0x40
        let retry = win_msgbox(
            "浏览器已打开 WebView2 下载页面。\n\n\
             请下载并安装完成后，点击「重试」继续启动应用。\n\
             点击「取消」退出应用。",
            "AI猫 - 等待安装完成",
            0x05 | 0x40,
        );

        // IDRETRY = 4
        if retry != 4 {
            return false;
        }

        boot_log("user requested retry after WebView2 install");
        // loop back to re-check the version
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Panic hook: write to file so we can diagnose crashes on macOS (no stderr visible from Finder)
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let msg = format!("PANIC: {}", info);
        boot_log(&msg);
        default_hook(info);
    }));

    boot_log("=== AICat process started ===");

    #[cfg(target_os = "windows")]
    {
        boot_log("checking WebView2 version");
        if !check_webview2_version() {
            boot_log("WebView2 too old, exiting");
            return;
        }
    }

    init_tracing();

    boot_log("building tauri app");

    let result = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            boot_log("setup() entered");

            // macOS 上必须注册原生 Edit 菜单，否则 Cmd+C/V/A/Z 等会被系统吞掉，
            // webview 收不到 keydown 事件、剪贴板事件，导致复制粘贴失效。
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{MenuBuilder, SubmenuBuilder};
                let app_submenu = SubmenuBuilder::new(app, "AICat")
                    .about(None)
                    .separator()
                    .hide()
                    .hide_others()
                    .show_all()
                    .separator()
                    .quit()
                    .build()?;
                let edit_submenu = SubmenuBuilder::new(app, "Edit")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .separator()
                    .select_all()
                    .build()?;
                let window_submenu = SubmenuBuilder::new(app, "Window")
                    .minimize()
                    .fullscreen()
                    .build()?;
                let menu = MenuBuilder::new(app)
                    .items(&[&app_submenu, &edit_submenu, &window_submenu])
                    .build()?;
                app.set_menu(menu)?;
                boot_log("macOS native menu registered");
            }

            boot_log("resolving data_dir");
            let data_dir = resolve_data_dir(app)?;
            boot_log(&format!("data_dir = {:?}", data_dir));

            std::fs::create_dir_all(&data_dir)?;
            std::fs::create_dir_all(data_dir.join("media/images"))?;
            std::fs::create_dir_all(data_dir.join("media/thumbnails"))?;

            let auto_save_default_dir = resolve_auto_save_default_dir(&data_dir);
            boot_log(&format!("auto_save_default_dir = {:?}", auto_save_default_dir));
            migrate_legacy_auto_save_dir(&data_dir, &auto_save_default_dir);
            std::fs::create_dir_all(&auto_save_default_dir)?;
            boot_log("directories created");

            if let Err(e) = app.asset_protocol_scope().allow_directory(&data_dir, true) {
                boot_log(&format!("asset scope warn: {}", e));
            }
            if auto_save_default_dir.starts_with(&data_dir) {
                // 已经在 data_dir 下，asset 协议作用域已覆盖
            } else if let Err(e) = app
                .asset_protocol_scope()
                .allow_directory(&auto_save_default_dir, true)
            {
                boot_log(&format!("asset scope warn (auto_save_default): {}", e));
            }

            // 备份目录：故意放在 ~/Documents/AICat Data/backups/ 而非 data_dir，
            // AppCleaner / Windows 卸载器都不会动 Documents，是"重装数据丢失"的最后防线。
            let doc_dir = app.path().document_dir().ok();
            let backup_dir = backup::resolve_backup_dir(doc_dir.as_deref())
                .unwrap_or_else(|| data_dir.join("backups"));
            boot_log(&format!("backup_dir = {:?}", backup_dir));

            let db_path = data_dir.join("data.db");

            // 处理用户在上一次会话中"安排"的恢复（commands::backup::prepare_restore 写的标记）。
            // 必须在 db::init 之前，否则 Windows 上数据库文件被占用无法覆盖。
            let pending_marker = data_dir.join(".pending-restore");
            if pending_marker.exists() {
                match std::fs::read_to_string(&pending_marker) {
                    Ok(backup_path) => {
                        let bp = std::path::PathBuf::from(backup_path.trim());
                        boot_log(&format!("pending restore from {:?}", bp));
                        match backup::restore_from(&bp, &db_path) {
                            Ok(_) => {
                                boot_log("pending restore succeeded");
                                tracing::info!("restored data.db from user-selected backup {:?}", bp);
                            }
                            Err(e) => {
                                boot_log(&format!("pending restore failed: {}", e));
                                tracing::error!("pending restore failed: {}", e);
                            }
                        }
                        let _ = std::fs::remove_file(&pending_marker);
                    }
                    Err(e) => {
                        boot_log(&format!("read pending-restore marker failed: {}", e));
                        let _ = std::fs::remove_file(&pending_marker);
                    }
                }
            }

            // 关键防线：data.db 不存在但备份目录有 → 从最新备份恢复。
            // 必须在 db::init 之前，否则会创建一个空库再迁移。
            match backup::restore_if_missing(&db_path, &backup_dir) {
                Ok(Some(used)) => {
                    boot_log(&format!("auto-restored data.db from backup {:?}", used));
                    tracing::warn!(
                        "data.db missing — restored from backup {:?}",
                        used
                    );
                }
                Ok(None) => {}
                Err(e) => {
                    boot_log(&format!("restore_if_missing failed: {}", e));
                }
            }

            boot_log("opening database");
            let conn = db::init(&db_path)?;
            boot_log("database ready");

            // 启动后立即备份一份。失败仅 warn，不阻塞启动。
            match backup::create_backup(&conn, &backup_dir, backup::DEFAULT_MAX_KEEP) {
                Ok(p) => boot_log(&format!("startup backup created: {:?}", p)),
                Err(e) => boot_log(&format!("startup backup failed: {}", e)),
            }

            app.manage(AppState {
                db: Mutex::new(conn),
                http_client: OnceLock::new(),
                stream_client: OnceLock::new(),
                active_streams: Mutex::new(HashMap::new()),
                data_dir: data_dir.clone(),
                auto_save_default_dir,
                backup_dir: backup_dir.clone(),
            });
            boot_log("state managed (http clients deferred)");

            // 定时备份：每 30 分钟一份，跟随保留策略自动清理旧份。
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut ticker =
                    tokio::time::interval(std::time::Duration::from_secs(30 * 60));
                ticker.tick().await; // 跳过首次（启动时已备份）
                loop {
                    ticker.tick().await;
                    if let Some(state) = handle.try_state::<AppState>() {
                        let conn_guard = state.db.lock();
                        if let Ok(conn) = conn_guard {
                            match backup::create_backup(
                                &conn,
                                &state.backup_dir,
                                backup::DEFAULT_MAX_KEEP,
                            ) {
                                Ok(p) => {
                                    tracing::info!("periodic backup created: {:?}", p)
                                }
                                Err(e) => tracing::warn!("periodic backup failed: {}", e),
                            }
                        }
                    }
                }
            });

            if let Some(win) = app.get_webview_window("main") {
                #[cfg(target_os = "macos")]
                {
                    boot_log("configuring macOS window");
                    let _ = win.set_decorations(true);
                    use tauri::TitleBarStyle;
                    let _ = win.set_title_bar_style(TitleBarStyle::Overlay);
                    boot_log("macOS window configured");
                }
                let _ = win.show();
                boot_log("window shown");
            }
            boot_log("setup complete");

            tracing::info!("app initialized, data dir: {:?}", data_dir);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                window.app_handle().exit(0);
            }
        })
        .invoke_handler(tauri::generate_handler![
            quit_app,
            resize_window,
            commands::project::list_projects,
            commands::project::list_deleted_projects,
            commands::project::create_project,
            commands::project::delete_project,
            commands::project::restore_project,
            commands::project::permanently_delete_project,
            commands::project::rename_project,
            commands::project::get_setting,
            commands::project::set_setting,
            commands::project::load_cards,
            commands::project::save_card,
            commands::project::save_cards_batch,
            commands::project::delete_card,
            commands::project::load_connections,
            commands::project::save_connections_batch,
            commands::project::clear_project_connections,
            commands::ai::ai_proxy,
            commands::ai::ai_proxy_stream,
            commands::ai::ai_proxy_stream_abort,
            commands::ai::save_media,
            commands::ai::read_media_base64,
            commands::ai::get_media_base_path,
            commands::ai::export_file,
            commands::ai::open_in_explorer,
            commands::gateway::list_models,
            commands::gateway::poll_task,
            commands::gateway::validate_connection,
            commands::chat::list_chat_sessions,
            commands::chat::create_chat_session,
            commands::chat::rename_chat_session,
            commands::chat::delete_chat_session,
            commands::chat::load_chat_messages,
            commands::chat::save_chat_message,
            commands::chat::clear_chat_messages,
            commands::device::get_machine_code,
            commands::backup::list_backups,
            commands::backup::get_backup_dir,
            commands::backup::create_backup_now,
            commands::backup::prepare_restore,
            commands::backup::cancel_pending_restore,
            commands::backup::get_pending_restore,
        ])
        .run(tauri::generate_context!());

    if let Err(e) = result {
        boot_log(&format!("FATAL: tauri run failed: {}", e));
        eprintln!("tauri run failed: {}", e);
    }
}
