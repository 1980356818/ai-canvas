//! 节点分组 (card_groups 表) 的 Tauri commands。
//!
//! 跟 `project::*_card*` / `project::*_connection*` 风格一致:
//!   • 读取按 project_id 过滤;
//!   • 写入走 transaction + upsert;
//!   • 删除单条按 id。
//!
//! card_ids 列在 DB 端是 JSON 字符串,前端拼好再发过来,Rust 不解析。
//! Frame 容器化后:边界 x/y/width/height 已持久化(组拥有自己的矩形),
//! card_ids 降级为「派生缓存」(成员 = 落在边界内的卡片,前端校准后写回)。
//! 详见 db::migrations::migrate_v12 与 docs/Frame容器化-架构与施工图.md。

use crate::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CardGroupRow {
    pub id: String,
    pub project_id: String,
    pub card_ids: String,
    pub title: String,
    pub color: String,
    pub collapsed: bool,
    // Frame 容器化:存储边界(world 坐标)。成员 = 落在该矩形内的卡片。
    // serde(default) 让旧导出(无 bounds 字段)能反序列化为 0,随后由前端回填。
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    #[serde(default)]
    pub width: f64,
    #[serde(default)]
    pub height: f64,
    pub created_at: String,
    pub updated_at: String,
}

pub(crate) fn upsert_group(
    conn: &rusqlite::Connection,
    group: &CardGroupRow,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT OR REPLACE INTO card_groups
            (id, project_id, card_ids, title, color, collapsed, x, y, width, height, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, datetime('now'))",
        rusqlite::params![
            group.id,
            group.project_id,
            group.card_ids,
            group.title,
            group.color,
            if group.collapsed { 1i64 } else { 0 },
            group.x,
            group.y,
            group.width,
            group.height,
            group.created_at,
        ],
    )?;
    // 分组变更也算项目活动,顺手 bump updated_at,让"最近项目"排序正确。
    conn.execute(
        "UPDATE projects SET updated_at = datetime('now') WHERE id = ?1",
        rusqlite::params![group.project_id],
    )?;
    Ok(())
}

/// 读取某项目的全部分组(`&Connection` 版,锁责任在调用方)。
/// `load_groups` 命令与「导出项目」共用。
pub(crate) fn query_groups(
    conn: &rusqlite::Connection,
    project_id: &str,
) -> Result<Vec<CardGroupRow>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, project_id, card_ids, title, color, collapsed, x, y, width, height, created_at, updated_at
         FROM card_groups WHERE project_id = ?1 ORDER BY created_at",
    )?;

    let rows = stmt.query_map(rusqlite::params![project_id], |row| {
        let collapsed_i: i64 = row.get(5)?;
        Ok(CardGroupRow {
            id: row.get(0)?,
            project_id: row.get(1)?,
            card_ids: row.get(2)?,
            title: row.get(3)?,
            color: row.get(4)?,
            collapsed: collapsed_i != 0,
            x: row.get(6)?,
            y: row.get(7)?,
            width: row.get(8)?,
            height: row.get(9)?,
            created_at: row.get(10)?,
            updated_at: row.get(11)?,
        })
    })?;
    rows.collect()
}

#[tauri::command]
pub fn load_groups(
    state: State<AppState>,
    project_id: String,
) -> Result<Vec<CardGroupRow>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    query_groups(&db, &project_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_groups_batch(
    state: State<AppState>,
    groups: Vec<CardGroupRow>,
) -> Result<(), String> {
    if groups.is_empty() {
        return Ok(());
    }
    let mut db = state.db.lock().map_err(|e| e.to_string())?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    for group in &groups {
        upsert_group(&tx, group).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_group(state: State<AppState>, id: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "DELETE FROM card_groups WHERE id = ?1",
        rusqlite::params![id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
