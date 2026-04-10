mod commands;
mod db;

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tauri::Manager;

pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
    pub http_client: reqwest::Client,
    pub stream_client: reqwest::Client,
    pub active_streams: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");

            std::fs::create_dir_all(&app_data_dir)?;
            std::fs::create_dir_all(app_data_dir.join("media/images"))?;
            std::fs::create_dir_all(app_data_dir.join("media/thumbnails"))?;

            let db_path = app_data_dir.join("data.db");
            let conn = db::init(&db_path)?;

            let http_client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(120))
                .connect_timeout(std::time::Duration::from_secs(10))
                .build()
                .expect("failed to create http client");

            let stream_client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(300))
                .connect_timeout(std::time::Duration::from_secs(30))
                .http1_only()
                .build()
                .expect("failed to create streaming http client");

            app.manage(AppState {
                db: Mutex::new(conn),
                http_client,
                stream_client,
                active_streams: Mutex::new(HashMap::new()),
            });

            tracing::info!("app initialized, data dir: {:?}", app_data_dir);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
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
            commands::ai::ai_proxy,
            commands::ai::ai_proxy_stream,
            commands::ai::ai_proxy_stream_abort,
            commands::ai::save_media,
            commands::ai::read_media_base64,
            commands::ai::get_media_base_path,
            commands::ai::export_image,
            commands::ai::open_in_explorer,
            commands::gateway::list_models,
            commands::gateway::poll_task,
            commands::gateway::validate_connection,
            commands::clipboard::clipboard_write,
            commands::clipboard::clipboard_read,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
