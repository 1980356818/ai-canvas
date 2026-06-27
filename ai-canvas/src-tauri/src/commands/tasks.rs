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
    /// 该卡内尝试序号(1,2,3…)。用于面板展示「尝试 #N」与排序。
    pub attempt_no: i64,
    /// 被「重新生成」替换的时刻;NULL = 当前尝试(唯一驱动画布卡)。
    pub superseded_at: Option<String>,
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
        attempt_no: row.get(19)?,
        superseded_at: row.get(20)?,
    })
}

const SELECT_COLS: &str = "id, card_id, project_id, provider, kind, submit_endpoint, poll_endpoint, external_task_id, status, progress, request_payload, result_payload, error_kind, error_message, key_tag, retry_count, created_at, updated_at, last_polled_at, attempt_no, superseded_at";

/// Upsert (insert-or-replace) 一个 task。前端 TaskManager 每次状态转换都调一次。
///
/// `updated_at` 在 SQL 侧统一刷新为 `datetime('now')`，前端传过来的值会被忽略；
/// `created_at` 沿用前端传入（首次写入时 = now，后续更新时保持原值，避免被覆盖）。
#[tauri::command]
pub fn tasks_upsert(state: State<AppState>, task: TaskRow) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "INSERT INTO tasks (id, card_id, project_id, provider, kind, submit_endpoint, poll_endpoint, external_task_id, status, progress, request_payload, result_payload, error_kind, error_message, key_tag, retry_count, created_at, updated_at, last_polled_at, attempt_no, superseded_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, datetime('now'), ?18, ?19, ?20)
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
             last_polled_at = excluded.last_polled_at,
             attempt_no = excluded.attempt_no,
             -- sticky:一旦被置为「被替换」,后续任何状态机 upsert(进度/成功)都不再清回 NULL。
             superseded_at = COALESCE(tasks.superseded_at, excluded.superseded_at)",
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
            task.attempt_no,
            task.superseded_at,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 把该卡所有「当前(superseded_at IS NULL)」的旧任务标记为被替换,返回下一个 attempt_no。
///
/// helper 形式(吃 `&Connection`,符合 AppState 的「锁责任丢给调用方」规范,也便于单测);
/// 命令在持有 db 锁时调用即原子(单连接串行,UPDATE 后 SELECT 之间无其他写者)。
fn supersede_current_and_next_attempt(
    conn: &rusqlite::Connection,
    card_id: &str,
) -> rusqlite::Result<i64> {
    conn.execute(
        "UPDATE tasks SET superseded_at = datetime('now'), updated_at = datetime('now') \
         WHERE card_id = ?1 AND superseded_at IS NULL",
        rusqlite::params![card_id],
    )?;
    conn.query_row(
        "SELECT COALESCE(MAX(attempt_no), 0) + 1 FROM tasks WHERE card_id = ?1",
        rusqlite::params![card_id],
        |row| row.get(0),
    )
}

/// 开启该卡的一次新生成尝试:原子标记所有「当前」旧任务为被替换,并返回下一个 attempt_no。
/// 前端据此创建新的「当前」任务。
///
/// 本命令只动 DB 标记,**不**中止任何在跑的任务 —— 保活策略(已计费的后台跑完、
/// 未计费的另行中止)由前端 TaskManager.beginAttempt 决定。详见
/// docs/卡片任务面板-生成尝试可观测与可恢复-设计施工图.md。
#[tauri::command]
pub fn tasks_begin_attempt(state: State<AppState>, card_id: String) -> Result<i64, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    supersede_current_and_next_attempt(&db, &card_id).map_err(|e| e.to_string())
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

/// 列出某个项目下的所有任务（含终态），按 created_at DESC 排序。
/// 任务记录页面打开时一次性灌入内存 store。
#[tauri::command]
pub fn tasks_list_by_project(
    state: State<AppState>,
    project_id: String,
) -> Result<Vec<TaskRow>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let sql = format!(
        "SELECT {} FROM tasks WHERE project_id = ?1 ORDER BY created_at DESC",
        SELECT_COLS
    );
    let mut stmt = db.prepare(&sql).map_err(|e| e.to_string())?;
    let tasks = stmt
        .query_map(rusqlite::params![project_id], row_to_task)
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

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn setup() -> Connection {
        // 内存库跑全部迁移(含 v13 给 tasks 加 attempt_no / superseded_at)。
        // 本仓 bundled SQLite 默认 foreign_keys=ON,这里关掉以便直接插 tasks 而不必先建
        // project/card 父行(本测只验 attempt 标记/计数逻辑,与 FK 无关)。
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        conn.pragma_update(None, "foreign_keys", "OFF").unwrap();
        conn
    }

    fn insert(conn: &Connection, id: &str, card: &str, attempt_no: i64, superseded: Option<&str>) {
        conn.execute(
            "INSERT INTO tasks (id, card_id, project_id, provider, kind, submit_endpoint, status, attempt_no, superseded_at) \
             VALUES (?1, ?2, 'p1', 'comfly', 'image_gen', '/v1/images', 'success', ?3, ?4)",
            rusqlite::params![id, card, attempt_no, superseded],
        )
        .unwrap();
    }

    #[test]
    fn migration_v13_adds_attempt_columns() {
        let conn = setup();
        insert(&conn, "x", "c1", 5, Some("2026-01-01T00:00:00Z"));
        let (an, sup): (i64, Option<String>) = conn
            .query_row(
                "SELECT attempt_no, superseded_at FROM tasks WHERE id='x'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(an, 5);
        assert_eq!(sup.as_deref(), Some("2026-01-01T00:00:00Z"));
    }

    #[test]
    fn begin_attempt_supersedes_current_and_increments_per_card() {
        let conn = setup();
        insert(&conn, "a", "c1", 1, None);

        // 第一次开启新尝试:旧的 a 被标 superseded,返回下一个 attempt_no = 2
        let n1 = supersede_current_and_next_attempt(&conn, "c1").unwrap();
        assert_eq!(n1, 2);
        let sup_a: Option<String> = conn
            .query_row("SELECT superseded_at FROM tasks WHERE id='a'", [], |r| r.get(0))
            .unwrap();
        assert!(sup_a.is_some(), "旧的当前任务必须被标记 superseded");

        // 新当前任务入库(attempt_no=2),再开启 → b 被替换,返回 3
        insert(&conn, "b", "c1", 2, None);
        let n2 = supersede_current_and_next_attempt(&conn, "c1").unwrap();
        assert_eq!(n2, 3);
        let current_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM tasks WHERE card_id='c1' AND superseded_at IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(current_count, 0, "开启新尝试后,该卡不应残留任何「当前」任务");
    }

    #[test]
    fn begin_attempt_does_not_cross_cards() {
        let conn = setup();
        insert(&conn, "a", "c1", 1, None);
        // 另一张卡从 1 开始,且不受 c1 影响
        let other = supersede_current_and_next_attempt(&conn, "c2").unwrap();
        assert_eq!(other, 1);
        let sup_a: Option<String> = conn
            .query_row("SELECT superseded_at FROM tasks WHERE id='a'", [], |r| r.get(0))
            .unwrap();
        assert!(sup_a.is_none(), "开启 c2 的尝试不应影响 c1 的任务");
    }
}
