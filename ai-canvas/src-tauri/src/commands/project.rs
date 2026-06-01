use crate::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Serialize)]
pub struct ProjectInfo {
    pub id: String,
    pub title: String,
    pub thumbnail: Option<String>,
    pub node_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[tauri::command]
pub fn list_projects(state: State<AppState>) -> Result<Vec<ProjectInfo>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = db
        .prepare(
            "SELECT p.id, p.title, p.thumbnail,
                    (SELECT COUNT(*) FROM cards c WHERE c.project_id = p.id) AS node_count,
                    p.created_at, p.updated_at
             FROM projects p
             WHERE p.deleted_at IS NULL
             ORDER BY p.updated_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let projects = stmt
        .query_map([], |row| {
            Ok(ProjectInfo {
                id: row.get(0)?,
                title: row.get(1)?,
                thumbnail: row.get(2)?,
                node_count: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(projects)
}

#[tauri::command]
pub fn list_deleted_projects(state: State<AppState>) -> Result<Vec<ProjectInfo>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = db
        .prepare(
            "SELECT p.id, p.title, p.thumbnail,
                    (SELECT COUNT(*) FROM cards c WHERE c.project_id = p.id) AS node_count,
                    p.created_at, p.updated_at
             FROM projects p
             WHERE p.deleted_at IS NOT NULL
             ORDER BY p.deleted_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let projects = stmt
        .query_map([], |row| {
            Ok(ProjectInfo {
                id: row.get(0)?,
                title: row.get(1)?,
                thumbnail: row.get(2)?,
                node_count: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(projects)
}

#[tauri::command]
pub fn create_project(state: State<AppState>, title: String) -> Result<ProjectInfo, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();

    db.execute(
        "INSERT INTO projects (id, title) VALUES (?1, ?2)",
        rusqlite::params![id, title],
    )
    .map_err(|e| e.to_string())?;

    let project = db
        .query_row(
            "SELECT p.id, p.title, p.thumbnail,
                    (SELECT COUNT(*) FROM cards c WHERE c.project_id = p.id) AS node_count,
                    p.created_at, p.updated_at
             FROM projects p WHERE p.id = ?1",
            rusqlite::params![id],
            |row| {
                Ok(ProjectInfo {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    thumbnail: row.get(2)?,
                    node_count: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            },
        )
        .map_err(|e| e.to_string())?;

    Ok(project)
}

#[tauri::command]
pub fn delete_project(state: State<AppState>, id: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "UPDATE projects SET deleted_at = datetime('now') WHERE id = ?1",
        rusqlite::params![id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn restore_project(state: State<AppState>, id: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "UPDATE projects SET deleted_at = NULL WHERE id = ?1",
        rusqlite::params![id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn permanently_delete_project(state: State<AppState>, id: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    // chat_sessions.project_id 是普通列（v6 schema 未声明 FK 级联），
    // 因此这里必须显式清理，否则项目永久删除后聊天记录会成为孤儿。
    // chat_messages 通过 session_id 已有 ON DELETE CASCADE，会自动跟随。
    db.execute(
        "DELETE FROM chat_sessions WHERE project_id = ?1",
        rusqlite::params![id],
    )
    .map_err(|e| e.to_string())?;
    db.execute("DELETE FROM projects WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn rename_project(state: State<AppState>, id: String, title: String) -> Result<(), String> {
    let old_title: Option<String> = {
        let db = state.db.lock().map_err(|e| e.to_string())?;

        let old_title: Option<String> = db
            .query_row(
                "SELECT title FROM projects WHERE id = ?1",
                rusqlite::params![id],
                |row| row.get(0),
            )
            .ok();

        db.execute(
            "UPDATE projects SET title = ?1, updated_at = datetime('now') WHERE id = ?2",
            rusqlite::params![title, id],
        )
        .map_err(|e| e.to_string())?;

        old_title
    };

    if let Some(old) = old_title {
        if old != title {
            let old_folder = super::ai::build_project_folder_name_pub(&old, &id);
            let new_folder = super::ai::build_project_folder_name_pub(&title, &id);

            if old_folder != new_folder {
                // 重新锁一次 db 来读候选目录, scope 严格限定。
                // candidate_save_dirs 现在签名是 (&Connection, &Path), 不会再嵌套锁。
                let bases = {
                    let db = state.db.lock().map_err(|e| e.to_string())?;
                    super::ai::candidate_save_dirs(&db, &state.data_dir)
                };

                for base in &bases {
                    let old_path = base.join(&old_folder);
                    let new_path = base.join(&new_folder);
                    if !old_path.exists() {
                        continue;
                    }
                    if new_path.exists() {
                        tracing::warn!(
                            "目标文件夹已存在，跳过重命名: {:?} (项目 {} → {})",
                            new_path, old_folder, new_folder
                        );
                        continue;
                    }
                    match std::fs::rename(&old_path, &new_path) {
                        Ok(_) => tracing::info!(
                            "自动保存文件夹已重命名: {:?} → {:?}",
                            old_path, new_path
                        ),
                        Err(e) => tracing::warn!(
                            "重命名自动保存文件夹失败 ({:?} → {:?}): {}",
                            old_path, new_path, e
                        ),
                    }
                }
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub fn get_setting(state: State<AppState>, key: String) -> Result<Option<String>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let result = db.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        rusqlite::params![key],
        |row| row.get(0),
    );

    match result {
        Ok(value) => Ok(Some(value)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn set_setting(state: State<AppState>, key: String, value: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
        rusqlite::params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CardRow {
    pub id: String,
    pub project_id: String,
    #[serde(rename = "type")]
    pub card_type: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub z_index: i64,
    pub locked: bool,
    pub collapsed: bool,
    pub color: Option<String>,
    pub title: Option<String>,
    pub data: String,
    pub created_at: String,
    pub updated_at: String,
}

fn upsert_card(
    conn: &rusqlite::Connection,
    card: &CardRow,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT OR REPLACE INTO cards (id, project_id, type, x, y, width, height, z_index, locked, collapsed, color, title, data, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, datetime('now'))",
        rusqlite::params![
            card.id,
            card.project_id,
            card.card_type,
            card.x,
            card.y,
            card.width,
            card.height,
            card.z_index,
            if card.locked { 1i64 } else { 0 },
            if card.collapsed { 1i64 } else { 0 },
            card.color,
            card.title,
            card.data,
            card.created_at,
        ],
    )?;
    conn.execute(
        "UPDATE projects SET updated_at = datetime('now') WHERE id = ?1",
        rusqlite::params![card.project_id],
    )?;
    Ok(())
}

#[tauri::command]
pub fn load_cards(state: State<AppState>, project_id: String) -> Result<Vec<CardRow>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = db
        .prepare(
            "SELECT id, project_id, type, x, y, width, height, z_index, locked, collapsed, color, title, data, created_at, updated_at FROM cards WHERE project_id = ?1 ORDER BY z_index, id",
        )
        .map_err(|e| e.to_string())?;

    let cards = stmt
        .query_map(rusqlite::params![project_id], |row| {
            let locked_i: i64 = row.get(8)?;
            let collapsed_i: i64 = row.get(9)?;
            Ok(CardRow {
                id: row.get(0)?,
                project_id: row.get(1)?,
                card_type: row.get(2)?,
                x: row.get(3)?,
                y: row.get(4)?,
                width: row.get(5)?,
                height: row.get(6)?,
                z_index: row.get(7)?,
                locked: locked_i != 0,
                collapsed: collapsed_i != 0,
                color: row.get(10)?,
                title: row.get(11)?,
                data: row.get(12)?,
                created_at: row.get(13)?,
                updated_at: row.get(14)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(cards)
}

#[tauri::command]
pub fn save_card(state: State<AppState>, card: CardRow) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    upsert_card(&db, &card).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn save_cards_batch(state: State<AppState>, cards: Vec<CardRow>) -> Result<(), String> {
    let mut db = state.db.lock().map_err(|e| e.to_string())?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    for card in &cards {
        upsert_card(&tx, card).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_card(state: State<AppState>, id: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "DELETE FROM connections WHERE source_card_id = ?1 OR target_card_id = ?1",
        rusqlite::params![id],
    )
    .map_err(|e| e.to_string())?;
    db.execute("DELETE FROM cards WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Connection Commands ──────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct ConnectionRow {
    pub id: String,
    pub project_id: String,
    pub source_card_id: String,
    pub target_card_id: String,
    pub created_at: String,
}

#[tauri::command]
pub fn load_connections(state: State<AppState>, project_id: String) -> Result<Vec<ConnectionRow>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = db
        .prepare(
            "SELECT id, project_id, source_card_id, target_card_id, created_at
             FROM connections WHERE project_id = ?1 ORDER BY created_at",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(rusqlite::params![project_id], |row| {
            Ok(ConnectionRow {
                id: row.get(0)?,
                project_id: row.get(1)?,
                source_card_id: row.get(2)?,
                target_card_id: row.get(3)?,
                created_at: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(rows)
}

#[tauri::command]
pub fn save_connections_batch(state: State<AppState>, connections: Vec<ConnectionRow>) -> Result<(), String> {
    if connections.is_empty() {
        return Ok(());
    }
    let project_id = connections[0].project_id.clone();

    let mut db = state.db.lock().map_err(|e| e.to_string())?;
    let tx = db.transaction().map_err(|e| e.to_string())?;

    tx.execute(
        "DELETE FROM connections WHERE project_id = ?1",
        rusqlite::params![project_id],
    )
    .map_err(|e| e.to_string())?;

    for conn in &connections {
        tx.execute(
            "INSERT INTO connections (id, project_id, source_card_id, target_card_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                conn.id,
                conn.project_id,
                conn.source_card_id,
                conn.target_card_id,
                conn.created_at,
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn clear_project_connections(state: State<AppState>, project_id: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "DELETE FROM connections WHERE project_id = ?1",
        rusqlite::params![project_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
