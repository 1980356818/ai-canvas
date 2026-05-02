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
/// - **Windows debug / macOS / Linux**：始终使用系统 app_data_dir。
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

    Ok(app_data)
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

    tracing_subscriber::fmt::init();

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
            std::fs::create_dir_all(data_dir.join("auto-save"))?;
            boot_log("directories created");

            if let Err(e) = app.asset_protocol_scope().allow_directory(&data_dir, true) {
                boot_log(&format!("asset scope warn: {}", e));
            }

            let db_path = data_dir.join("data.db");
            boot_log("opening database");
            let conn = db::init(&db_path)?;
            boot_log("database ready");

            app.manage(AppState {
                db: Mutex::new(conn),
                http_client: OnceLock::new(),
                stream_client: OnceLock::new(),
                active_streams: Mutex::new(HashMap::new()),
                data_dir: data_dir.clone(),
            });
            boot_log("state managed (http clients deferred)");

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
        ])
        .run(tauri::generate_context!());

    if let Err(e) = result {
        boot_log(&format!("FATAL: tauri run failed: {}", e));
        eprintln!("tauri run failed: {}", e);
    }
}
