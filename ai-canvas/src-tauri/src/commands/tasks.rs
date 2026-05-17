use crate::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TaskRow {
    pub id: String,
    pub card_id: String,
    pub project_id: String,
    pub provider: String,
    pub kind: String,
    pub submit_endpoint: String,
    pub poll_endpoint: Option<String>,
    pub external_task_id: Option<String>,
    pub status: String,
    pub progress: f64,
    pub request_payload: String,
    pub result_payload: Option<String>,
    pub error_kind: Option<String>,
    pub error_message: Option<String>,
    pub key_tag: Option<String>,
    pub retry_count: i64,
    pub created_at: String,
    pub updated_at: String,
    pub last_polled_at: Option<String>,
}

fn row_to_task(row: &rusqlite::Row<'_>) -> Result<TaskRow, rusqlite::Error> {
    Ok(TaskRow {
        id: row.get(0)?,
        card_id: row.get(1)?,
        project_id: row.get(2)?,
        provider: row.get(3)?,
        kind: row.get(4)?,
        submit_endpoint: row.get(5)?,
        poll_endpoint: row.get(6)?,
        external_task_id: row.get(7)?,
        status: row.get(8)?,
        progress: row.get(9)?,
        request_payload: row.get(10)?,
        result_payload: row.get(11)?,
        error_kind: row.get(12)?,
        error_message: row.get(13)?,
        key_tag: row.get(14)?,
        retry_count: row.get(15)?,
        created_at: row.get(16)?,
        updated_at: row.get(17)?,
        last_polled_at: row.get(18)?,
    })
}

const SELECT_COLS: &str = "id, card_id, project_id, provider, kind, submit_endpoint, poll_endpoint, external_task_id, status, progress, request_payload, result_payload, error_kind, error_message, key_tag, retry_count, created_at, updated_at, last_polled_at";

/// Upsert (insert-or-replace) 一个 task。前端 TaskManager 每次状态转换都调一次。
///
/// `updated_at` 在 SQL 侧统一刷新为 `datetime('now')`，前端传过来的值会被忽略；
/// `created_at` 沿用前端传入（首次写入时 = now，后续更新时保持原值，避免被覆盖）。
#[tauri::command]
pub fn tasks_upsert(state: State<AppState>, task: TaskRow) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "INSERT INTO tasks (id, card_id, project_id, provider, kind, submit_endpoint, poll_endpoint, external_task_id, status, progress, request_payload, result_payload, error_kind, error_message, key_tag, retry_count, created_at, updated_at, last_polled_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, datetime('now'), ?18)
         ON CONFLICT(id) DO UPDATE SET
             provider = excluded.provider,
             kind = excluded.kind,
             submit_endpoint = excluded.submit_endpoint,
             poll_endpoint = excluded.poll_endpoint,
             external_task_id = excluded.external_task_id,
             status = excluded.status,
             progress = excluded.progress,
             request_payload = excluded.request_payload,
             result_payload = excluded.result_payload,
             error_kind = excluded.error_kind,
             error_message = excluded.error_message,
             key_tag = excluded.key_tag,
             retry_count = excluded.retry_count,
             updated_at = datetime('now'),
             last_polled_at = excluded.last_polled_at",
        rusqlite::params![
            task.id,
            task.card_id,
            task.project_id,
            task.provider,
            task.kind,
            task.submit_endpoint,
            task.poll_endpoint,
            task.external_task_id,
            task.status,
            task.progress,
            task.request_payload,
            task.result_payload,
            task.error_kind,
            task.error_message,
            task.key_tag,
            task.retry_count,
            task.created_at,
            task.last_polled_at,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn tasks_get(state: State<AppState>, id: String) -> Result<Option<TaskRow>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let sql = format!("SELECT {} FROM tasks WHERE id = ?1", SELECT_COLS);
    let result = db.query_row(&sql, rusqlite::params![id], row_to_task);
    match result {
        Ok(t) => Ok(Some(t)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// 列出所有"还没到终态"的任务。
///
/// 应用启动 / 切项目 / 网络恢复时 TaskManager 拿这个清单去 resume。
/// 终态（success / failed / canceled / orphaned）不返回，避免恢复已完结任务。
#[tauri::command]
pub fn tasks_list_pending(
    state: State<AppState>,
    project_id: Option<String>,
) -> Result<Vec<TaskRow>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;

    let (sql, params): (String, Vec<Box<dyn rusqlite::ToSql>>) = match project_id {
        Some(pid) => (
            format!(
                "SELECT {} FROM tasks WHERE status IN ('queued','submitting','polling') AND project_id = ?1 ORDER BY created_at",
                SELECT_COLS
            ),
            vec![Box::new(pid)],
        ),
        None => (
            format!(
                "SELECT {} FROM tasks WHERE status IN ('queued','submitting','polling') ORDER BY created_at",
                SELECT_COLS
            ),
            vec![],
        ),
    };

    let mut stmt = db.prepare(&sql).map_err(|e| e.to_string())?;
    let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();

    let tasks = stmt
        .query_map(param_refs.as_slice(), row_to_task)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(tasks)
}

/// 列出某张卡片关联的所有任务（最新在前）。UI 用它展示历史 / 找最近一次活动任务。
#[tauri::command]
pub fn tasks_list_by_card(
    state: State<AppState>,
    card_id: String,
) -> Result<Vec<TaskRow>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let sql = format!(
        "SELECT {} FROM tasks WHERE card_id = ?1 ORDER BY created_at DESC",
        SELECT_COLS
    );
    let mut stmt = db.prepare(&sql).map_err(|e| e.to_string())?;
    let tasks = stmt
        .query_map(rusqlite::params![card_id], row_to_task)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(tasks)
}

/// 硬删一个任务记录。一般不用，保留作为兜底（比如用户手动清理）。
/// 卡片删除会通过 FK CASCADE 自动连带删除关联 tasks，这里不需要再调。
#[tauri::command]
pub fn tasks_delete(state: State<AppState>, id: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute("DELETE FROM tasks WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 清理超过 `days` 天的终态任务记录，保持表不无限增长。
/// 应用启动时调一次即可，删除不影响任何活动任务。
#[tauri::command]
pub fn tasks_cleanup_terminal(state: State<AppState>, days: i64) -> Result<usize, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let affected = db
        .execute(
            "DELETE FROM tasks WHERE status IN ('success','failed','canceled','orphaned') AND updated_at < datetime('now', ?1)",
            rusqlite::params![format!("-{} days", days)],
        )
        .map_err(|e| e.to_string())?;
    Ok(affected)
}
