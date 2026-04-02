use rusqlite::Connection;

const CURRENT_VERSION: u32 = 2;

pub fn run(conn: &Connection) -> Result<(), Box<dyn std::error::Error>> {
    let version: u32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    tracing::info!("database version: {}, target: {}", version, CURRENT_VERSION);

    if version < 1 {
        migrate_v1(conn)?;
    }
    if version < 2 {
        migrate_v2(conn)?;
    }

    Ok(())
}

fn migrate_v1(conn: &Connection) -> Result<(), Box<dyn std::error::Error>> {
    tracing::info!("running migration v1: initial schema");

    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS projects (
            id          TEXT PRIMARY KEY,
            title       TEXT NOT NULL DEFAULT 'Untitled',
            thumbnail   TEXT,
            node_count  INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS cards (
            id          TEXT PRIMARY KEY,
            project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            type        TEXT NOT NULL,
            x           REAL NOT NULL DEFAULT 0,
            y           REAL NOT NULL DEFAULT 0,
            width       REAL NOT NULL DEFAULT 320,
            height      REAL NOT NULL DEFAULT 240,
            z_index     INTEGER NOT NULL DEFAULT 0,
            locked      INTEGER NOT NULL DEFAULT 0,
            collapsed   INTEGER NOT NULL DEFAULT 0,
            color       TEXT,
            title       TEXT,
            data        TEXT NOT NULL DEFAULT '{}',
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_cards_project ON cards(project_id);

        CREATE TABLE IF NOT EXISTS settings (
            key         TEXT PRIMARY KEY,
            value       TEXT NOT NULL
        );

        PRAGMA user_version = 1;
        ",
    )?;

    Ok(())
}

fn migrate_v2(conn: &Connection) -> Result<(), Box<dyn std::error::Error>> {
    tracing::info!("running migration v2: agent sessions");

    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS agent_sessions (
            id          TEXT PRIMARY KEY,
            project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            messages    TEXT NOT NULL DEFAULT '[]',
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_project ON agent_sessions(project_id);

        PRAGMA user_version = 2;
        ",
    )?;

    Ok(())
}
